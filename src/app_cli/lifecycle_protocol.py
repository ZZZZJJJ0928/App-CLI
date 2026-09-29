"""Bounded, interoperable lifecycle messages; no runtime or application imports."""

from functools import lru_cache
import hashlib
from importlib.resources import files
import json
import math
import struct

from .core import AppCLIError, _schema_validator

VERSION = "2.0"
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_ARGUMENT_BYTES = 1536 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_SAFE_INTEGER = 9007199254740991


@lru_cache(maxsize=1)
def _schema():
    return json.loads(files("app_cli").joinpath("manifests/lifecycle-v2.schema.json").read_text(encoding="utf-8"))


OPERATIONS = frozenset(variant["properties"]["operation"]["const"]
                       for variant in _schema()["$defs"]["request"]["oneOf"])
EXECUTION_OPERATIONS = frozenset({"invoke", "resume", "renew", "reconcile"})
BASE_OPERATIONS = OPERATIONS - {"renew", "events"}


def canonical_bytes(value, depth=0):
    """Typed framing makes digests independent of each language's float formatter."""
    if depth > 64:
        raise ValueError("JSON nesting limit")
    if value is None:
        tag, payload = b"n", b""
    elif type(value) is bool:
        tag, payload = b"b", b"1" if value else b"0"
    elif type(value) in (int, float):
        number = float(value)
        if not math.isfinite(number) or (number.is_integer() and abs(number) > MAX_SAFE_INTEGER):
            raise ValueError("Number outside interoperable range")
        tag, payload = b"d", struct.pack(">d", 0.0 if number == 0 else number)
    elif type(value) is str:
        tag, payload = b"s", value.encode("utf-8", errors="strict")
    elif type(value) is list:
        tag, payload = b"a", b"".join(canonical_bytes(item, depth + 1) for item in value)
    elif type(value) is dict and all(type(key) is str for key in value):
        keys = sorted(value, key=lambda key: key.encode("utf-8", errors="strict"))
        tag, payload = b"o", b"".join(canonical_bytes(key, depth + 1) + canonical_bytes(value[key], depth + 1)
                                      for key in keys)
    else:
        raise ValueError("Non-JSON value")
    return tag + str(len(payload)).encode("ascii") + b":" + payload


def digest(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def intent_digest(request):
    return digest({key: request[key] for key in ("app", "command", "request_key", "arguments", "deadline_ms")
                   if key in request})


def encode(value, limit=MAX_REQUEST_BYTES, *, code="INPUT_VALIDATION_FAILED"):
    try:
        canonical_bytes(value)
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(raw) > limit:
            raise ValueError("Message limit")
        return raw
    except (ValueError, TypeError, OverflowError, UnicodeError, RecursionError):
        raise AppCLIError(code, "The lifecycle message is not valid bounded JSON.",
                          2 if code == "INPUT_VALIDATION_FAILED" else 1) from None


def decode(raw, limit=MAX_REQUEST_BYTES, *, code="INPUT_VALIDATION_FAILED"):
    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result

    def reject(_):
        raise ValueError("Non-finite number")

    def number(token):
        value = float(token)
        return int(value) if value.is_integer() and abs(value) <= MAX_SAFE_INTEGER else value

    try:
        if type(raw) is not bytes or len(raw) > limit:
            raise ValueError("Message limit")
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=reject, parse_float=number)
        canonical_bytes(value)
        return value
    except (ValueError, TypeError, OverflowError, UnicodeError, RecursionError):
        raise AppCLIError(code, "The lifecycle message is not valid bounded JSON.",
                          2 if code == "INPUT_VALIDATION_FAILED" else 1) from None


@lru_cache(maxsize=2)
def validator(kind):
    schema = _schema()
    return _schema_validator({"$ref": "#/$defs/" + kind, "$defs": schema["$defs"]})


def validate_request(value):
    value = decode(encode(value))
    if not validator("request").is_valid(value):
        raise AppCLIError("INPUT_VALIDATION_FAILED", "The request does not match lifecycle protocol 2.0.", 2)
    if value["operation"] == "invoke":
        encode(value["arguments"], MAX_ARGUMENT_BYTES)
    return value


def validate_response(request, value):
    value = decode(encode(value, MAX_RESPONSE_BYTES, code="BACKEND_PROTOCOL_INVALID"),
                   MAX_RESPONSE_BYTES, code="BACKEND_PROTOCOL_INVALID")
    valid = validator("response").is_valid(value)
    valid = valid and all(value.get(key) == request[key] for key in ("protocol_version", "operation", "app", "command"))
    if "request_key" in request:
        valid = valid and value.get("request_key") == request["request_key"]
    kinds = {"lookup": {"lookup", "task"}, "cancel": {"ack"}, "events": {"events"}}
    valid = valid and value.get("kind") in (kinds.get(request["operation"], {"task"}) | {"error"})
    if "task_id" in request and (value.get("kind") != "error" or "task" in value):
        valid = valid and value.get("task", {}).get("id") == request["task_id"]
    if value.get("kind") == "ack":
        # An ACK carries current metadata, not a successful business result.
        valid = valid and "data" not in value
    if value.get("kind") == "events" and valid:
        sequence = [event["sequence"] for event in value["events"]]
        valid = (len(sequence) <= request.get("limit", 100)
                 and value["cursor"] >= request["cursor"]
                 and all(left < right for left, right in zip([request["cursor"], *sequence], sequence))
                 and (not sequence or sequence[-1] <= value["cursor"]))
    if not valid:
        raise AppCLIError("BACKEND_PROTOCOL_INVALID", "The backend returned an invalid lifecycle result.")
    return value
