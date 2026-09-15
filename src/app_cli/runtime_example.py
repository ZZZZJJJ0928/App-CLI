"""A self-owned runtime protocol example: synchronous, stateless arithmetic."""

import json
import sys

from .adapters.calculator import calculate
from .runtime_protocol import MAX_REQUEST_BYTES, decode, validator


def main():
    try:
        request = decode(sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1), MAX_REQUEST_BYTES)
        if not validator("request").is_valid(request) or request["app"] != "calculator-runtime":
            raise ValueError()
        arguments = request["arguments"]
        if set(arguments) != {"a", "b"}:
            raise ValueError()
        data = {"value": calculate(request["command"], arguments["a"], arguments["b"])}
        response = {"protocol_version": "1.0", "type": "result", "app": request["app"],
                    "command": request["command"], "task": {"status": "completed"}, "data": data}
        print(json.dumps(response, allow_nan=False, separators=(",", ":")), flush=True)
        return 0
    except Exception:
        print('{"error":{"code":"INVALID_REQUEST"}}', flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
