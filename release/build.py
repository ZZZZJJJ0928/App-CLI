#!/usr/bin/env python3
"""Build the wheel, npm backend and assets as one hash-pinned release."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtimes/browser"
OUT = Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else ROOT / "dist/release"
OUT.mkdir(parents=True, exist_ok=True)


def run(*args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, check=True)


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def write(file, value):
    file.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


shutil.copyfile(RUNTIME / "package-lock.json", RUNTIME / "npm-shrinkwrap.json")
run("node", "applications/mail/userscripts/build.mjs", cwd=RUNTIME)
run("node", "applications/mail/build-bindings.mjs", cwd=RUNTIME)
files = sorted(p for name in ["src", "applications", "bindings", "schemas", "assets"]
               for p in (RUNTIME / name).rglob("*") if p.is_file())
files += [RUNTIME / n for n in ["package.json", "npm-shrinkwrap.json", "LICENSE", "NOTICE"]]
hashes = {p.relative_to(RUNTIME).as_posix(): sha(p) for p in files}
package = json.loads((RUNTIME / "package.json").read_text())
release = {"schema_version": 1, "id": package["version"], "runtime_protocol": "2.0", "host_protocol": "1.0",
           "ledger_version": 1, "files": hashes}
write(RUNTIME / "release.json", release)
runtime_digest = sha(RUNTIME / "release.json")
write(ROOT / "src/app_cli/release.json", {"id": release["id"], "runtime_digest": runtime_digest})
run(sys.executable, "-m", "build", "--wheel", "--outdir", str(OUT))
packed = subprocess.check_output(["npm", "pack", "--json", "--pack-destination", str(OUT)], cwd=RUNTIME)
npm_file = OUT / json.loads(packed)[0]["filename"]
wheel = OUT / "infinimesh_app_cli-0.3.0+sparkclaw.1-py3-none-any.whl"
source_files = sorted(p for p in (ROOT / "src").rglob("*.py"))
source_digest = hashlib.sha256(json.dumps({p.relative_to(ROOT).as_posix(): sha(p) for p in source_files}, sort_keys=True).encode()).hexdigest()
dependencies = OUT / "python-requirements.txt"
shutil.copyfile(ROOT / "release/python-requirements.txt", dependencies)
manifest = {"schema_version": 1, "id": release["id"], "runtime_digest": runtime_digest,
            "source_repository": "https://github.com/ZZZZJJJ0928/App-CLI",
            "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "python_source_digest": source_digest, "runtime_protocol": "2.0", "host_protocol": "1.0", "ledger_version": 1,
            "artifacts": {"python_dependencies": {"file": dependencies.name, "sha256": sha(dependencies)}, "wheel": {"file": wheel.name, "sha256": sha(wheel)},
                          "runtime": {"file": npm_file.name, "sha256": sha(npm_file)}}}
write(OUT / "release.json", manifest)
print(f"Paired release: {OUT / 'release.json'}")
