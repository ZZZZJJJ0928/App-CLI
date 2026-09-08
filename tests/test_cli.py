"""The public command boundary is exercised without opening an application UI."""

from contextlib import redirect_stdout, redirect_stderr
import copy
import io
import json
import subprocess
import sys
import unittest

from app_cli.adapters.calculator import CalculatorAdapter
from app_cli.cli import main
from app_cli.core import Registry


class CLITests(unittest.TestCase):
    def call(self, args, registry=None):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            status = main(args, registry=registry)
        self.assertEqual(errors.getvalue(), "")
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        result = json.loads(output.getvalue())
        self.assertEqual(result["protocol_version"], "1.0")
        return status, result

    def test_named_and_json_parameters_have_same_result(self):
        named = self.call(["calculator", "multiply", "--a", "-2", "--b", "3"])
        structured = self.call(["calculator", "multiply", "--input", '{"a":-2,"b":3}'])
        self.assertEqual(named, structured)
        self.assertEqual(named[0], 0)
        self.assertEqual(named[1]["data"], {"value": -6})

    def test_invalid_arguments_never_invoke_adapter_or_echo_input(self):
        class Never(CalculatorAdapter):
            def invoke(self, command, arguments):
                raise AssertionError("invalid input must not dispatch")

        registry = Registry([Never()])
        inputs = [
            ["--a", "2"],
            ["--a", "2", "--b", "3", "--input", '{"a":2,"b":3}'],
            ["--input", '{"a":1,"a":2,"b":3}'],
            ["--input", '{"a":NaN,"b":3}'],
            ["--input", '{"a":1e999,"b":3}'],
            ["--input", '{"a":true,"b":3}'],
            ["--input", '[2,3]'],
            ["--a", "1000001", "--b", "3"],
            ["--a", "PRIVATE_VALUE", "--b", "3"],
            ["--in", '{"a":2,"b":3}'],
        ]
        for args in inputs:
            with self.subTest(args=args):
                status, result = self.call(["calculator", "add", *args], registry)
                self.assertEqual(status, 2)
                self.assertFalse(result["ok"])
                self.assertNotIn("PRIVATE_VALUE", json.dumps(result))

    def test_discovery_and_schema_do_not_invoke_the_adapter(self):
        class Never(CalculatorAdapter):
            def invoke(self, command, arguments):
                raise AssertionError("discovery must not dispatch")

        registry = Registry([Never()])
        for args in (["apps"], ["describe", "calculator"], ["schema", "calculator", "add"]):
            with self.subTest(args=args):
                status, result = self.call(args, registry)
                self.assertEqual(status, 0)
                self.assertTrue(result["ok"])

    def test_boolean_schema_supports_json_input_without_parser_failure(self):
        adapter = CalculatorAdapter()
        adapter.manifest = copy.deepcopy(adapter.manifest)
        adapter.manifest["commands"][0]["input_schema"] = True
        status, result = self.call(["calculator", "add", "--input", '{"a":2,"b":3}'], Registry([adapter]))
        self.assertEqual(status, 0)
        self.assertEqual(result["data"], {"value": 5})

    def test_adapter_failure_is_structured_and_sanitized(self):
        class Broken(CalculatorAdapter):
            def invoke(self, command, arguments):
                raise RuntimeError("PRIVATE_VALUE")

        status, result = self.call(["calculator", "add", "--a", "2", "--b", "3"], Registry([Broken()]))
        self.assertEqual(status, 1)
        self.assertEqual(result["error"]["code"], "ADAPTER_EXECUTION_FAILED")
        self.assertNotIn("PRIVATE_VALUE", json.dumps(result))

    def test_module_entrypoint_runs_in_a_clean_subprocess(self):
        result = subprocess.run([sys.executable, "-m", "app_cli", "calculator", "subtract", "--a", "8", "--b", "3"],
                                capture_output=True, text=True, timeout=15, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["data"], {"value": 5})
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
