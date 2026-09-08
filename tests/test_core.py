import copy
import json
from pathlib import Path
import unittest

from app_cli.adapters import builtin_adapters
from app_cli.adapters.calculator import CalculatorAdapter, calculate
from app_cli.core import AppCLIError, Registry


class RecordingAdapter:
    def __init__(self):
        self.manifest = CalculatorAdapter().manifest
        self.calls = []
        self.output = {"value": 3}

    def invoke(self, command, arguments):
        self.calls.append((command, copy.deepcopy(arguments)))
        arguments["a"] = 99
        return self.output


class CoreTests(unittest.TestCase):
    def assert_code(self, code, function, *args):
        with self.assertRaises(AppCLIError) as caught:
            function(*args)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_builtin_calls_shared_calculator_method(self):
        registry = Registry(builtin_adapters())
        self.assertEqual(registry.list_apps()[0]["commands"], ["add", "subtract", "multiply"])
        for operation, expected in (("add", 5), ("subtract", 1), ("multiply", 6)):
            with self.subTest(operation=operation):
                self.assertEqual(calculate(operation, 3, 2), expected)
                self.assertEqual(registry.execute("calculator", operation, {"a": 3, "b": 2}), {"value": expected})
        self.assertEqual(registry.execute("calculator", "multiply", {"a": -1000000, "b": 1000000}), {"value": -1000000000000})

    def test_calculator_rejects_boolean_fraction_and_out_of_range(self):
        registry = Registry(builtin_adapters())
        for value in (True, 1.5, 3.0, 1000001, -1000001, "3"):
            with self.subTest(value=value):
                self.assert_code("INPUT_VALIDATION_FAILED", calculate, "add", value, 2)
                self.assert_code("INPUT_VALIDATION_FAILED", registry.execute, "calculator", "add", {"a": value, "b": 2})

    def test_invalid_arguments_are_rejected_before_adapter_execution(self):
        adapter = RecordingAdapter()
        registry = Registry([adapter])
        cyclic = {}
        cyclic["a"] = cyclic
        for args in ({"a": 1}, {"a": 1, "b": 2, "extra": True}, {"a": True, "b": 2},
                     {"a": 1, "b": float("nan")}, {1: 2}, {"a": (1,), "b": 2}, [], cyclic):
            with self.subTest(args_type=type(args).__name__):
                self.assert_code("INPUT_VALIDATION_FAILED", registry.execute, "calculator", "add", args)
        self.assertEqual(adapter.calls, [])

    def test_mutation_declarations_are_discoverable_but_never_executed(self):
        for effect in ("local_mutation", "remote_mutation"):
            with self.subTest(effect=effect):
                adapter = RecordingAdapter()
                adapter.manifest["commands"][0]["side_effect"] = effect
                registry = Registry([adapter])
                self.assertEqual(registry.describe("calculator")["commands"][0]["side_effect"], effect)
                self.assert_code("CAPABILITY_NOT_SUPPORTED", registry.execute, "calculator", "add", {"a": 1, "b": 2})
                self.assertEqual(adapter.calls, [])

    def test_unknown_app_command_and_no_implicit_registration(self):
        self.assertEqual(Registry([]).list_apps(), [])
        adapter = RecordingAdapter()
        registry = Registry([adapter])
        self.assert_code("APP_NOT_FOUND", registry.execute, "unregistered", "add", {})
        self.assert_code("APP_NOT_FOUND", registry.describe, [])
        self.assert_code("COMMAND_NOT_FOUND", registry.execute, "calculator", "divide", {})
        self.assert_code("COMMAND_NOT_FOUND", registry.execute, "calculator", [], {})
        self.assertEqual(adapter.calls, [])

    def test_manifest_is_closed_versioned_and_has_unique_commands(self):
        changes = [
            lambda m: m.update(schema_version="2.0"),
            lambda m: m.update(extra=True),
            lambda m: m["adapter"].update(path="arbitrary.py"),
            lambda m: m.update(platforms=["android", "android"]),
            lambda m: m.update(platforms=["unsupported"]),
            lambda m: m["commands"].append(copy.deepcopy(m["commands"][0])),
            lambda m: m["commands"][0].update(side_effect="unknown"),
            lambda m: m["commands"][0].update(input_schema={"type": "unknown"}),
            lambda m: m["commands"][0].update(input_schema={"$ref": "https://example.invalid/schema"}),
            lambda m: m["commands"][0].update(input_schema={"$schema": "http://json-schema.org/draft-07/schema#"}),
        ]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                adapter = RecordingAdapter()
                change(adapter.manifest)
                self.assert_code("MANIFEST_INVALID", Registry, [adapter])
                self.assertEqual(adapter.calls, [])
        self.assert_code("DUPLICATE_APP", Registry, [RecordingAdapter(), RecordingAdapter()])

    def test_manifest_access_methods_are_explicit_and_do_not_execute_on_registration(self):
        kinds = ("native-api", "http-api", "cli", "ipc", "scripting", "browser", "accessibility",
                 "ui-test", "instrumentation", "frida", "file", "vision", "runtime")
        for kind in (*kinds, "unknown"):
            with self.subTest(kind=kind):
                adapter = RecordingAdapter()
                adapter.manifest["adapter"]["kind"] = kind
                if kind in kinds:
                    registry = Registry([adapter])
                    described = registry.describe("calculator")
                    self.assertEqual(described["schema_version"], "1.0")
                    self.assertEqual(described["adapter"]["kind"], kind)
                else:
                    self.assert_code("MANIFEST_INVALID", Registry, [adapter])
                self.assertEqual(adapter.calls, [])

    def test_local_schema_references_are_validated_without_network(self):
        adapter = RecordingAdapter()
        adapter.manifest["commands"][0]["input_schema"] = {
            "type": "object", "properties": {"a": {"$ref": "#/$defs/operand"}, "b": {"$ref": "#/$defs/operand"}},
            "required": ["a", "b"], "additionalProperties": False,
            "$defs": {"operand": {"type": "integer", "minimum": 0}},
            "examples": [{"$ref": "https://example.invalid/ordinary-data"}],
        }
        registry = Registry([adapter])
        self.assert_code("INPUT_VALIDATION_FAILED", registry.execute, "calculator", "add", {"a": -1, "b": 2})
        self.assertEqual(registry.execute("calculator", "add", {"a": 1, "b": 2}), {"value": 3})

    def test_registry_snapshots_manifest_and_detaches_arguments_and_result(self):
        adapter = RecordingAdapter()
        registry = Registry([adapter])
        adapter.manifest["commands"][0]["side_effect"] = "remote_mutation"
        adapter.manifest["commands"][0]["input_schema"] = True
        described = registry.describe("calculator")
        described["commands"].clear()
        listing = registry.list_apps()
        listing[0]["adapter"]["kind"] = "frida"
        listing[0]["platforms"].clear()
        args = {"a": 1, "b": 2}
        result = registry.execute("calculator", "add", args)
        result["value"] = 99
        self.assertEqual(args, {"a": 1, "b": 2})
        self.assertEqual(adapter.output, {"value": 3})
        self.assertEqual(len(registry.describe("calculator")["commands"]), 3)
        self.assertEqual(registry.list_apps()[0]["adapter"]["kind"], "native-api")
        self.assertEqual(len(registry.list_apps()[0]["platforms"]), 3)

    def test_output_contract_and_native_exception_do_not_leak(self):
        adapter = RecordingAdapter()
        registry = Registry([adapter])
        for output in ({"value": "private native output"}, {"value": 3, "private": "secret"},
                       {"value": float("inf")}, {"value": float("nan")}, [], {"value": object()}):
            with self.subTest(output_type=type(output).__name__):
                adapter.output = output
                error = self.assert_code("OUTPUT_VALIDATION_FAILED", registry.execute, "calculator", "add", {"a": 1, "b": 2})
                self.assertEqual(error.exit_code, 1)
                self.assertNotIn("private", str(error))
                self.assertNotIn("secret", str(error))
        def broken(*args):
            raise RuntimeError("SECRET native exception /private/path")
        adapter.invoke = broken
        error = self.assert_code("ADAPTER_EXECUTION_FAILED", registry.execute, "calculator", "add", {"a": 1, "b": 2})
        self.assertNotIn("SECRET", str(error))
        self.assertNotIn("/private/path", str(error))

    def test_packaged_manifest_schema_matches_public_schema(self):
        root = Path(__file__).resolve().parents[1]
        public = json.loads((root / "schemas/app-manifest.schema.json").read_text())
        packaged = json.loads((root / "src/app_cli/manifests/app-manifest.schema.json").read_text())
        self.assertEqual(packaged, public)


if __name__ == "__main__":
    unittest.main()
