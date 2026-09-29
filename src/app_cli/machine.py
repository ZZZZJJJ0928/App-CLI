"""Single-message CLI entry; task outcomes and transport failures stay distinct."""

import sys

from .core import AppCLIError, Registry
from . import lifecycle_protocol as wire


def _write(value):
    raw = wire.encode(value, wire.MAX_RESPONSE_BYTES - 1, code="OUTPUT_VALIDATION_FAILED")
    sys.stdout.write(raw.decode("utf-8") + "\n")
    sys.stdout.flush()


def main(argv, *, registry=None):
    request = None
    try:
        if list(argv) != ["--machine"]:
            raise AppCLIError("INVALID_ARGUMENT", "Use --machine alone with a JSON request on stdin.", 2)
        stream = getattr(sys.stdin, "buffer", sys.stdin)
        raw = stream.read(wire.MAX_REQUEST_BYTES + 1)
        if type(raw) is str:
            try:
                raw = raw.encode("utf-8")
            except UnicodeError:
                raise AppCLIError("INPUT_VALIDATION_FAILED", "The request is not valid UTF-8 JSON.", 2) from None
        request = wire.validate_request(wire.decode(raw))
        if registry is None:
            from .deployment import configured_registry
            registry = configured_registry()
        _write(registry.control(request))
        return 0
    except (KeyboardInterrupt, BrokenPipeError):
        return 130
    except Exception as error:
        if not isinstance(error, AppCLIError):
            error = AppCLIError("INTERNAL_ERROR", "The lifecycle operation could not complete.")
        response = {"protocol_version": wire.VERSION, "kind": "error",
                    "error": {"code": error.code, "message": error.message}}
        if request is not None:
            response.update({key: request[key] for key in ("operation", "app", "command", "request_key") if key in request})
        if error.task is not None:
            response["task"] = error.task
        try:
            _write(response)
        except (BrokenPipeError, KeyboardInterrupt):
            return 130
        return error.exit_code
