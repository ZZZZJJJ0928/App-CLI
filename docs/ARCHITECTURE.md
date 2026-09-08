# Architecture

App-CLI exposes reviewed application capabilities as business commands for scripts and agents. A caller supplies business parameters and receives structured results; GUI navigation is not part of the consumer contract. An access backend may still require an interactive desktop or device session. Developers record those requirements when maintaining adapters and investigating failures.

## Core and adapters

The execution path is:

```text
CLI arguments → manifest and input validation → trusted Registry
             → application adapter → output validation → JSON result
```

The Python 3.11+ core owns discovery, contract validation, dispatch, and CLI output. An adapter owns the application-specific implementation and evidence that its result meets the command's business contract. The core has no dependency on a specific target platform, instrumentation tool, or execution runtime.

## Access methods

Manifest 1.0 declares the following access methods. All kinds use the same adapter interface. A recognized kind is metadata and does not install an implementation, select a driver, or establish support.

| Kind | Intended access method | Implemented in 0.1 foundation |
| --- | --- | --- |
| `native-api` | A reviewed application function or supported API | Local, self-owned calculator |
| `http-api` | An application-provided HTTP service | No target adapter |
| `cli` | An existing application CLI through a fixed subprocess | Self-owned calculator CLI |
| `ipc` | An exposed application interface over COM, D-Bus, Binder, or local RPC | No target adapter |
| `scripting` | An application scripting interface or system action | No target adapter |
| `browser` | Browser DOM and supported browser control protocols | No target adapter |
| `accessibility` | Platform accessibility interfaces | No target adapter |
| `ui-test` | Platform UI test frameworks and drivers | No target adapter |
| `instrumentation` | Reviewed runtime instrumentation or debugging interfaces | No target adapter |
| `frida` | Frida-specific instrumentation | No target adapter |
| `file` | Supported document formats, exports, or consistent snapshots | No target adapter |
| `vision` | Image/text recognition with independently verified outcomes | No target adapter |
| `runtime` | An integration with an existing execution runtime | No runtime integration |

The [technical options guide](TECHNICAL-OPTIONS.md) maps these kinds to concrete platform technologies and official sources. Frida is one possible instrumentation tool. The shared contract is at the business boundary; underlying platform APIs need not be identical.

`Registry(adapters)` accepts an explicit collection of trusted adapter objects. It validates and retains a detached manifest snapshot, rejects duplicate application and command identifiers, and validates JSON inputs and outputs. Command schemas use Draft 2020-12 and local fragment references; schema retrieval over the network is disabled. There is no automatic plugin scan, CLI path import, or adapter download.

Registration grants in-process code execution. It is not a sandbox or an assertion that an application vendor permits a particular operation. In 0.1, the registry rejects commands declared `local_mutation` or `remote_mutation` before invocation. A `read_only` declaration still requires implementation review: the registry cannot make arbitrary Python code read-only.

## Business behavior needs evidence

A GUI handler or internal method is a useful lead when developing an adapter. Turning it into a reliable command also requires verifying the exact application version, call signature, thread or event loop, session prerequisites, authorization, server behavior, side effects, and asynchronous completion conditions. A successful function return or instrumentation RPC is insufficient evidence that a business task completed.

Adapters should return the smallest useful business result and report incomplete or uncertain outcomes accurately. Instrumentation, application launch, and navigation can themselves change local state; describe these effects instead of relabeling them to fit the initial execution policy. Mutation coordination, durable tasks, authorization workflows, and reconciliation are future work.

The reference calculator exposes `add`, `subtract`, and `multiply`. Its optional Tk GUI calls the same `calculate()` business function as the CLI adapter. This demonstrates two entry points into an application we own. It does not demonstrate Frida control of an external GUI application.

The `calculator-cli` adapter exposes the same business operations by executing a fixed `python -I -m app_cli calculator ...` child. It validates operands before starting a process, enforces a ten-second subprocess execution timeout, checks the response envelope and command identity, and passes business output back through registry validation. Its timeout is local to that backend; the core does not enforce universal deadlines or provide process-tree cancellation. The size check occurs after capture and is not an arbitrary-tool memory sandbox. See the [CLI reference](ADAPTER-DEVELOPMENT.md#cli-subprocess-reference).

## Backend composition and selection

Keep three responsibilities distinct when developing new integrations: the application adapter defines business semantics, the access backend implements an API/CLI/UI operation, and a transport carries requests to a local or remote executor. For example, a future iOS command could be called from Linux while a suitable execution host manages its device session. An HTTP or MCP interface to App-CLI would be a consumer transport, separate from an application's `http-api` access method.

Today the public adapter interface consists only of `manifest` and `invoke()`. The registry accepts one adapter per application ID and does not implement backend plugins, automatic selection, environment probing, or fallback. The two calculator IDs deliberately make their implementations separately inspectable. A production adapter can encapsulate platform-specific choices behind one business contract; it must document and validate that choice before invocation.

Future work should add explicit preflight, invocation, and result-verification phases with recorded host/target/session requirements. A fallback must preserve authorization, data source, freshness, and completion semantics. A timeout after a possible mutation requires reconciliation, not another backend executing the same action.

## Platform scope

| Layer | Current evidence and scope |
| --- | --- |
| CLI, registry, and native/subprocess calculators | Local validation on macOS; Windows and Linux are portability targets |
| CI | A Windows/macOS/Ubuntu matrix for Python 3.11 and 3.13 is configured; configuration alone is not a successful cloud run |
| Android and iOS target applications | Adapter kinds and platform names are representable; real target adapters are not implemented |
| Optional calculator GUI | Developer example requiring Tk; launched explicitly and not part of headless execution |

Host operating system, target operating system, target application version, and adapter implementation must be recorded separately when claiming support. There is currently no HTTP service, MCP server, hosted service, or marketplace.

For any support claim, separate caller, execution host, target OS/application, access method, and session requirements. Manifest `platforms` lists target operating systems; it is not a host compatibility matrix or a runtime platform check. Browser access does not add a new `web` operating-system value. Record the actual browser execution platform and engine separately.

Platform sources and limitations are maintained in the [technical options guide](TECHNICAL-OPTIONS.md); checks actually performed are recorded in [validation](VALIDATION.md).
