"""Generic runtime protocol adapter; executable and manifest are operator-owned."""

import math
from pathlib import Path
import subprocess

from ..core import AppCLIError, Registry, _json_copy, _schema_validator
from ..runtime_protocol import MAX_RESPONSE_BYTES, decode, encode_request, validator
from ..tasks import TaskResult


class RuntimeAdapter:
    """Use a reviewed manifest and fixed argv to call a trusted local executor.

    Protocol 1.0 preserves read-only invocation. Explicit protocol 2.0 uses
    Registry lifecycle admission and a bounded transport. Neither path retries,
    polls, grants approval or changes backend selection automatically.
    """

    def __init__(self, manifest, argv, *, timeout_seconds=30, protocol_version="1.0"):
        self.manifest = _json_copy(manifest, "MANIFEST_INVALID", "Runtime manifest must be JSON.")
        Registry([self])  # Validate the same public manifest as other adapters.
        if self.manifest["adapter"]["kind"] != "runtime":
            raise AppCLIError("MANIFEST_INVALID", "Runtime adapters must declare the runtime access kind.", 2)
        if (type(argv) not in (list, tuple) or not argv
                or any(type(arg) is not str or not arg or "\x00" in arg for arg in argv)
                or not Path(argv[0]).is_absolute()):
            raise AppCLIError("MANIFEST_INVALID", "Provide fixed runtime arguments with an absolute executable path.", 2)
        if (type(timeout_seconds) not in (int, float) or not 0 < timeout_seconds <= 300
                or not math.isfinite(timeout_seconds)):
            raise AppCLIError("MANIFEST_INVALID", "Runtime timeout must be greater than zero and at most 300 seconds.", 2)
        if type(protocol_version) is not str or protocol_version not in {"1.0", "2.0"} or (protocol_version == "2.0" and timeout_seconds > 30):
            raise AppCLIError("MANIFEST_INVALID", "Select runtime 1.0 or bounded runtime 2.0 explicitly.", 2)
        self._protocol_version = protocol_version
        # Keep virtualenv interpreter symlinks intact; never resolve them to the
        # base interpreter. argv is supplied during trusted registration only.
        self._argv = tuple(argv)
        self._timeout = timeout_seconds
        self._app_id = self.manifest["id"]
        self._commands = {spec["name"]: (spec["side_effect"], _schema_validator(spec["input_schema"]))
                          for spec in self.manifest["commands"]}
        self._response = validator("response")

    def invoke(self, command, arguments):
        if self._protocol_version != "1.0":
            raise AppCLIError("CAPABILITY_NOT_SUPPORTED", "Runtime 2.0 requires Registry lifecycle admission.")
        if type(command) is not str or command not in self._commands:
            raise AppCLIError("COMMAND_NOT_FOUND", "The runtime command is not registered.", 2)
        effect, inputs = self._commands[command]
        if effect != "read_only":
            raise AppCLIError("CAPABILITY_NOT_SUPPORTED", "Runtime mutation commands are execution-disabled.")
        arguments = _json_copy(arguments, "INPUT_VALIDATION_FAILED", "Runtime arguments must be JSON.")
        Registry._validate(arguments, inputs, "INPUT_VALIDATION_FAILED", "Runtime arguments do not match the command schema.")
        request = encode_request(self._app_id, command, arguments)
        try:
            result = subprocess.run(self._argv, input=request, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, shell=False, check=False,
                                    timeout=self._timeout)
        except subprocess.TimeoutExpired:
            raise AppCLIError("BACKEND_TIMEOUT", "The runtime did not respond within its execution timeout.") from None
        except OSError:
            raise AppCLIError("BACKEND_UNAVAILABLE", "The configured runtime could not be started.") from None
        if result.returncode != 0:
            raise AppCLIError("BACKEND_EXECUTION_FAILED", "The runtime could not complete the request.")
        # Output is bounded at the protocol boundary after capturing the trusted
        # child. This is not a streaming memory limit for arbitrary executables.
        response = decode(result.stdout, MAX_RESPONSE_BYTES)
        if (not self._response.is_valid(response) or response["app"] != self._app_id
                or response["command"] != command):
            raise AppCLIError("BACKEND_PROTOCOL_INVALID", "The runtime returned an incompatible or misattributed response.")
        try:
            return TaskResult(response["task"]["status"], response.get("data"), response["task"].get("id"))
        except ValueError:
            raise AppCLIError("BACKEND_PROTOCOL_INVALID", "The runtime returned an invalid task outcome.") from None

    def invoke_lifecycle(self, request, context):
        from ..lifecycle import ExecutionContext
        from .. import lifecycle_protocol as wire
        from ..runtime_transport import exchange

        if self._protocol_version != wire.VERSION:
            raise AppCLIError("CAPABILITY_NOT_SUPPORTED", "Runtime 1.0 does not support lifecycle operations.")
        request = wire.validate_request(request)
        if (type(context) is not ExecutionContext or context.authorization_ref != request["authorization_ref"]
                or request["app"] != self._app_id or request["command"] not in self._commands
                or context.grant.app != self._app_id or context.grant.command != request["command"]):
            raise AppCLIError("AUTHORIZATION_DENIED", "Runtime admission context does not match the request.")
        # The executor must resolve this reference again; caller context is not a wire grant.
        raw = exchange(self._argv, wire.encode(request), timeout=self._timeout,
                       max_response=wire.MAX_RESPONSE_BYTES)
        return wire.validate_response(request, wire.decode(raw, wire.MAX_RESPONSE_BYTES,
                                                          code="BACKEND_PROTOCOL_INVALID"))
