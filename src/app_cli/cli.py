"""Manifest-driven command parsing; execution belongs to the adapter contract."""

import argparse
import json
import math
import re

from . import __version__
from .adapters import builtin_adapters
from .core import AppCLIError, Registry


PROTOCOL_VERSION = "1.0"
MAX_INPUT_BYTES = 65536


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's message may include arbitrary user input or account values.
        raise AppCLIError("INVALID_ARGUMENT", "Invalid command arguments. Use --help for usage.", 2)


def _strict_json(value):
    def pairs(items):
        result = {}
        for key, item in items:
            if key in result:
                raise ValueError("Duplicate JSON property")
            result[key] = item
        return result

    def reject_constant(value):
        raise ValueError("Non-finite JSON number")

    try:
        if len(value.encode("utf-8")) > MAX_INPUT_BYTES:
            raise ValueError("Input is too large")
        result = json.loads(value, object_pairs_hook=pairs, parse_constant=reject_constant)
        json.dumps(result, allow_nan=False)
        return result
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise argparse.ArgumentTypeError("Expected bounded, finite JSON without duplicate properties") from None


def _number(value):
    number = float(value)
    if not math.isfinite(number):
        raise argparse.ArgumentTypeError("Expected a finite number")
    return number


def _boolean(value):
    if value not in {"true", "false"}:
        raise argparse.ArgumentTypeError("Use true or false")
    return value == "true"


def _command(manifest, name):
    for command in manifest["commands"]:
        if command["name"] == name:
            return command
    raise AppCLIError("COMMAND_NOT_FOUND", "The application does not expose this command.", 2)


def parser(registry):
    root = Parser(prog="app-cli", description="Call versioned application capabilities with business parameters.",
                  allow_abbrev=False)
    root.add_argument("--version", action="version", version=f"app-cli {__version__}")
    commands = root.add_subparsers(dest="_action", required=True, parser_class=Parser)
    commands.add_parser("apps", help="List explicitly registered applications", allow_abbrev=False)
    describe = commands.add_parser("describe", help="Read an application manifest", allow_abbrev=False)
    describe.add_argument("app")
    schema = commands.add_parser("schema", help="Read command input/output schemas", allow_abbrev=False)
    schema.add_argument("app")
    schema.add_argument("command")
    for summary in registry.list_apps():
        app_id = summary["id"]
        if app_id in {"apps", "describe", "schema"}:
            raise AppCLIError("MANIFEST_INVALID", "An application ID conflicts with a CLI discovery command.", 2)
        manifest = registry.describe(app_id)
        app_parser = commands.add_parser(app_id, help=manifest["name"], allow_abbrev=False)
        operations = app_parser.add_subparsers(dest="_command", required=True, parser_class=Parser)
        for command in manifest["commands"]:
            operation = operations.add_parser(command["name"], help=command["description"],
                                              description=command["description"], allow_abbrev=False)
            operation.add_argument("--input", type=_strict_json, default=argparse.SUPPRESS,
                                   help="Complete JSON argument object; cannot be combined with named parameters")
            fields = []
            input_schema = command["input_schema"]
            properties = input_schema.get("properties", {}) if isinstance(input_schema, dict) else {}
            for key, spec in properties.items():
                # Complex/unsafe option names remain available through --input.
                if not re.fullmatch(r"[a-z][a-z0-9-]*", key) or key in {"help", "input"}:
                    continue
                kind = spec.get("type") if isinstance(spec, dict) else None
                converter = {"integer": int, "number": _number, "boolean": _boolean,
                             "string": str, "object": _strict_json, "array": _strict_json}.get(kind) if isinstance(kind, str) else None
                if converter is None:
                    continue
                destination = f"_field_{len(fields)}"
                operation.add_argument(f"--{key}", dest=destination, type=converter,
                                       default=argparse.SUPPRESS, help=spec.get("description", key))
                fields.append((key, destination))
            operation.set_defaults(_fields=fields)
    return root


def _write(value):
    print(json.dumps({"protocol_version": PROTOCOL_VERSION, **value}, ensure_ascii=False,
                     allow_nan=False, separators=(",", ":")), flush=True)


def main(argv=None, *, registry=None):
    try:
        registry = registry if registry is not None else Registry(builtin_adapters())
        args = parser(registry).parse_args(argv)
        if args._action == "apps":
            _write({"ok": True, "data": {"apps": registry.list_apps()}})
        elif args._action == "describe":
            _write({"ok": True, "data": registry.describe(args.app)})
        elif args._action == "schema":
            command = _command(registry.describe(args.app), args.command)
            _write({"ok": True, "app": args.app, "command": args.command,
                    "data": {key: command[key] for key in ("input_schema", "output_schema", "side_effect")}})
        else:
            arguments = {key: getattr(args, destination) for key, destination in args._fields
                         if hasattr(args, destination)}
            if hasattr(args, "input"):
                if arguments:
                    raise AppCLIError("INVALID_ARGUMENT", "Use either --input or named parameters, not both.", 2)
                arguments = args.input
            result = registry.execute_with_metadata(args._action, args._command, arguments)
            _write({"ok": True, "app": args._action, "command": args._command, **result})
        return 0
    except AppCLIError as error:
        _write({"ok": False, "error": {"code": error.code, "message": error.message},
                **({"task": error.task} if error.task is not None else {})})
        return error.exit_code
    except (KeyboardInterrupt, BrokenPipeError):
        return 130
    except Exception:
        _write({"ok": False, "error": {"code": "INTERNAL_ERROR", "message": "The command could not complete."}})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
