"""A fixed, self-owned CLI backend demonstrating a real subprocess boundary."""

import json
import subprocess
import sys

from ..core import AppCLIError
from .calculator import CalculatorAdapter, validate_calculation


TIMEOUT_SECONDS = 10
MAX_RESPONSE_BYTES = 4096


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def _reject_constant(value):
    raise ValueError()


def _result(stdout: bytes, command: str) -> dict:
    try:
        if len(stdout) > MAX_RESPONSE_BYTES:
            raise ValueError()
        payload = json.loads(stdout.decode("utf-8"), object_pairs_hook=_unique_object,
                             parse_constant=_reject_constant)
        json.dumps(payload, allow_nan=False)
        if (not isinstance(payload, dict)
                or set(payload) != {"protocol_version", "ok", "app", "command", "data"}
                or payload["protocol_version"] != "1.0"
                or payload["ok"] is not True
                or payload["app"] != "calculator"
                or payload["command"] != command
                or not isinstance(payload["data"], dict)):
            raise ValueError()
        return payload["data"]
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise AppCLIError("BACKEND_PROTOCOL_INVALID", "Calculator CLI returned an invalid response.") from None


class CalculatorCLIAdapter:
    def __init__(self):
        # Reuse the business contract, while explicitly selecting a different
        # implementation. Registration and discovery never start the child.
        self.manifest = CalculatorAdapter().manifest
        self.manifest.update(id="calculator-cli", name="Calculator via CLI")
        self.manifest["adapter"] = {"kind": "cli", "name": "Self-owned calculator subprocess"}

    def invoke(self, command: str, arguments: dict) -> dict:
        if not isinstance(arguments, dict) or set(arguments) != {"a", "b"}:
            raise AppCLIError("INPUT_VALIDATION_FAILED", "Calculator requires exactly the operands a and b.", 2)
        # JSON Schema integers can include 3.0; preserve the application's stricter
        # integer contract before starting any external process.
        validate_calculation(command, arguments["a"], arguments["b"])
        # -I ignores Python environment overrides and imports from the current
        # directory. App-CLI must be installed in this interpreter's environment.
        argv = [sys.executable, "-I", "-m", "app_cli", "calculator", command,
                "--input", json.dumps(arguments, allow_nan=False)]
        try:
            completed = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, shell=False, check=False,
                                       timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            raise AppCLIError("BACKEND_TIMEOUT", "Calculator CLI did not finish within its execution timeout.") from None
        except OSError:
            raise AppCLIError("BACKEND_UNAVAILABLE", "Calculator CLI could not be started.") from None
        if completed.returncode != 0:
            raise AppCLIError("BACKEND_EXECUTION_FAILED", "Calculator CLI could not complete the command.")
        # This trusted child emits a small result. The size check is a protocol
        # check after capture, not a streaming memory limit for arbitrary tools.
        # Registry validates the returned business data against the output schema.
        return _result(completed.stdout, command)
