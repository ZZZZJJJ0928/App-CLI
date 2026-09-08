"""Verify the CLI transport using a real child and injected boundary failures."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from app_cli.adapters import builtin_adapters
from app_cli.adapters.calculator_cli import CalculatorCLIAdapter, TIMEOUT_SECONDS
from app_cli.core import AppCLIError, Registry


class CalculatorCLITests(unittest.TestCase):
    def setUp(self):
        self.registry = Registry([CalculatorCLIAdapter()])

    def execute(self, arguments=None):
        return self.registry.execute("calculator-cli", "add", {"a": 2, "b": 3} if arguments is None else arguments)

    def response(self, **changes):
        payload = {"protocol_version": "1.0", "ok": True, "app": "calculator", "command": "add", "data": {"value": 5}}
        payload.update(changes)
        return json.dumps(payload).encode()

    def assert_failure(self, code, function, *args):
        with self.assertRaises(AppCLIError) as caught:
            function(*args)
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn("PRIVATE_VALUE", str(caught.exception))

    def test_real_child_matches_native_business_results(self):
        registry = Registry(builtin_adapters())
        for command, arguments in (("add", {"a": 2, "b": 3}), ("subtract", {"a": -4, "b": 7}),
                                   ("multiply", {"a": -1000000, "b": 1000000})):
            with self.subTest(command=command):
                self.assertEqual(registry.execute("calculator-cli", command, arguments),
                                 registry.execute("calculator", command, arguments))

    def test_discovery_invalid_input_and_mutations_never_start_a_child(self):
        with patch("app_cli.adapters.calculator_cli.subprocess.run") as run:
            registry = Registry(builtin_adapters())
            registry.list_apps()
            registry.describe("calculator-cli")
            for args in ({}, {"a": True, "b": 3}, {"a": 3.0, "b": 3}, {"a": 1000001, "b": 3},
                         {"a": "PRIVATE_VALUE", "b": 3}, {"a": 2, "b": 3, "executable": "PRIVATE_VALUE"}):
                self.assert_failure("INPUT_VALIDATION_FAILED", self.execute, args)
            adapter = CalculatorCLIAdapter()
            adapter.manifest["commands"][0]["side_effect"] = "remote_mutation"
            registry = Registry([adapter])
            self.assert_failure("CAPABILITY_NOT_SUPPORTED", registry.execute, "calculator-cli", "add", {"a": 2, "b": 3})
            run.assert_not_called()

    def test_transport_is_fixed_and_uses_a_timeout_without_a_shell(self):
        completed = subprocess.CompletedProcess([], 0, self.response())
        with patch("app_cli.adapters.calculator_cli.subprocess.run", return_value=completed) as run:
            self.assertEqual(self.execute(), {"value": 5})
        args, options = run.call_args
        self.assertEqual(args[0][:7], [sys.executable, "-I", "-m", "app_cli", "calculator", "add", "--input"])
        self.assertEqual(json.loads(args[0][7]), {"a": 2, "b": 3})
        self.assertFalse(options["shell"])
        self.assertEqual(options["timeout"], TIMEOUT_SECONDS)
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        self.assertEqual(options["stderr"], subprocess.DEVNULL)

    def test_start_failure_timeout_and_nonzero_exit_are_sanitized(self):
        for error, code in ((OSError("PRIVATE_VALUE"), "BACKEND_UNAVAILABLE"),
                            (subprocess.TimeoutExpired("PRIVATE_VALUE", 10, output=b"PRIVATE_VALUE"), "BACKEND_TIMEOUT")):
            with self.subTest(code=code), patch("app_cli.adapters.calculator_cli.subprocess.run", side_effect=error):
                self.assert_failure(code, self.execute)
        with patch("app_cli.adapters.calculator_cli.subprocess.run",
                   return_value=subprocess.CompletedProcess([], 1, b"PRIVATE_VALUE")):
            self.assert_failure("BACKEND_EXECUTION_FAILED", self.execute)

    def test_malformed_or_misattributed_responses_are_rejected(self):
        responses = [b"PRIVATE_VALUE", b"\xff", b"[]", b" " * 4097, self.response() + self.response(),
                     self.response(protocol_version="2.0"), self.response(ok=1), self.response(ok=False),
                     self.response(app="unrelated"), self.response(command="subtract"), self.response(data=[]),
                     self.response(extra="PRIVATE_VALUE"), self.response().replace(b'"value": 5', b'"value": 5, "value": 6'),
                     self.response().replace(b'"value": 5', b'"value": NaN'),
                     self.response().replace(b'"value": 5', b'"value": 1e999')]
        for index, output in enumerate(responses):
            with self.subTest(index=index), patch("app_cli.adapters.calculator_cli.subprocess.run",
                                                return_value=subprocess.CompletedProcess([], 0, output)):
                self.assert_failure("BACKEND_PROTOCOL_INVALID", self.execute)

    def test_valid_envelope_still_requires_valid_business_output(self):
        for data in ({"value": "PRIVATE_VALUE"}, {"value": 10**13}, {"value": True}, {}):
            with self.subTest(data=data), patch("app_cli.adapters.calculator_cli.subprocess.run",
                                               return_value=subprocess.CompletedProcess([], 0, self.response(data=data))):
                self.assert_failure("OUTPUT_VALIDATION_FAILED", self.execute)

    def test_installed_cli_runs_outside_repository_with_hostile_import_path(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "app_cli.py").write_text("raise RuntimeError('PRIVATE_VALUE')\n")
            environment = dict(os.environ, PYTHONPATH=directory)
            result = subprocess.run([sys.executable, "-I", "-m", "app_cli", "calculator-cli", "add", "--a", "2", "--b", "3"],
                                    cwd=directory, env=environment, capture_output=True, text=True, timeout=20, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["data"], {"value": 5})
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
