#!/usr/bin/env python3
"""Read-only checks for common accidental disclosures in public Git files.

This is a small repository hygiene check, not a secret detector or security
certification. Review public changes before publishing. No device commands,
network calls, sibling repositories or environment secrets are inspected.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess


EXCLUDED = {".git", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
            ".ruff_cache", ".cache", "node_modules", "build", "dist", ".tox"}
PRIVATE_DIRECTORIES = {"private", "raw", "artifacts"}
TEXT_SUFFIXES = {".py", ".pyi", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
                 ".json", ".jsonl", ".yaml", ".yml", ".toml", ".md", ".rst", ".txt",
                 ".sh", ".bash", ".zsh", ".ini", ".cfg", ".conf", ".xml", ".html",
                 ".css", ".sql", ".pem", ".key"}
TEXT_NAMES = {".gitignore", ".gitattributes", ".gitmodules", "Dockerfile", "Makefile", "LICENSE", ".env"}
MAX_SOURCE_BYTES = 2 * 1024 * 1024
PRIVATE_NETWORKS = (ipaddress.ip_network((0x0A000000, 8)), ipaddress.ip_network((0xAC100000, 12)),
                    ipaddress.ip_network((0xC0A80000, 16)), ipaddress.ip_network((0xFC00 << 112, 7)))
PRIVATE_KEY = re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----")
KNOWN_TOKEN = re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|"
                         r"sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b")
USER_PATH = re.compile(r"(?<![\w/])/(?:Users|home)/([^/\s\"'<>]+)/")
IPV4 = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
IPV6 = re.compile(r"(?<![\w:])f[cd][0-9a-f]{2}(?::[0-9a-f]{0,4}){2,7}(?![\w:])", re.I)
# Quoted values cover JSON, Python and shell examples; unquoted values cover
# small YAML/config examples. Values are never included in a diagnostic.
ASSIGNMENT = re.compile(
    r"(?im)(?<![\w-])[\"']?(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|serial)[\"']?"
    r"[ \t]*[:=][ \t]*(?:\"([^\"\r\n]*)\"|'([^'\r\n]*)'|([^\s,#}\]\r\n]+))")
SERIAL_ARGUMENT = re.compile(r"(?:--serial(?:=|\s+)|\badb\s+-s\s+)(?:\"([^\"\r\n]*)\"|'([^'\r\n]*)'|([^\s`]+))")


def placeholder(value):
    value = value.strip()
    return (not value or value in {"None", "null", "...", "***"}
            or bool(re.fullmatch(r"<[^<>]+>|\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*", value))
            or bool(re.fullmatch(r"(?:example|test|dummy|placeholder|redacted)(?:[-_:][a-z0-9_-]+)?|"
                                 r"changeme|replace_me|your[_-][a-z0-9_-]+", value, re.I))
            or value.startswith(("os.environ", "os.getenv", "process.env", "getenv(")))


def generic_serial(value):
    return (placeholder(value)
            or bool(re.fullmatch(r"(?:[A-Z][A-Z0-9_]*_)?SERIAL", value))
            or bool(re.fullmatch(r"(?:127\.0\.0\.1|localhost):[0-9]{1,5}|emulator-[0-9]{4,5}", value)))


def content_rules(text, *, allow_unquoted=True):
    rules = set()
    if PRIVATE_KEY.search(text):
        rules.add("PRIVATE_KEY_LITERAL")
    if KNOWN_TOKEN.search(text):
        rules.add("TOKEN_LITERAL")
    for match in USER_PATH.finditer(text):
        if not placeholder(match[1]) and match[1] not in {"USER", "USERNAME", "user", "username"}:
            rules.add("ABSOLUTE_USER_PATH")
    for match in (*IPV4.finditer(text), *IPV6.finditer(text)):
        try:
            address = ipaddress.ip_address(match[0])
        except ValueError:
            continue
        if any(address.version == network.version and address in network for network in PRIVATE_NETWORKS):
            rules.add("PRIVATE_IP_LITERAL")
    for match in ASSIGNMENT.finditer(text):
        if not allow_unquoted and match[4] is not None:
            continue  # A source expression is not a literal credential.
        value = next(value for value in match.groups()[1:] if value is not None)
        if match[1].lower() == "serial":
            if not generic_serial(value):
                rules.add("DEVICE_SERIAL_LITERAL")
        elif not placeholder(value):
            rules.add("CREDENTIAL_LITERAL")
    for match in SERIAL_ARGUMENT.finditer(text):
        value = next(value for value in match.groups() if value is not None)
        if not generic_serial(value):
            rules.add("DEVICE_SERIAL_LITERAL")
    return rules


def git_context():
    executable = shutil.which("git")
    if executable is None:
        raise FileNotFoundError("Git executable is unavailable")
    # Resolve the installed Git before minimizing the environment. In
    # particular, Windows' os.defpath does not locate Git for Windows, and
    # Windows processes need SystemRoot for normal system library loading.
    executable = os.path.abspath(executable)
    allowed = ("PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "PATHEXT", "TEMP", "TMP")
    environment = {name: os.environ[name] for name in allowed if name in os.environ}
    environment.setdefault("PATH", os.defpath)
    environment.update(LC_ALL="C", GIT_CONFIG_NOSYSTEM="1",
                       GIT_CONFIG_GLOBAL=os.devnull, GIT_OPTIONAL_LOCKS="0")
    return executable, environment


def git(root, *arguments, context=None):
    # Do not inherit GIT_DIR/GIT_WORK_TREE, credential helpers or shell startup
    # configuration. Git reads only this repository, including its index blobs.
    executable, environment = context if context is not None else git_context()
    return subprocess.run([executable, "-C", str(root), *arguments], env=environment,
                          stdin=subprocess.DEVNULL, capture_output=True, timeout=15, check=True).stdout


def source_file(path):
    return path.suffix.lower() in TEXT_SUFFIXES or path.name in TEXT_NAMES or path.name.startswith(".env.")


def file_content_rules(path, text):
    expressions = {".py", ".pyi", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"}
    return content_rules(text, allow_unquoted=path.suffix.lower() not in expressions)


def staged_rules(root, name, record, context):
    mode, object_id, stage = record
    if stage != "0":
        return {"UNMERGED_INDEX_ENTRY"}
    if mode == "160000":
        return set()  # A submodule is not scanned as another repository.
    if mode != "120000" and not source_file(Path(name)):
        return set()
    try:
        if int(git(root, "cat-file", "-s", object_id, context=context)) > MAX_SOURCE_BYTES:
            return {"SOURCE_TOO_LARGE"}
        data = git(root, "cat-file", "blob", object_id, context=context)
        if mode == "120000":
            target = ((root / name).parent / os.fsdecode(data)).resolve()
            if not target.is_relative_to(root):
                return {"SYMLINK_OUTSIDE_REPOSITORY"}
            if set(target.relative_to(root).parts) & PRIVATE_DIRECTORIES:
                return {"SYMLINK_PRIVATE_TARGET"}
            return set()
        return file_content_rules(Path(name), data.decode("utf-8"))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        return {"INDEX_SOURCE_UNREADABLE"}


def check(root):
    root = root.resolve()
    try:
        context = git_context()
        repository = Path(os.fsdecode(git(root, "rev-parse", "--show-toplevel", context=context)).strip()).resolve()
        if repository != root:
            return {"ok": False, "files_checked": 0, "issues": [{"path": ".", "rule": "ROOT_IS_NOT_REPOSITORY_ROOT"}]}
        names = sorted(set(os.fsdecode(name) for name in
                           git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", context=context).split(b"\0") if name))
        index = {}
        for entry in git(root, "ls-files", "--stage", "-z", context=context).split(b"\0"):
            if not entry:
                continue
            metadata, name = entry.split(b"\t", 1)
            mode, object_id, stage = metadata.decode("ascii").split()
            if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", object_id):
                raise ValueError("Invalid Git index object")
            index.setdefault(os.fsdecode(name), []).append((mode, object_id, stage))
    except (OSError, ValueError, subprocess.SubprocessError):
        return {"ok": False, "files_checked": 0, "issues": [{"path": ".", "rule": "GIT_FILES_UNAVAILABLE"}]}
    issues = []
    checked = 0
    for name in names:
        relative = PurePosixPath(name)
        parts = set(relative.parts)
        rules = set()
        if relative.is_absolute() or ".." in parts:
            rules.add("PATH_OUTSIDE_REPOSITORY")
        elif parts & PRIVATE_DIRECTORIES:
            rules.add("PRIVATE_DATA_DIRECTORY")
        elif parts & EXCLUDED:
            continue
        else:
            path = root / name
            try:
                resolved = path.resolve()
                if not resolved.is_relative_to(root):
                    rules.add("SYMLINK_OUTSIDE_REPOSITORY")
                elif set(resolved.relative_to(root).parts) & PRIVATE_DIRECTORIES:
                    rules.add("SYMLINK_PRIVATE_TARGET")
                elif not resolved.is_file():
                    # A deleted tracked file contains no publishable worktree
                    # content; staged content is examined separately below.
                    if path.is_symlink():
                        rules.add("BROKEN_SYMLINK")
                elif source_file(path):
                    checked += 1
                    if resolved.stat().st_size > MAX_SOURCE_BYTES:
                        rules.add("SOURCE_TOO_LARGE")
                    else:
                        rules.update(file_content_rules(path, resolved.read_text(encoding="utf-8")))
            except (OSError, RuntimeError, UnicodeError):
                rules.add("SOURCE_UNREADABLE")
            # Check index bytes as well: editing/removing a secret in the
            # worktree does not remove the earlier staged copy from a commit.
            for record in index.get(name, []):
                rules.update(staged_rules(root, name, record, context))
        issues.extend({"path": name, "rule": rule} for rule in sorted(rules))
    return {"ok": not issues, "files_checked": checked, "issues": issues}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    arguments = parser.parse_args(argv)
    try:
        result = check(arguments.root)
    except (OSError, RuntimeError):
        result = {"ok": False, "files_checked": 0, "issues": [{"path": ".", "rule": "ROOT_UNAVAILABLE"}]}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
