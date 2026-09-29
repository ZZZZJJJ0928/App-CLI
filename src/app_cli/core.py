"""Validated dispatch for explicitly trusted, in-process application adapters."""

from collections.abc import Iterable
from importlib.resources import files
import json
from typing import Protocol

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from referencing import Registry as SchemaRegistry

from .tasks import TaskResult


class AppCLIError(Exception):
    """A deliberately public error; native exception text stays inside adapters."""

    def __init__(self, code: str, message: str, exit_code: int = 1, *, task: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code
        if task is not None:
            if type(task) is not dict or "status" not in task or set(task) - {"status", "id"}:
                raise ValueError("Invalid task metadata")
            task = TaskResult(task["status"], {} if task["status"] == "completed" else None,
                              task.get("id")).metadata()
        self.task = task


class Adapter(Protocol):
    manifest: dict

    def invoke(self, command: str, arguments: dict) -> dict | TaskResult: ...


def _json_copy(value, code: str, message: str, exit_code: int = 2):
    """Reject non-JSON Python values and detach data across the adapter boundary."""
    try:
        pending = [value]
        seen = set()
        while pending:
            item = pending.pop()
            if type(item) is dict:
                if id(item) in seen:
                    # Shared references are valid; the serializer detects cycles.
                    continue
                seen.add(id(item))
                if any(type(key) is not str for key in item):
                    raise ValueError()
                pending.extend(item.values())
            elif type(item) is list:
                if id(item) in seen:
                    continue
                seen.add(id(item))
                pending.extend(item)
            elif item is not None and type(item) not in (str, int, float, bool):
                raise ValueError()
        return json.loads(json.dumps(value, allow_nan=False, ensure_ascii=True))
    except (TypeError, ValueError, RecursionError):
        raise AppCLIError(code, message, exit_code) from None


def _schema_validator(schema) -> Draft202012Validator:
    """Only the declared draft and local fragment references are supported."""
    try:
        Draft202012Validator.check_schema(schema)
        pending = [schema]
        while pending:
            node = pending.pop()
            if isinstance(node, dict):
                if "$schema" in node and node["$schema"] != "https://json-schema.org/draft/2020-12/schema":
                    raise ValueError()
                for name in ("$ref", "$dynamicRef"):
                    if name in node and (not isinstance(node[name], str) or not node[name].startswith("#")):
                        raise ValueError()
                # Traverse schema positions only: const, enum, examples and
                # defaults may legitimately contain data named "$ref".
                for name in ("$defs", "definitions", "properties", "patternProperties", "dependentSchemas"):
                    if isinstance(node.get(name), dict):
                        pending.extend(node[name].values())
                for name in ("allOf", "anyOf", "oneOf", "prefixItems"):
                    if isinstance(node.get(name), list):
                        pending.extend(node[name])
                for name in ("additionalProperties", "contains", "contentSchema", "else", "if", "items", "not",
                             "propertyNames", "then", "unevaluatedItems", "unevaluatedProperties"):
                    if name in node:
                        pending.append(node[name])
        # Supplying an empty registry disables jsonschema's legacy network retrieval.
        return Draft202012Validator(schema, registry=SchemaRegistry())
    except (SchemaError, TypeError, ValueError, RecursionError):
        raise AppCLIError("MANIFEST_INVALID", "Command schemas must use valid, local Draft 2020-12 JSON Schema.", 2) from None


class Registry:
    """Explicit registration grants code execution in this process, not a sandbox."""

    def __init__(self, adapters: Iterable[Adapter], *, lifecycle=(), authorization=None, clock=None):
        self._apps = {}
        manifest_schema = json.loads(files("app_cli").joinpath("manifests/app-manifest.schema.json").read_text(encoding="utf-8"))
        manifest_validator = Draft202012Validator(manifest_schema, registry=SchemaRegistry())
        for adapter in adapters:
            try:
                manifest = _json_copy(adapter.manifest, "MANIFEST_INVALID", "Adapter manifest must be JSON.")
            except AppCLIError:
                raise
            except Exception:
                raise AppCLIError("MANIFEST_INVALID", "Adapter manifest could not be read.", 2) from None
            if not manifest_validator.is_valid(manifest):
                raise AppCLIError("MANIFEST_INVALID", "Adapter manifest does not match schema version 1.0.", 2)
            if manifest["id"] in self._apps:
                raise AppCLIError("DUPLICATE_APP", "Application identifiers must be unique.", 2)
            if not callable(getattr(adapter, "invoke", None)):
                raise AppCLIError("MANIFEST_INVALID", "An adapter must provide an invoke method.", 2)
            commands = {}
            for command in manifest["commands"]:
                if command["name"] in commands:
                    raise AppCLIError("MANIFEST_INVALID", "Command names must be unique within an application.", 2)
                commands[command["name"]] = (
                    command,
                    _schema_validator(command["input_schema"]),
                    _schema_validator(command["output_schema"]),
                )
            self._apps[manifest["id"]] = (adapter, manifest, commands)
        # Optional reviewed lifecycle capabilities do not change legacy invoke.
        from .lifecycle import LifecycleDispatcher
        options = {} if clock is None else {"clock": clock}
        self._lifecycle = LifecycleDispatcher(self, lifecycle, authorization, **options)

    def control(self, request: dict) -> dict:
        """Validate and authorize one lifecycle operation without automatic retries."""
        return self._lifecycle.dispatch(request)

    def list_apps(self) -> list[dict]:
        return [{"id": manifest["id"], "name": manifest["name"], "version": manifest["version"],
                 "platforms": list(manifest["platforms"]), "adapter": dict(manifest["adapter"]),
                 "commands": [command["name"] for command in manifest["commands"]]}
                for _, manifest, _ in (self._apps[key] for key in sorted(self._apps))]

    def _app(self, app_id):
        if not isinstance(app_id, str) or app_id not in self._apps:
            raise AppCLIError("APP_NOT_FOUND", "Application is not registered.", 2)
        return self._apps[app_id]

    def describe(self, app_id: str) -> dict:
        return _json_copy(self._app(app_id)[1], "MANIFEST_INVALID", "Registered manifest is unavailable.")

    def execute(self, app_id: str, command: str, args: dict) -> dict:
        """Return completed business data; incomplete tasks raise AppCLIError."""
        return self.execute_with_metadata(app_id, command, args)["data"]

    def execute_with_metadata(self, app_id: str, command: str, args: dict) -> dict:
        """Preserve task metadata while retaining the legacy execute API."""
        adapter, _, commands = self._app(app_id)
        if not isinstance(command, str) or command not in commands:
            raise AppCLIError("COMMAND_NOT_FOUND", "Application command is not registered.", 2)
        spec, input_validator, output_validator = commands[command]
        if spec["side_effect"] != "read_only":
            raise AppCLIError("CAPABILITY_NOT_SUPPORTED", "App-CLI does not execute mutation commands.")
        arguments = _json_copy(args, "INPUT_VALIDATION_FAILED", "Arguments must be a JSON object matching the command schema.")
        self._validate(arguments, input_validator, "INPUT_VALIDATION_FAILED", "Arguments do not match the command schema.")
        try:
            output = adapter.invoke(command, arguments)
        except AppCLIError:
            raise
        except Exception:
            raise AppCLIError("ADAPTER_EXECUTION_FAILED", "Application adapter could not complete the command.") from None
        task = None
        if isinstance(output, TaskResult):
            task = output.metadata()
            if output.status != "completed":
                messages = {
                    "pending": "The task is pending.",
                    "running": "The task is still running.",
                    "waiting_confirmation": "The task requires confirmation through its execution runtime.",
                    "uncertain": "The task outcome is uncertain; reconcile it through its execution runtime.",
                    "failed": "The execution runtime reported a failed task.",
                    "cancelled": "The task was cancelled.",
                    "blocked": "The execution runtime blocked the task.",
                }
                raise AppCLIError("TASK_" + output.status.upper(), messages[output.status], task=task)
            output = output.data
        try:
            result = _json_copy(output, "OUTPUT_VALIDATION_FAILED", "Adapter output must be a JSON object matching the command schema.", 1)
            self._validate(result, output_validator, "OUTPUT_VALIDATION_FAILED", "Adapter output does not match the command schema.")
        except AppCLIError as error:
            error.task = task
            raise
        return {"data": result, **({"task": task} if task is not None else {})}

    @staticmethod
    def _validate(value, validator, code, message):
        try:
            valid = isinstance(value, dict) and validator.is_valid(value)
        except Exception:
            valid = False
        if not valid:
            raise AppCLIError(code, message, 2 if code == "INPUT_VALIDATION_FAILED" else 1)
