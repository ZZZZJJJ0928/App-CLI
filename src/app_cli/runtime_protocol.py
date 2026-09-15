"""Bounded JSON messages for the optional, explicitly trusted runtime adapter."""

from importlib.resources import files
import json

from .core import AppCLIError, _json_copy, _schema_validator


MAX_REQUEST_BYTES = 65536
MAX_RESPONSE_BYTES = 1024 * 1024


def validator(kind):
    schema = json.loads(files("app_cli").joinpath("manifests/runtime-protocol.schema.json").read_text(encoding="utf-8"))
    return _schema_validator({"$ref": "#/$defs/" + kind, "$defs": schema["$defs"]})


def decode(raw, limit):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError()
            result[key] = value
        return result

    def reject(_):
        raise ValueError()

    try:
        if not isinstance(raw, bytes) or len(raw) > limit:
            raise ValueError()
        return _json_copy(json.loads(raw.decode("utf-8"), object_pairs_hook=unique, parse_constant=reject),
                          "BACKEND_PROTOCOL_INVALID", "The runtime returned invalid JSON.", 1)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise AppCLIError("BACKEND_PROTOCOL_INVALID", "The runtime returned invalid JSON.") from None


def encode_request(app, command, arguments):
    request = {"protocol_version": "1.0", "type": "invoke", "app": app,
               "command": command, "arguments": arguments}
    if not validator("request").is_valid(request):
        raise AppCLIError("INPUT_VALIDATION_FAILED", "Invalid runtime request.", 2)
    raw = json.dumps(request, allow_nan=False, ensure_ascii=True, separators=(",", ":")).encode()
    if len(raw) > MAX_REQUEST_BYTES:
        raise AppCLIError("INPUT_VALIDATION_FAILED", "The runtime request exceeds its size limit.", 2)
    return raw
