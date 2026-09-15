# App-CLI

**Application capabilities, expressed as commands for agents.**

[简体中文](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Technical options (中文)](docs/TECHNICAL-OPTIONS.md) · [Build an adapter](docs/ADAPTER-DEVELOPMENT.md) · [Roadmap](docs/ROADMAP.md)

App-CLI turns verified application behavior into versioned commands with business parameters and structured results. Developers analyze and maintain an application adapter; agents repeatedly call the resulting capabilities without navigating its GUI.

The project is independent of any device runtime. Its intended scope includes Windows, macOS, Linux, Android, and iOS applications. Adapters may use application APIs and SDKs, existing CLIs, IPC and scripting, browser automation, accessibility, UI test drivers, instrumentation, supported files, vision, or an existing execution runtime. Each adapter must establish its own supported versions, prerequisites, and evidence of completion. Some access methods need an interactive desktop or device session internally.

An internal function call is a useful starting point. Reliable commands also need the right application state, thread, session, authorization, and verified outcome. App-CLI does not automatically convert every GUI application, and a returned value alone does not prove a remote transaction completed.

## Status: 0.2 runtime contracts

This repository provides an installable CLI, a manifest contract, an explicitly registered adapter interface, JSON Schema validation, and task outcome handling. A self-owned calculator demonstrates native functions, an existing CLI, and the generic runtime protocol. An optional GUI uses the same functions. All examples and tests run independently from this repository.

| Area | Current state |
| --- | --- |
| CLI discovery, named arguments, JSON input/output | Implemented |
| Manifest and command validation | Implemented; Draft 2020-12 with local schema references |
| Manifest access methods | Schema 1.0 declares 13 kinds |
| Calculator `add`, `subtract`, `multiply` | Implemented; no network, account, or device access |
| `calculator-cli` subprocess backend | Implemented; fixed executable, execution timeout, validated response |
| Optional calculator GUI | Source example; requires Tk, not needed by the CLI |
| Windows/macOS/Linux portability | Intended; local verification is recorded separately from configured CI |
| Android/iOS or third-party desktop adapters | Not implemented in this starter |
| Application API, IPC, scripting, browser, UI, instrumentation, file and vision integrations | Planned target-adapter work; recognized kinds do not install implementations |
| Generic `RuntimeAdapter` and `TaskResult` | Implemented; explicit subprocess protocol and task outcomes |
| MCP server, automatic backend selection | Planned integration work |
| Mutations, transactions, durable tasks, approvals | Not implemented; mutation commands are rejected before dispatch |

Current releases establish reusable contracts and independent reference implementations. They do not claim production application coverage.

## Try it locally

Use Python 3.11 or newer from the repository directory:

```sh
python -m venv .venv
# Activate the environment using your shell's standard command.
python -m pip install -e ".[dev]"

app-cli apps
app-cli describe calculator
app-cli schema calculator add
app-cli calculator add --a 2 --b 3
app-cli calculator multiply --input '{"a":6,"b":7}'
app-cli calculator-cli multiply --a 6 --b 7
app-cli calculator-runtime multiply --a 6 --b 7
```

For POSIX shells, activation is `. .venv/bin/activate`; in PowerShell, use `.venv\Scripts\Activate.ps1`. Named parameters avoid shell differences in JSON quoting. You can also run `python -m app_cli`.

The addition command returns:

```json
{"protocol_version":"1.0","ok":true,"app":"calculator","command":"add","data":{"value":5}}
```

`--input` accepts a complete JSON argument object and cannot be combined with named parameters. The calculator accepts integers from -1,000,000 through 1,000,000. Use `app-cli calculator add --help` for command help and `schema` for its complete contract.

Commands emit one JSON object on stdout. Errors carry a stable `error.code` and a public message, without native exception text. Exit codes are `0` for success, `2` for invalid arguments or manifests, `1` for execution/unsupported capabilities, and `130` for interruption or an interrupted output stream. Help and version output are plain text.

To inspect the self-owned GUI example, separately run:

```sh
python examples/calculator/gui.py
```

This optional example illustrates shared application functions. It does not demonstrate attaching to a third-party process or extracting an undocumented API.

`calculator-cli` wraps this package's native calculator command in a separate Python process and returns the same business data. It requires App-CLI to be installed in the active interpreter's environment, as in the virtual environment above. It demonstrates a CLI transport, not coverage of an external application; see the [subprocess reference](docs/ADAPTER-DEVELOPMENT.md#cli-subprocess-reference).

`calculator-runtime` uses the [runtime protocol](docs/RUNTIME.md). Its successful output also carries `"task":{"status":"completed"}`. Runtime-backed adapters can report pending, running, waiting-for-confirmation, uncertain, failed, cancelled, or blocked tasks. Those outcomes return `ok: false` and exit `1`, preserving a public task ID when supplied. Only completed tasks with valid business output return success. The reference is synchronous and stateless; durable execution and mutation coordination remain future work.

## Choose an access method

Start by investigating the application's supported API/SDK, CLI, IPC, or scripting contract. Where those do not cover the business capability, evaluate browser or accessibility semantics, platform test drivers, instrumentation, and visual methods against the same completion criteria. This is a project selection guideline, not a claim that any route works for every application.

Keep the caller platform, execution host, target platform, application version, and session requirements separate. A common business command may use different implementations on different platforms. The [technical options guide](docs/TECHNICAL-OPTIONS.md) compares concrete tools, prerequisites, tradeoffs, and small experiments with official sources. The current registry selects explicitly registered adapters and does not automatically switch backends after a failure.

## Command design

Application analysis should produce commands such as search, inspect, quote, or export with meaningful parameters. Implementation details such as class names, UI resource identifiers, and script source belong inside reviewed adapters.

## Develop and contribute

```sh
python -W error::ResourceWarning -m unittest discover -s tests -v
python scripts/check_public_tree.py
python -m build
```

The GitHub Actions workflow configures Ubuntu, Windows, and macOS with Python 3.11 and 3.13. Configuring a matrix is not evidence that its jobs have run. See [local validation](docs/VALIDATION.md) for checks actually performed.

Start with [CONTRIBUTING](CONTRIBUTING.md) and the [adapter guide](docs/ADAPTER-DEVELOPMENT.md). A useful contribution includes a bounded application capability, exact compatibility assumptions, preconditions, completion evidence, and failure tests. New adapters are explicitly reviewed and registered; installing this package does not discover or execute arbitrary third-party plugins.

Adapters are trusted code running in the CLI process, not a sandbox. Use applications and capabilities you are authorized to access. Keep account data, tokens, raw captures, and proprietary binaries outside the public tree. See [SECURITY](SECURITY.md) for reporting and disclosure guidance.

## License

[MIT](LICENSE), copyright App-CLI contributors. Third-party applications, instrumentation tools, and dependencies retain their own licenses and access requirements.
