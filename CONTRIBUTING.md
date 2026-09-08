# Contributing

Help turn a concrete application capability into a reviewed, reusable business command. App-CLI is intended for headless scripts and agents; developer tools may use a GUI when maintaining adapters. Contributions should distinguish observed behavior from hypotheses and platform goals from tested support.

## Local development

Use Python 3.11 or newer in a virtual environment. From the repository root:

```sh
python -m pip install -e ".[dev]"
python -W error::ResourceWarning -m unittest discover -s tests -v
python scripts/check_public_tree.py
python -m build
app-cli calculator add --a 2 --b 3
```

Report the operating system, Python version, and commands actually run. The configured CI matrix does not establish a passing result until it runs. The optional calculator GUI requires Tk and is not needed for the core tests.

For code changes, keep the core independent of any one operating system or downstream runtime. Add meaningful tests for contract or behavior changes, preserve the packaged/public manifest schema match, and update documentation when the command interface changes. Review [architecture](docs/ARCHITECTURE.md) and [adapter development](docs/ADAPTER-DEVELOPMENT.md) before adding an adapter.

## Adapter evidence template

Include this information in an adapter proposal or pull request:

| Field | Required detail |
| --- | --- |
| Source and version | Application owner/source, exact target version, applicable public artifact hash, host and target platform; no device identifiers |
| Business command | Command name, bounded example input, expected structured output, and who is permitted to invoke it |
| Access method | Primary kind from the technical options matrix, exact tool/interface version, prerequisites, and why it fits the business capability |
| Execution environment | Caller platform, execution host, target platform, desktop/device/browser session requirements, and setup effects |
| Alternative implementations | Available API/CLI/IPC routes, relevant coverage gaps, and equivalence criteria if multiple backends are proposed |
| Preconditions | Required session, application state, version checks, thread or event loop, and authorization |
| Postconditions | Independent evidence that the business result occurred; asynchronous completion criteria |
| Data boundary | Data read, returned, stored, and redacted; sanitized fixture provenance |
| Effects and failures | Read/local/remote effects, failure before action versus uncertain outcome, and safe recovery limits |
| Reproduction | Minimal steps, tests run, actual observations, counterexamples, and remaining unverified claims |

Use business inputs such as operands or a document identifier rather than arbitrary shell commands, selectors, or method names. Version 0.1 accepts mutation declarations but refuses their execution. Do not relabel a write to bypass this policy.

Consult the [technical options](docs/TECHNICAL-OPTIONS.md) and [Manifest contract](docs/ADAPTER-DEVELOPMENT.md#manifest-contract). All access kinds use schema `1.0`. Tool integrations must be optional and explicitly registered. A kind name or dependency installation must not be presented as verified application support.

Contribute synthetic or carefully sanitized fixtures. Keep tokens, account information, private UI captures, login sessions, device identifiers, private paths, keys, and unlicensed application binaries out of issues and pull requests. Research observations should be summarized with reproducible provenance; private evidence does not belong in this public repository. Do not contribute mechanisms for hiding privileged access or bypassing platform authorization and verification controls.

Describe the problem, resulting behavior, validation, and material limitations in the pull request. Contributions must be compatible with the repository's MIT license, while preserving applicable third-party notices. Report security-sensitive findings through the process in [SECURITY.md](SECURITY.md), without publishing the sensitive payload.
