# Adapter development

Start with one permitted, reproducible business capability. State which application and versions you have tested, what inputs mean, and what independently establishes the result. Follow the [contribution evidence template](../CONTRIBUTING.md#adapter-evidence-template) before expanding the command surface.

Use the [technical options matrix](TECHNICAL-OPTIONS.md) to compare application APIs, CLIs, IPC, scripting, browser and UI interfaces, test drivers, instrumentation, files, and vision. Choose based on business coverage and verifiable outcomes, then document the host, target, and session conditions. Tool popularity or a supported platform name is insufficient evidence.

## Interface and explicit registration

An adapter implements the `Adapter` protocol in `app_cli.core`:

```python
class ExampleAdapter:
    manifest: dict

    def invoke(self, command: str, arguments: dict) -> dict:
        ...
```

The command schemas describe JSON data. Inputs and outputs must be JSON objects, even when their schema is a boolean schema. Non-finite numbers and non-JSON Python values are rejected. Return business data from `invoke()`; the CLI adds the protocol envelope.

For an embedded integration, construct `Registry([reviewed_adapter])` explicitly and use `list_apps()`, `describe(app_id)`, and `execute(app_id, command, arguments)`. To contribute a built-in adapter, add reviewed source and update the explicit list in `src/app_cli/adapters/__init__.py`. The CLI does not accept arbitrary module paths or fetch plugins. Treat registration as trusting Python code with the process's privileges.

The native reference is [`CalculatorAdapter`](../src/app_cli/adapters/calculator.py). Its public `calculate(operation, a, b)` function is also used by [`examples/calculator/gui.py`](../examples/calculator/gui.py). The GUI is optional and requires a Python installation with Tk support. [`CalculatorCLIAdapter`](../src/app_cli/adapters/calculator_cli.py) demonstrates the same contract over a real CLI subprocess.

## Manifest contract

The public contract is [`schemas/app-manifest.schema.json`](../schemas/app-manifest.schema.json). The packaged copy in `src/app_cli/manifests/` must remain identical. The following complete minimal manifest illustrates a single calculator command; the bundled calculator also declares subtraction and multiplication.

All adapters use Manifest `1.0`. The accepted access kinds are `native-api`, `http-api`, `cli`, `ipc`, `scripting`, `browser`, `accessibility`, `ui-test`, `instrumentation`, `frida`, `file`, `vision`, and `runtime`. The schema rejects unknown kinds and versions. `frida` is a tool-specific declaration; `instrumentation` describes the broader access method.

Manifest version, adapter release `version`, and CLI output `protocol_version` are separate. The CLI output protocol version is `1.0`. Kinds describe the primary access method; no library is automatically imported or installed based on that field.

```json
{
  "schema_version": "1.0",
  "id": "calculator",
  "name": "Calculator",
  "version": "0.1.0",
  "platforms": ["windows", "macos", "linux"],
  "adapter": {"kind": "native-api", "name": "Local calculator"},
  "commands": [
    {
      "name": "add",
      "description": "Add two integers.",
      "input_schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": false,
        "required": ["a", "b"],
        "properties": {
          "a": {"type": "integer", "minimum": -1000000, "maximum": 1000000},
          "b": {"type": "integer", "minimum": -1000000, "maximum": 1000000}
        }
      },
      "output_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["value"],
        "properties": {"value": {"type": "integer"}}
      },
      "side_effect": "read_only"
    }
  ]
}
```

Application and command identifiers use lowercase letters, digits, and separated `.`, `_`, or `-` segments. Application identifiers must also avoid the CLI's reserved discovery names `apps`, `describe`, and `schema`. The manifest, adapter descriptor, and command descriptor reject unknown fields. `version` identifies the published capability/adapter contract release, not the installed target application version. There is no target-version enforcement field: an external adapter must document and enforce its supported target versions in its own implementation until that contract is extended. `platforms` lists target operating systems; separately document execution host, browser engine or device tooling, session state, and permissions. The core does not check the current platform against this metadata.

Command schemas are validated as Draft 2020-12. Use only local fragment references such as `#/$defs/operand`; network and filesystem references are unsupported. A schema identifies acceptable data, not permission to perform an operation.

`side_effect` accepts `read_only`, `local_mutation`, or `remote_mutation`. Version 0.1 registers all three declarations but executes only `read_only`. Mutation attempts fail with `CAPABILITY_NOT_SUPPORTED` before the adapter is invoked. Do not classify navigation, application state changes, or remote writes as read-only to work around this restriction.

## CLI and result contract

After installation, inspect and call the reference adapter:

```sh
app-cli apps
app-cli describe calculator
app-cli schema calculator add
app-cli calculator add --a 2 --b 3
app-cli calculator add --input '{"a":2,"b":3}'
```

The last two commands are alternatives: JSON input and named parameters cannot be combined. The named-parameter example avoids shell-specific JSON quoting. Fields without a supported named option remain available through `--input`.

A successful calculation writes one JSON line:

```json
{"protocol_version":"1.0","ok":true,"app":"calculator","command":"add","data":{"value":5}}
```

Failures write `{"protocol_version":"1.0","ok":false,"error":{"code":"...","message":"..."}}`. Exit status is `0` for success, `2` for invalid input or arguments, `1` for execution failures or unsupported execution, and `130` for interruption. `--help` and `--version` produce ordinary text. Adapters must not print diagnostic output to stdout.

Raise `AppCLIError(code, message, exit_code=1)` for deliberate public failures. Keep its message free of secrets and raw native exception text. The registry converts unexpected adapter exceptions to `ADAPTER_EXECUTION_FAILED`; adapters remain responsible for accurately detecting business failure and uncertainty before returning data.

## CLI subprocess reference

After installing into a virtual environment:

```sh
app-cli describe calculator-cli
app-cli calculator-cli add --a 2 --b 3
app-cli calculator-cli multiply --input '{"a":6,"b":7}'
```

`CalculatorCLIAdapter` derives its manifest from the native calculator contract and changes its ID, display name, and access kind. A fixed argument list executes the current Python interpreter with `-I -m app_cli calculator`; it never recursively invokes `calculator-cli`. Registration and discovery start no processes. Invalid operands and mutation declarations are rejected before launching a child.

The adapter uses `shell=False`, closes child stdin, discards child stderr, and sets a ten-second subprocess execution timeout. Python's isolated mode prevents the current directory and `PYTHONPATH` from substituting the module; install App-CLI in that interpreter's environment, rather than relying on a `PYTHONPATH` checkout or a user-site-only installation. It remains trusted code with process permissions, not an operating-system sandbox. [Python subprocess behavior](https://docs.python.org/3/library/subprocess.html)

The response must be one finite UTF-8 JSON object without duplicate keys and with the expected protocol version, success flag, application, command, and data object. Registry then validates the business result. The 4 KiB response check occurs after capture; this sample's child is self-owned and emits a small result. A general external-tool transport would need streaming output limits, executable/version verification, environment policy, and process-tree cancellation. Process creation may outlast the configured subprocess timeout on some platforms, so this is not a hard end-to-end deadline.

| Error code | Meaning |
| --- | --- |
| `BACKEND_UNAVAILABLE` | The operating system could not start the child |
| `BACKEND_TIMEOUT` | The child exceeded the subprocess execution timeout |
| `BACKEND_EXECUTION_FAILED` | The child exited unsuccessfully, including an unavailable module in its environment |
| `BACKEND_PROTOCOL_INVALID` | The output failed size, JSON, envelope, or command-identity checks |
| `OUTPUT_VALIDATION_FAILED` | A valid envelope contained data that violated the business contract |

These failures use exit code `1` and do not echo native diagnostics. No failure triggers an automatic retry or another access method. The example validates the CLI boundary, not an external application's compatibility.

## Planning another backend

Document preflight conditions, execution behavior, and independent result verification even though the current interface has only `invoke()`. Compare at least the available supported API/CLI/IPC route with the proposed route and explain any business-coverage gap. Keep executable paths, scripts, selectors, tool connection details, and platform method names in reviewed adapter code or trusted configuration; the public command should accept business parameters.

Where a business command has multiple implementations, verify equivalent account scope, data freshness, field meaning, and completion criteria. The registry rejects duplicate application IDs, so select the implementation explicitly before registration or encapsulate a reviewed selection inside one adapter. Automatic fallback, a `--backend` option, and a general environment-diagnostics API are not currently implemented.

UI preparation, navigation, file creation, application launch, and connection setup can have side effects even when the desired final result is a query. State these requirements and effects without relabeling the whole workflow as `read_only`. Treat a remote timeout as potentially uncertain until the target's status can be established.

## Verification before contribution

Test valid results, numeric or domain boundaries, malformed input, output-contract failure, and the command's actual failure behavior. For the calculator, boolean operands are not integers and operands outside ±1,000,000 are invalid. For an external application, include version rejection, unavailable sessions, interrupted transitions, and independent postcondition checks where relevant.

For an instrumentation adapter, record the exact method and signature, tool and target versions, required access, owning thread, state prerequisites, and observed completion signal. For UI/vision adapters, record locator or recognition ambiguity, session conditions, and independent result checks. Bound observations and retain only data needed by the command. A mock proves local contract behavior; it does not replace a permitted target-app test. See the [technical options](TECHNICAL-OPTIONS.md) for official platform sources and minimum experiments.
