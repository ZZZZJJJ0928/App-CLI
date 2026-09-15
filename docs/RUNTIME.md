# Runtime adapters and task outcomes

App-CLI 0.2 adds a public, implementation-independent contract for execution runtimes. It shares command validation and task-result semantics while keeping executable selection and any persistent task lifecycle inside a reviewed adapter and its executor. The package has no required runtime service, account, device, or adjacent repository.

## Try the independent reference

After installing App-CLI in a virtual environment:

```sh
app-cli describe calculator-runtime
app-cli schema calculator-runtime multiply
app-cli calculator-runtime multiply --a 6 --b 7
```

The last command starts the self-owned calculator executor and returns:

```json
{"protocol_version":"1.0","ok":true,"app":"calculator-runtime","command":"multiply","data":{"value":42},"task":{"status":"completed"}}
```

The executor runs synchronously without a task database. This validates the runtime protocol and business output; it does not establish external application support or durable workflow behavior. Discovery and schema commands start no subprocesses.

## Explicit registration

Use a reviewed application manifest with `adapter.kind` set to `runtime`, and an absolute executable path with fixed arguments. The following complete example uses only this package:

```python
import sys
from app_cli.adapters.calculator import CalculatorAdapter
from app_cli.adapters.runtime import RuntimeAdapter
from app_cli.core import Registry

manifest = CalculatorAdapter().manifest
manifest.update(id="calculator-runtime", name="Calculator via runtime")
manifest["adapter"] = {"kind": "runtime", "name": "Self-owned calculator runtime"}
adapter = RuntimeAdapter(
    manifest,
    [sys.executable, "-I", "-m", "app_cli.runtime_example"],
    timeout_seconds=30,
)
registry = Registry([adapter])
result = registry.execute_with_metadata("calculator-runtime", "multiply", {"a": 6, "b": 7})
assert result == {"data": {"value": 42}, "task": {"status": "completed"}}
```

There is no CLI option that imports arbitrary adapters or accepts executable paths as business input. A custom runtime must implement the public protocol or provide a reviewed translation layer. Registration validates the manifest but does not probe or launch the executable. `apps` lists registered contracts, not runtime health, granted permissions, candidate research work, or production readiness.

## TaskResult

Any trusted adapter can return a dictionary for synchronous success or an explicit `TaskResult`:

```python
from app_cli.tasks import TaskResult

completed = TaskResult("completed", {"value": 42}, task_id="task-example")
running = TaskResult("running", task_id="task-example")
uncertain = TaskResult("uncertain", task_id="task-example")
```

| Status | Business data | Public task ID | CLI result |
| --- | --- | --- | --- |
| `completed` | Required; validated against the command output schema | Optional | `ok: true`, exit `0`, only if output is valid |
| `pending`, `running` | Absent | Required | `TASK_PENDING` / `TASK_RUNNING`, exit `1` |
| `waiting_confirmation` | Absent | Required | `TASK_WAITING_CONFIRMATION`, exit `1` |
| `uncertain` | Absent | Required | `TASK_UNCERTAIN`, exit `1` |
| `cancelled` | Absent | Required | `TASK_CANCELLED`, exit `1` |
| `failed`, `blocked` | Absent | Optional, allowing rejection before task creation | `TASK_FAILED` / `TASK_BLOCKED`, exit `1` |

Task IDs are opaque public references, 1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`, starting with a letter or digit. They are not authority to access or modify a task. Do not put tokens or sensitive content in them.

An uncertain task becomes a CLI error such as:

```json
{"protocol_version":"1.0","ok":false,"error":{"code":"TASK_UNCERTAIN","message":"The task outcome is uncertain; reconcile it through its execution runtime."},"task":{"status":"uncertain","id":"task-example"}}
```

`Registry.execute()` keeps returning only completed business data and raises `AppCLIError` for incomplete outcomes. `execute_with_metadata()` returns `data` and, for typed outcomes, `task`. Error metadata is available through `AppCLIError.task`. Legacy dictionary adapters retain their original CLI envelope. Backend-reported completion with invalid output returns `OUTPUT_VALIDATION_FAILED`; the original task metadata remains available for investigation, and the CLI still reports failure.

## Wire protocol 1.0

The public [JSON Schema](../schemas/runtime-protocol.schema.json) defines separate request and response objects. One process invocation accepts one UTF-8 JSON request on stdin and emits one JSON response on stdout. Protocol errors, duplicate keys, non-finite values, unknown fields, mismatched app/command identities, and inconsistent task/data combinations are rejected.

Request:

```json
{"protocol_version":"1.0","type":"invoke","app":"calculator-runtime","command":"multiply","arguments":{"a":6,"b":7}}
```

Response:

```json
{"protocol_version":"1.0","type":"result","app":"calculator-runtime","command":"multiply","task":{"status":"completed"},"data":{"value":42}}
```

An incomplete response carries its task status and, where required, ID, and omits `data`. A valid task-level failure uses process exit `0` with status `failed`; process exit codes other than `0` indicate transport failure. Protocol status is the sole task-outcome field: a competing `ok` flag is rejected. The outer App-CLI result is formed only after task and business-output validation.

The adapter checks the exact protocol version. It does not negotiate versions or validate an executor binary's identity. Manifest 1.0, runtime protocol 1.0, CLI output protocol 1.0, and package version 0.2.0 are distinct versions.

## Transport and execution limits

- Fixed executable arguments, `shell=False`, JSON business input on stdin, and discarded child stderr.
- Request limit: 64 KiB before dispatch. Response limit: 1 MiB after capture. The response check does not bound memory used by a misbehaving child.
- Configured subprocess timeout: greater than zero and at most 300 seconds, default 30. Process startup, descendant teardown, and external task deadlines are not covered by a universal deadline guarantee.
- A start failure, timeout, nonzero exit, or malformed reply yields a sanitized error. There is one attempt, with no automatic retry, polling, confirmation, or fallback.
- The adapter and executable are explicitly trusted code. The bundled example uses Python isolated mode; a custom executor needs its own environment, version, and session policy.

The registry and runtime adapter both reject mutation declarations before dispatch. A task result or a confirmation state does not relax this rule. A query that navigates, edits local application state, or starts a state-changing preparation still needs the correct effect classification.

## Next lifecycle contract

Before enabling state-changing workflows, define and validate executor-owned authorization, target serialization, original intent identity, idempotency, persistent attempts, deadlines, cancellation, independent reconciliation, and recovery after response loss. Preserve the original task and intent when inspecting an uncertain outcome; a fresh attempt cannot establish what happened to the previous one.

Validation must distinguish contract tests, actual executor integration, target/version checks, complete user tasks, and production readiness. Replayed observations keep their original time and scope. Shared contracts should have self-contained public fixtures and a clear compatibility policy. These lifecycle requirements remain planned; the current implementation does not claim them.
