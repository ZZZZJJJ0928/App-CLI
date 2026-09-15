# Roadmap

App-CLI aims to make application capabilities reusable through business commands across desktop and mobile targets. The consumer does not need to navigate the application; execution may still require a desktop, browser, or device session. Delivery is measured by verified commands and their failure behavior, not by the number of platform names or methods discovered.

## 0.1 foundation

The implementation provides a Python 3.11+ package, manifest-driven CLI, explicit trusted adapter registry, Draft 2020-12 input/output validation, and a self-owned calculator with native and CLI-subprocess adapters. An optional Tk example shares the calculator's business function. Manifest 1.0 declares multiple access methods. Only commands declared `read_only` can execute.

Local validation is on macOS. CI configuration covers Ubuntu, Windows, and macOS with Python 3.11 and 3.13; successful runs must be recorded before treating that matrix as verified. Android and iOS adapters, external-app Frida execution, HTTP/MCP services, and plugin distribution are not delivered in this release.

## 0.2 task outcomes and runtime protocol

The shared adapter boundary now accepts typed task outcomes and preserves public task IDs. Completed results still pass business output validation; pending, running, confirmation-waiting, uncertain, failed, cancelled, and blocked outcomes remain unsuccessful CLI results. A generic, explicitly registered subprocess runtime adapter and a self-owned calculator executor demonstrate the protocol. Existing synchronous dictionary results remain compatible. See [runtime integration](RUNTIME.md) and [validation](VALIDATION.md).

This delivery covers contracts and local reference execution. Durable coordination, authorization, target serialization, idempotency, cancellation, reconciliation, and mutation execution need their own implementation and acceptance evidence.

## Delivery sequence

The [technical options guide](TECHNICAL-OPTIONS.md) compares candidate access methods and official platform prerequisites. The following priorities are project decisions, not delivery dates or claims of installed integrations.

| Priority | Work | Acceptance gate |
| --- | --- | --- |
| P0 — delivered foundation | Multiple access kinds and native/CLI/runtime reference paths | Manifest 1.0 validation, task-result consistency, equal business results, and subprocess failure handling; see local validation |
| P1 — runtime lifecycle | Define an executor-owned task lifecycle and explicit status/reconciliation operations | Stable task identity, authorization scope, original intent binding, restart/timeout evidence, and no duplicate side effects; preserve current execution restrictions until validated |
| P1 — supported application interfaces | One real application API/SDK or existing CLI adapter; investigate documented file formats where the contract permits snapshots | Exact supported versions, reproducible read-only results, bounded output, failures, and installation evidence on each claimed host |
| P1 — reproducible preflight design | Define host/target/session checks and a future diagnostics command | Missing dependencies and incompatible versions detectable without business execution; clearly distinguish static inspection from state-changing preparation |
| P2 — platform-native integration | Independent small COM/UIA, Apple scripting/AX, and D-Bus/AT-SPI experiments | A self-owned or permitted target on each platform; session, permission, and interface-change evidence |
| P2 — browser integration | One self-owned Web capability using Playwright or WebDriver; investigate Electron separately | Pinned engine/driver combinations, asynchronous page state, unavailable sessions, and contract-level result checks |
| P3 — mobile integration | Android exported-component or UI Automator route; iOS published-action or XCUITest/WDA route | Real host/target/toolchain combinations, device preparation, session teardown, disconnect and target-upgrade tests |
| P3 — specialized access | Instrumentation and visual approaches for identified interface gaps | Version/ABI or recognition-error evidence plus independent business result validation |
| P4 — shared execution services | Reviewed optional backend packages, remote workers, explicit backend selection, and cancellation | Version negotiation, scoped sessions, dependency isolation, deadline ownership, and documented fallback equivalence |

These workstreams may progress independently once their prerequisites are satisfied. Each new backend should begin with one narrow read-only query on a prepared target. UI launch/navigation and target setup require separate effect accounting; complete state-changing workflows depend on mutation coordination below.

## Reproducible target adapters

Develop a small, permitted reference capability for each new access method and target platform. Start with clear application ownership or supported access and publish sanitized fixtures, exact version constraints, prerequisites, and observed results. Keep business contracts independent of the chosen API, CLI, IPC, browser, UI, instrumentation, or runtime implementation. Third-party backend dependencies should remain optional rather than expanding the core installation with every platform toolchain.

An adapter becomes supported only after its actual target and host combinations pass documented checks. Frida's platform support and a self-owned calculator are insufficient evidence for an unrelated application. Runtime integrations should use the public adapter boundary while keeping the core platform-independent.

The current interface does not yet encode host requirements, session type, target-version ranges, or backend selection. Design these fields with validation and clear enforcement semantics before extending the manifest; do not add unsupported fields to examples. Automatic probing and fallback also need an explicit design rather than a broad exception handler that tries another tool.

## Before enabling mutations

Design and test a coordinator for authorization scope, preconditions, per-target serialization, intent identity, attempt records, deadlines, and independent status reconciliation. Account for a process dying after a remote operation commits but before a reply arrives. Retry policy must distinguish a known failure before an action from an unknown result after submission.

Local and remote mutation commands remain execution-disabled until their lifecycle is reviewable. A declaration, confirmation prompt, or successful RPC cannot establish that a transaction completed exactly once.

## Reliability acceptance

For each proposed command, record correctness and completion within its deadline under normal operation, process restart, network timeout, UI transition, unavailable authorization, platform challenge, and uncertain submission where applicable. Track task completion, user intervention, operator intervention, and duplicate side effects separately. No reliability percentage is claimed without a defined sample and measurement procedure.

Consumers should not need to understand an application's GUI. Ordinary recoverable steps should be handled by the adapter when their effects are known. An unavailable or uncertain result must remain visible as a failure to complete the task; it is not a successful substitute for the requested business outcome.

Future schema evolution, adapter distribution, signing, isolation, and transport integrations need separate designs. These are directions, not existing services or promised dates.
