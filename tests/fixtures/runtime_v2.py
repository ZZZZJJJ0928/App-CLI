"""Fixed test executable with separately configured synthetic grants and storage."""
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lifecycle_fixture import CounterAdapter, read_grants
from app_cli.core import AppCLIError
from app_cli.lifecycle import ExecutionContext
from app_cli import lifecycle_protocol as wire

request = wire.validate_request(wire.decode(sys.stdin.buffer.read(wire.MAX_REQUEST_BYTES + 1)))
provider = read_grants(Path(sys.argv[2]))
try:
    grant = provider.resolve(request["authorization_ref"])
    result = CounterAdapter(Path(sys.argv[1]), provider).invoke_lifecycle(request, ExecutionContext(request["authorization_ref"], grant, 0))
    if len(sys.argv) > 3 and sys.argv[3] == "lose-response":
        os._exit(7)  # Side effect + ledger committed, response lost.
except AppCLIError as error:
    result = {key: request[key] for key in ("protocol_version", "operation", "app", "command", "request_key") if key in request}
    result.update(kind="error", error={"code": error.code})
sys.stdout.buffer.write(wire.encode(result, wire.MAX_RESPONSE_BYTES))
