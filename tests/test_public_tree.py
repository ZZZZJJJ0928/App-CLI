"""Offline hygiene checks against disposable Git repositories only."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("public_tree_checker", ROOT / "scripts/check_public_tree.py")
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class PublicTreeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "repository"
        self.root.mkdir()
        self.git("init", "-q")

    def git(self, *arguments):
        return subprocess.run(["git", "-C", str(self.root), *arguments], check=True,
                              capture_output=True, text=True)

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def rules(self):
        return {entry["rule"] for entry in CHECKER.check(self.root)["issues"]}

    def test_initial_untracked_public_files_and_safe_placeholders_are_checked(self):
        self.write("README.md", 'Use --serial <USB_SERIAL> or --serial "$ANDROID_SERIAL".\n'
                   'ADB endpoint 127.0.0.1:5555; adb -s emulator-5554 shell.\n'
                   'Example path /home/<user>/project or /Users/username/project.\n')
        self.write("config/example.json", json.dumps({"serial": "example-device", "api_key": "${API_KEY}"}))
        result = CHECKER.check(self.root)
        self.assertTrue(result["ok"])
        self.assertEqual(result["files_checked"], 2)

    def test_ignored_private_data_is_not_read_or_reported(self):
        self.write(".gitignore", "private/\nraw/\nartifacts/\n")
        for folder in ("private", "raw", "artifacts"):
            self.write(folder + "/capture.json", "").write_bytes(b"\xff")
        self.assertTrue(CHECKER.check(self.root)["ok"])

    def test_forced_staged_private_directory_is_rejected_despite_ignore(self):
        self.write(".gitignore", "private/\n")
        self.write("private/capture.json", "{}")
        self.git("add", "-f", "private/capture.json")
        self.assertIn("PRIVATE_DATA_DIRECTORY", self.rules())
        # Removing worktree bytes does not remove the staged publication risk.
        (self.root / "private/capture.json").unlink()
        self.assertIn("PRIVATE_DATA_DIRECTORY", self.rules())

    def test_literal_secret_is_not_in_json_diagnostic(self):
        secret = "ghp_" + "a" * 36
        self.write("config.json", json.dumps({"access_token": secret}))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = CHECKER.main(["--root", str(self.root)])
        self.assertEqual(code, 1)
        value = json.loads(output.getvalue())
        self.assertFalse(value["ok"])
        self.assertNotIn(secret, output.getvalue())
        self.assertIn("TOKEN_LITERAL", {entry["rule"] for entry in value["issues"]})
        self.assertTrue(all(set(entry) == {"path", "rule"} for entry in value["issues"]))

    def test_staged_secret_still_fails_after_worktree_is_cleaned(self):
        secret = "sk-" + "a" * 30
        self.write("config.json", json.dumps({"api_key": secret}))
        self.git("add", "config.json")
        self.write("config.json", '{"api_key":"${API_KEY}"}')
        self.assertIn("TOKEN_LITERAL", self.rules())

    def test_private_key_user_path_private_ip_and_specific_serial_are_detected(self):
        self.write("key.pem", "-----BEGIN " + "PRIVATE KEY-----\nsynthetic\n")
        self.write("notes.md", "/Users/" + "specific-operator" + "/project\n"
                   + "host " + ".".join(("192", "168", "5", "20")) + "\n"
                   + "--" + "serial " + "ABC123" + "XYZ789\n")
        rules = self.rules()
        self.assertTrue({"PRIVATE_KEY_LITERAL", "ABSOLUTE_USER_PATH", "PRIVATE_IP_LITERAL", "DEVICE_SERIAL_LITERAL"} <= rules)

    def test_private_ipv6_is_detected_but_loopback_is_not(self):
        self.write("notes.md", "host " + "fd00" + "::1234\nloopback ::1\n")
        self.assertIn("PRIVATE_IP_LITERAL", self.rules())

    def test_external_symlink_rejected_without_reading_target(self):
        outside = Path(self.temporary.name) / "outside.txt"
        outside.write_text("external bytes")
        (self.root / "README.md").symlink_to(outside)
        self.assertEqual(self.rules(), {"SYMLINK_OUTSIDE_REPOSITORY"})

    def test_staged_escaping_symlink_is_rejected_after_worktree_replacement(self):
        (self.root / "README.md").symlink_to("../outside.txt")
        self.git("add", "README.md")
        (self.root / "README.md").unlink()
        self.write("README.md", "safe replacement")
        self.assertIn("SYMLINK_OUTSIDE_REPOSITORY", self.rules())

    def test_internal_source_symlink_is_allowed_but_private_target_is_not(self):
        self.write("docs/guide.md", "safe documentation")
        (self.root / "README.md").symlink_to("docs/guide.md")
        self.assertTrue(CHECKER.check(self.root)["ok"])
        self.write(".gitignore", "private/\n")
        self.write("private/notes.md", "private data")
        (self.root / "README.md").unlink()
        (self.root / "README.md").symlink_to("private/notes.md")
        self.assertIn("SYMLINK_PRIVATE_TARGET", self.rules())

    def test_build_cache_and_sibling_repository_are_not_scanned(self):
        self.write("build/config.json", '{"password":"example-password"}')
        sibling = Path(self.temporary.name) / "sibling"
        sibling.mkdir()
        (sibling / "secret.json").write_text('{"password":"example-password"}')
        self.assertTrue(CHECKER.check(self.root)["ok"])

    def test_non_repository_and_subdirectory_fail_without_native_error_text(self):
        subdirectory = self.root / "docs"
        subdirectory.mkdir()
        self.assertFalse(CHECKER.check(subdirectory)["ok"])
        value = CHECKER.check(Path(self.temporary.name))
        self.assertFalse(value["ok"])
        self.assertEqual(value["issues"], [{"path": ".", "rule": "GIT_FILES_UNAVAILABLE"}])

    def test_source_expressions_are_not_mistaken_for_literal_configuration(self):
        self.write("config.py", 'value = {"serial": args.serial, "password": read_password()}\n'
                   'if field == "serial":\n    validate(value)\n')
        self.assertTrue(CHECKER.check(self.root)["ok"])

    def test_windows_environment_preserves_systemroot_and_uses_absolute_resolved_git(self):
        # Simulate Windows environment requirements without executing Windows
        # code. The resolved executable uses the fixture host's path syntax.
        executable = str(Path(self.temporary.name) / "Git for Windows/cmd/git.exe")
        environment = {"PATH": r"C:\Program Files\Git\cmd;C:\Windows\System32", "SystemRoot": r"C:\Windows",
                       "PATHEXT": ".COM;.EXE;.BAT;.CMD", "GIT_DIR": "unrelated-repository",
                       "GIT_WORK_TREE": "unrelated-worktree", "GIT_SSH_COMMAND": "unwanted-command",
                       "EXAMPLE_SECRET": "not-forwarded"}
        with patch.dict(CHECKER.os.environ, environment, clear=True), \
             patch.object(CHECKER.shutil, "which", return_value=executable) as which, \
             patch.object(CHECKER.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"ready")) as run:
            self.assertEqual(CHECKER.git(self.root, "ls-files", "--cached"), b"ready")
        which.assert_called_once_with("git")
        args, options = run.call_args
        self.assertEqual(args[0], [executable, "-C", str(self.root), "ls-files", "--cached"])
        self.assertTrue(Path(args[0][0]).is_absolute())
        self.assertEqual(options["env"]["PATH"], environment["PATH"])
        self.assertEqual(options["env"]["SystemRoot"], environment["SystemRoot"])
        self.assertEqual(options["env"]["PATHEXT"], environment["PATHEXT"])
        for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_SSH_COMMAND", "EXAMPLE_SECRET"):
            self.assertNotIn(name, options["env"])
        self.assertEqual(options["env"]["GIT_CONFIG_NOSYSTEM"], "1")
        self.assertEqual(options["stdin"], subprocess.DEVNULL)

    def test_missing_git_returns_safe_json_failure(self):
        with patch.object(CHECKER.shutil, "which", return_value=None):
            self.assertEqual(CHECKER.check(self.root)["issues"], [{"path": ".", "rule": "GIT_FILES_UNAVAILABLE"}])


if __name__ == "__main__":
    unittest.main()
