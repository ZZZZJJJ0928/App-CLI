"""Validate the concrete paired release before exposing its commands."""

import hashlib
import json
from pathlib import Path


def verify_release(config):
    root = Path(config["runtime_directory"]).resolve(strict=True)
    raw = (root / "release.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != config["release_digest"]:
        raise ValueError("Runtime release digest mismatch")
    release = json.loads(raw)
    packaged = json.loads(Path(__file__).with_name("release.json").read_bytes())
    if (release["schema_version"] != 1 or release["id"] != config["release_id"]
            or packaged != {"id": release["id"], "runtime_digest": config["release_digest"]}
            or release["runtime_protocol"] != "2.0" or release["host_protocol"] != "1.0"):
        raise ValueError("Python/runtime release mismatch")
    for relative, expected in release["files"].items():
        file = root / relative
        if (not file.is_relative_to(root) or file.resolve(strict=True) != file
                or hashlib.sha256(file.read_bytes()).hexdigest() != expected):
            raise ValueError("Release file mismatch")
    for binding in config["bindings"]:
        relative = Path(binding["path"]).relative_to(root).as_posix()
        if not relative.startswith("bindings/") or relative not in release["files"]:
            raise ValueError("Binding is outside the pinned release")
    return release
