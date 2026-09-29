"""Explicit POSIX service entry; discovery and invocations never start a daemon."""

import json
import os
from pathlib import Path
import sys

from .release import verify_release
from .authorization import private_read


def main():
    import fcntl
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m app_cli.executor_service CONFIG")
    config_file = Path(sys.argv[1]).absolute()
    config = json.loads(private_read(config_file))
    if config.get("release_digest") or Path(config["assembly_module"]).resolve() == (Path(config["runtime_directory"]) / "src/assembly.mjs").resolve():
        verify_release(config)
    state = Path(config["state_directory"])
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = state.lstat()
    if state.is_symlink() or not state.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SystemExit("Executor state must be owner-private")
    os.umask(0o077)
    lock = os.open(state / "executor.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Executor is already running") from None
    os.set_inheritable(lock, True)
    node, entry = config["node"], str(Path(config["runtime_directory"]) / "src/main.mjs")
    if not Path(node).is_absolute() or not Path(entry).is_absolute():
        raise SystemExit("Runtime paths must be absolute")
    os.execv(node, [node, entry, str(config_file), str(lock)])


if __name__ == "__main__":
    main()
