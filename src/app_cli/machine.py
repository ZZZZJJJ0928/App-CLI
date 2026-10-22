"""Machine CLI entry; task outcomes and transport failures stay distinct.

``--machine`` answers one JSON request read to EOF. ``--machine --session``
answers one compact JSON request per line until EOF, verifying the release and
building the Registry once. Each line is handled exactly like a one-shot call.
"""

import sys

from .core import AppCLIError, Registry
from . import lifecycle_protocol as wire

# First line of a session; a caller that does not read it falls back to one-shot.
SESSION_HELLO = {"protocol_version": wire.VERSION, "kind": "session", "session_version": 1}


def _write(value):
    raw = wire.encode(value, wire.MAX_RESPONSE_BYTES - 1, code="OUTPUT_VALIDATION_FAILED")
    sys.stdout.write(raw.decode("utf-8") + "\n")
    sys.stdout.flush()


def _registry(registry):
    if registry is None:
        from .deployment import configured_registry
        registry = configured_registry()
    return registry


def _answer(raw, registry):
    """Answer one encoded request; returns the process exit code it implies."""
    request = None
    try:
        if type(raw) is str:
            try:
                raw = raw.encode("utf-8")
            except UnicodeError:
                raise AppCLIError("INPUT_VALIDATION_FAILED", "The request is not valid UTF-8 JSON.", 2) from None
        request = wire.validate_request(wire.decode(raw))
        registry = _registry(registry)
        _write(registry.control(request))
        return 0
    except Exception as error:
        return _error(error, request)


def _error(error, request=None):
    if not isinstance(error, AppCLIError):
        error = AppCLIError("INTERNAL_ERROR", "The lifecycle operation could not complete.")
    response = {"protocol_version": wire.VERSION, "kind": "error",
                "error": {"code": error.code, "message": error.message}}
    if request is not None:
        response.update({key: request[key] for key in ("operation", "app", "command", "request_key") if key in request})
    if error.task is not None:
        response["task"] = error.task
    _write(response)
    return error.exit_code


def _session(stream, registry):
    try:
        registry = _registry(registry)
    except Exception as error:
        return _error(error)
    _write(SESSION_HELLO)
    while True:
        line = stream.readline(wire.MAX_REQUEST_BYTES + 2)
        if not line:
            return 0
        if not line.endswith(b"\n" if type(line) is bytes else "\n"):
            # An unterminated line is either EOF mid-request or an oversized
            # frame; neither can be resynchronized, so end the session.
            _error(AppCLIError("INPUT_VALIDATION_FAILED", "The request is not valid bounded JSON.", 2))
            return 2
        _answer(line[:-1], registry)


def main(argv, *, registry=None):
    try:
        arguments = list(argv)
        if arguments not in (["--machine"], ["--machine", "--session"]):
            raise AppCLIError("INVALID_ARGUMENT", "Use --machine (optionally with --session) and JSON on stdin.", 2)
        stream = getattr(sys.stdin, "buffer", sys.stdin)
        if arguments == ["--machine", "--session"]:
            return _session(stream, registry)
        return _answer(stream.read(wire.MAX_REQUEST_BYTES + 1), registry)
    except (KeyboardInterrupt, BrokenPipeError):
        return 130
    except Exception as error:
        try:
            return _error(error)
        except (BrokenPipeError, KeyboardInterrupt):
            return 130
