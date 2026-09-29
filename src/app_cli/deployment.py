"""Explicit installation assembly; all paths come from an owner-private config."""

import os
from pathlib import Path

from .release import verify_release
from .authorization import SignedFileAuthorization, private_read
from .adapters import builtin_adapters
from .adapters.runtime import RuntimeAdapter
from .core import Registry, AppCLIError
from .lifecycle import LifecycleRegistration
from . import lifecycle_protocol as wire


def configured_registry():
    config_file = os.environ.get("APP_CLI_CONFIG")
    if not config_file:
        return Registry(builtin_adapters())
    try:
        config = wire.decode(private_read(config_file))
        runtime = Path(config["runtime_directory"])
        node = Path(config["node"])
        if not runtime.is_absolute() or not node.is_absolute():
            raise ValueError("Deployment paths must be absolute")
        if config.get("release_digest") or Path(config["assembly_module"]).resolve() == (runtime / "src/assembly.mjs").resolve():
            verify_release(config)
        adapters = list(builtin_adapters())
        registrations = []
        # Pinned bindings are installation inputs, never wire selectors.
        for installed in config["bindings"]:
            binding = wire.decode(Path(installed["path"]).read_bytes())
            if wire.digest(binding) != installed["digest"] or wire.digest(binding["manifest"]) != binding["manifest_digest"]:
                raise ValueError("Release binding mismatch")
            manifest = binding["manifest"]
            adapters.append(RuntimeAdapter(manifest, [str(node), str(runtime / "src/client.mjs"), config["socket"]],
                                           protocol_version="2.0", timeout_seconds=20))
            registrations.append(LifecycleRegistration(manifest["id"], binding["manifest_digest"],
                "owner-local-executor-v2", "owner-local-lifecycle-v2", operations=wire.OPERATIONS,
                renewable_commands=frozenset(name for name, spec in binding["commands"].items() if spec.get("renewable"))))
        return Registry(adapters, lifecycle=registrations,
                        authorization=SignedFileAuthorization(config["grants_directory"], config["issuer_key_file"]))
    except Exception:
        raise AppCLIError("DEPLOYMENT_INVALID", "The configured application release could not be verified.") from None
