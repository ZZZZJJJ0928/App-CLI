"""Generic runtime and task-outcome contracts, with self-owned public fixtures."""

from contextlib import redirect_stdout, redirect_stderr
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from app_cli.adapters import builtin_adapters
from app_cli.adapters.calculator import CalculatorAdapter
from app_cli.adapters.runtime import RuntimeAdapter
from app_cli.cli import main
from app_cli.core import AppCLIError, Registry
from app_cli.runtime_protocol import MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, validator
from app_cli.tasks import TASK_STATUSES, TaskResult


class OutcomeAdapter(CalculatorAdapter):
    def __init__(self, outcome):
        super().__init__()
        self.outcome = outcome
        self.calls = 0

    def invoke(self, command, arguments):
        self.calls += 1
        return self.outcome


def runtime_manifest():
    manifest = CalculatorAdapter().manifest
    manifest.update(id="example-runtime", name="Synthetic runtime")
    manifest["adapter"] = {"kind": "runtime", "name": "Synthetic protocol test"}
    return manifest


def response(*, status="completed", task_id=None, **changes):
    result = {"protocol_version": "1.0", "type": "result", "app": "example-runtime", "command": "add",
              "task": {"status": status, **({"id": task_id} if task_id is not None else {})}}
    if status == "completed":
        result["data"] = {"value": 5}
    return {**result, **changes}


