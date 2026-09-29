"""Owner-local signed grant references; the issuer is outside the public CLI."""

from dataclasses import asdict
import hashlib
import hmac
import os
from pathlib import Path
import re
import stat
import uuid

from .lifecycle import AuthorizationGrant
from . import lifecycle_protocol as wire


def private_read(path, maximum=65536):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Expected an owner-private regular file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            result = stream.read(maximum + 1)
        if len(result) > maximum:
            raise ValueError("Private file exceeds limit")
        return result
    finally:
        os.close(fd)


class SignedFileAuthorization:
    def __init__(self, directory, key_file):
        self.directory = Path(directory)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Expected an owner-private grant directory")
        self.key = private_read(key_file, 32)
        if len(self.key) != 32:
            raise ValueError("Issuer key must contain exactly 32 bytes")

    def record(self, reference):
        if type(reference) is not str or not re.fullmatch(r"[0-9a-f-]{36}", reference):
            raise ValueError("Invalid grant reference")
        record = wire.decode(private_read(self.directory / (reference + ".json")))
        if set(record) != {"grant", "resource", "mac"}:
            raise ValueError("Invalid grant record")
        payload = {"grant": record["grant"], "resource": record["resource"]}
        expected = hmac.new(self.key, wire.digest(payload).encode("ascii"), hashlib.sha256).hexdigest()
        if not isinstance(record["mac"], str) or not hmac.compare_digest(expected, record["mac"]):
            raise ValueError("Invalid grant signature")
        return record

    def resolve(self, reference):
        grant = dict(self.record(reference)["grant"])
        grant["operations"] = frozenset(grant["operations"])
        return AuthorizationGrant(**grant)

    def issue(self, grant, resource):
        """Trusted embedding API, intentionally absent from --machine operations."""
        if type(grant) is not AuthorizationGrant or type(resource) is not dict:
            raise ValueError("Invalid grant")
        value = asdict(grant)
        value["operations"] = sorted(value["operations"])
        payload = {"grant": value, "resource": resource}
        record = dict(payload, mac=hmac.new(self.key, wire.digest(payload).encode("ascii"), hashlib.sha256).hexdigest())
        reference = str(uuid.uuid4())
        target = self.directory / (reference + ".json")
        temporary = self.directory / (reference + ".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(wire.encode(record, 65536))
                stream.flush()
                os.fsync(fd)
            os.link(temporary, target)
            dirfd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
        finally:
            os.close(fd)
            temporary.unlink(missing_ok=True)
        return reference