class TaskTests(unittest.TestCase):
    def call(self, adapter):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            status = main(["calculator", "add", "--a", "2", "--b", "3"], registry=Registry([adapter]))
        self.assertEqual(errors.getvalue(), "")
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        return status, json.loads(output.getvalue())

    def test_completed_data_remains_compatible_and_metadata_is_preserved(self):
        data = {"value": 5}
        adapter = OutcomeAdapter(TaskResult("completed", data, "task-example"))
        registry = Registry([adapter])
        self.assertEqual(registry.execute("calculator", "add", {"a": 2, "b": 3}), data)
        result = registry.execute_with_metadata("calculator", "add", {"a": 2, "b": 3})
        self.assertEqual(result, {"data": data, "task": {"status": "completed", "id": "task-example"}})
        result["data"]["value"] = 99
        self.assertEqual(data, {"value": 5})
        status, result = self.call(adapter)
        self.assertEqual(status, 0)
        self.assertTrue(result["ok"])
        self.assertEqual(result["task"], {"status": "completed", "id": "task-example"})

    def test_legacy_dictionary_envelope_is_unchanged(self):
        status, result = self.call(OutcomeAdapter({"value": 5}))
        self.assertEqual(status, 0)
        self.assertEqual(result, {"protocol_version": "1.0", "ok": True, "app": "calculator",
                                  "command": "add", "data": {"value": 5}})

    def test_all_incomplete_statuses_fail_without_retry_or_success_data(self):
        for state in TASK_STATUSES - {"completed"}:
            with self.subTest(state=state):
                adapter = OutcomeAdapter(TaskResult(state, task_id="task-example"))
                status, result = self.call(adapter)
                self.assertEqual(status, 1)
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"]["code"], "TASK_" + state.upper())
                self.assertEqual(result["task"], {"status": state, "id": "task-example"})
                self.assertNotIn("data", result)
                self.assertEqual(adapter.calls, 1)
                with self.assertRaises(AppCLIError) as caught:
                    Registry([adapter]).execute("calculator", "add", {"a": 2, "b": 3})
                self.assertEqual(caught.exception.task["id"], "task-example")

    def test_pre_dispatch_failure_can_have_no_task_id(self):
        for state in ("blocked", "failed"):
            status, result = self.call(OutcomeAdapter(TaskResult(state)))
            self.assertEqual(status, 1)
            self.assertEqual(result["task"], {"status": state})

    def test_completed_output_still_requires_the_business_contract(self):
        for data in ({"value": "PRIVATE_VALUE"}, {"value": float("nan")}, {}):
            status, result = self.call(OutcomeAdapter(TaskResult("completed", data, "task-example")))
            self.assertEqual(status, 1)
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"]["code"], "OUTPUT_VALIDATION_FAILED")
            self.assertEqual(result["task"]["id"], "task-example")
            self.assertNotIn("PRIVATE_VALUE", json.dumps(result))

    def test_invalid_task_shapes_are_rejected(self):
        for state, data, task_id in (
            ("success", {}, None), (True, {}, None), ("completed", None, None),
            ("running", {}, "task-example"), ("uncertain", None, None),
            ("pending", None, None), ("waiting_confirmation", None, None),
            ("cancelled", None, None), ("failed", {}, None),
            ("completed", {}, "task\n"), ("failed", None, "x" * 129),
            ("failed", None, "../PRIVATE_VALUE"), ("failed", None, 1),
        ):
            with self.subTest(state=state, task_id=task_id), self.assertRaises(ValueError):
                TaskResult(state, data, task_id)
        with self.assertRaises(ValueError):
            AppCLIError("TEST", "Test", task={"status": "failed", "private": "PRIVATE_VALUE"})


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.adapter = RuntimeAdapter(runtime_manifest(), [sys.executable, "-I", "-m", "example.runtime"])
        self.registry = Registry([self.adapter])

    def execute(self, arguments=None):
        return self.registry.execute_with_metadata("example-runtime", "add", {"a": 2, "b": 3} if arguments is None else arguments)

    def completed(self, payload=None, *, raw=None, code=0):
        output = raw if raw is not None else json.dumps(response() if payload is None else payload).encode()
        return subprocess.CompletedProcess([], code, output)

    def assert_failure(self, code, function, *args):
        with self.assertRaises(AppCLIError) as caught:
            function(*args)
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn("PRIVATE_VALUE", str(caught.exception))

    def test_real_reference_matches_native_calculator(self):
        registry = Registry(builtin_adapters())
        for command, args in (("add", {"a": 2, "b": 3}), ("subtract", {"a": -4, "b": 7}),
                               ("multiply", {"a": -1000000, "b": 1000000})):
            with self.subTest(command=command):
                result = registry.execute_with_metadata("calculator-runtime", command, args)
                self.assertEqual(result["data"], registry.execute("calculator", command, args))
                self.assertEqual(result["task"], {"status": "completed"})

    def test_discovery_and_invalid_arguments_never_start_runtime(self):
        with patch("app_cli.adapters.runtime.subprocess.run") as run:
            registry = Registry(builtin_adapters())
            registry.list_apps()
            registry.describe("calculator-runtime")
            for args in ({}, {"a": True, "b": 3}, {"a": 1000001, "b": 3},
                         {"a": 2, "b": 3, "argv": ["PRIVATE_VALUE"]}):
                self.assert_failure("INPUT_VALIDATION_FAILED", self.execute, args)
            self.assert_failure("COMMAND_NOT_FOUND", self.adapter.invoke, "cancel", {})
            run.assert_not_called()

    def test_mutations_remain_blocked_in_registry_and_direct_adapter_calls(self):
        with patch("app_cli.adapters.runtime.subprocess.run") as run:
            for effect in ("local_mutation", "remote_mutation"):
                manifest = runtime_manifest()
                manifest["commands"][0]["side_effect"] = effect
                adapter = RuntimeAdapter(manifest, [sys.executable])
                self.assert_failure("CAPABILITY_NOT_SUPPORTED", adapter.invoke, "add", {"a": 2, "b": 3})
                self.assert_failure("CAPABILITY_NOT_SUPPORTED", Registry([adapter]).execute,
                                    "example-runtime", "add", {"a": 2, "b": 3})
            run.assert_not_called()

    def test_transport_uses_fixed_argv_json_stdin_and_timeout(self):
        with patch("app_cli.adapters.runtime.subprocess.run", return_value=self.completed()) as run:
            self.assertEqual(self.execute(), {"data": {"value": 5}, "task": {"status": "completed"}})
        args, options = run.call_args
        self.assertEqual(args[0], (sys.executable, "-I", "-m", "example.runtime"))
        self.assertEqual(json.loads(options["input"]), {"protocol_version": "1.0", "type": "invoke",
                                                      "app": "example-runtime", "command": "add", "arguments": {"a": 2, "b": 3}})
        self.assertEqual(options["stderr"], subprocess.DEVNULL)
        self.assertFalse(options["shell"])
        self.assertEqual(options["timeout"], 30)

    def test_runtime_waiting_and_uncertain_outcomes_are_preserved(self):
        for state in TASK_STATUSES - {"completed"}:
            with self.subTest(state=state), patch("app_cli.adapters.runtime.subprocess.run",
                                                 return_value=self.completed(response(status=state, task_id="task-example"))) as run:
                self.assert_failure("TASK_" + state.upper(), self.execute)
                self.assertEqual(run.call_count, 1)

    def test_real_worker_can_report_an_incomplete_task_with_successful_transport(self):
        for state in ("running", "uncertain", "failed"):
            payload = response(status=state, task_id="task-example")
            source = "import json, sys\njson.load(sys.stdin)\nprint(" + repr(json.dumps(payload)) + ")\n"
            adapter = RuntimeAdapter(runtime_manifest(), [sys.executable, "-I", "-c", source])
            output = io.StringIO()
            with redirect_stdout(output):
                status = main(["example-runtime", "add", "--a", "2", "--b", "3"], registry=Registry([adapter]))
            result = json.loads(output.getvalue())
            self.assertEqual(status, 1)
            self.assertFalse(result["ok"])
            self.assertEqual(result["task"], {"status": state, "id": "task-example"})

    def test_failures_and_timeout_never_retry_or_expose_backend_text(self):
        for error, code in ((OSError("PRIVATE_VALUE"), "BACKEND_UNAVAILABLE"),
                            (subprocess.TimeoutExpired("PRIVATE_VALUE", 30, output=b"PRIVATE_VALUE"), "BACKEND_TIMEOUT")):
            with patch("app_cli.adapters.runtime.subprocess.run", side_effect=error) as run:
                self.assert_failure(code, self.execute)
                self.assertEqual(run.call_count, 1)
        with patch("app_cli.adapters.runtime.subprocess.run", return_value=self.completed(code=1, raw=b"PRIVATE_VALUE")):
            self.assert_failure("BACKEND_EXECUTION_FAILED", self.execute)

    def test_malformed_ambiguous_and_oversized_responses_are_rejected(self):
        valid = json.dumps(response()).encode()
        for raw in (b"PRIVATE_VALUE", b"\xff", b"[]", valid + valid, b" " * (MAX_RESPONSE_BYTES + 1),
                    valid.replace(b'"value": 5', b'"value": 5, "value": 6'),
                    valid.replace(b'"value": 5', b'"value": NaN'),
                    valid.replace(b'"value": 5', b'"value": 1e999')):
            with patch("app_cli.adapters.runtime.subprocess.run", return_value=self.completed(raw=raw)):
                self.assert_failure("BACKEND_PROTOCOL_INVALID", self.execute)

    def test_identity_state_and_data_consistency_are_enforced(self):
        bad = [response(), response()]
        del bad[0]["task"]
        del bad[1]["data"]
        bad.extend(response(**change) for change in (
            {"protocol_version": "2.0"}, {"app": "another-app"}, {"command": "multiply"},
            {"type": "invoke"}, {"task": {"status": "unknown"}}, {"ok": True},
            {"task": {"status": "running", "id": "task-example"}},
            {"task": {"status": "completed", "id": "task\n"}},
            {"data": []}, {"private": "PRIVATE_VALUE"},
        ))
        bad.extend(response(status=state) for state in ("running", "uncertain", "waiting_confirmation"))
        for payload in bad:
            with self.subTest(payload=payload), patch("app_cli.adapters.runtime.subprocess.run",
                                                     return_value=self.completed(payload)):
                self.assert_failure("BACKEND_PROTOCOL_INVALID", self.execute)

    def test_task_completion_does_not_bypass_business_output_validation(self):
        with patch("app_cli.adapters.runtime.subprocess.run", return_value=self.completed(response(data={"value": "PRIVATE_VALUE"}))):
            self.assert_failure("OUTPUT_VALIDATION_FAILED", self.execute)

    def test_request_size_is_bounded_before_starting_a_process(self):
        manifest = runtime_manifest()
        manifest["commands"][0]["input_schema"] = {"type": "object"}
        adapter = RuntimeAdapter(manifest, [sys.executable])
        with patch("app_cli.adapters.runtime.subprocess.run") as run:
            self.assert_failure("INPUT_VALIDATION_FAILED", adapter.invoke, "add", {"text": "a" * MAX_REQUEST_BYTES})
            run.assert_not_called()

    def test_invalid_configuration_is_rejected_without_probing(self):
        with patch("app_cli.adapters.runtime.subprocess.run") as run:
            for argv in ([], "python", ["python"], [sys.executable, 1], [sys.executable, "bad\x00arg"]):
                self.assert_failure("MANIFEST_INVALID", RuntimeAdapter, runtime_manifest(), argv)
            for timeout in (0, -1, 301, 10**1000, True, float("nan"), float("inf"), "30"):
                with self.assertRaises(AppCLIError):
                    RuntimeAdapter(runtime_manifest(), [sys.executable], timeout_seconds=timeout)
            self.assert_failure("MANIFEST_INVALID", RuntimeAdapter, CalculatorAdapter().manifest, [sys.executable])
            run.assert_not_called()

    def test_registration_snapshots_transport_and_manifest(self):
        manifest, argv = runtime_manifest(), [sys.executable, "-I"]
        adapter = RuntimeAdapter(manifest, argv)
        manifest["id"] = "changed"
        argv.append("PRIVATE_VALUE")
        with patch("app_cli.adapters.runtime.subprocess.run", return_value=self.completed()) as run:
            self.assertEqual(adapter.invoke("add", {"a": 2, "b": 3}).data, {"value": 5})
        self.assertEqual(run.call_args.args[0], (sys.executable, "-I"))
        self.assertEqual(json.loads(run.call_args.kwargs["input"])["app"], "example-runtime")

    def test_reference_works_outside_repository_with_conflicting_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "app_cli.py").write_text("raise RuntimeError('PRIVATE_VALUE')\n")
            env = dict(os.environ, PYTHONPATH=directory)
            result = subprocess.run([sys.executable, "-I", "-m", "app_cli", "calculator-runtime", "add", "--a", "2", "--b", "3"],
                                    cwd=directory, env=env, capture_output=True, timeout=20, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["data"], {"value": 5})
        self.assertEqual(result.stderr, b"")

    def test_public_and_packaged_protocol_schemas_match_task_rules(self):
        root = Path(__file__).resolve().parents[1]
        self.assertEqual((root / "schemas/runtime-protocol.schema.json").read_bytes(),
                         (root / "src/app_cli/manifests/runtime-protocol.schema.json").read_bytes())
        check = validator("response")
        for state in TASK_STATUSES:
            payload = response(status=state, task_id="task-example")
            self.assertTrue(check.is_valid(payload))
            TaskResult(state, payload.get("data"), payload["task"]["id"])


if __name__ == "__main__":
    unittest.main()
