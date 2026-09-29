"""Trusted lifecycle registration and authorization, independent of access kind."""

from collections.abc import Callable, Iterable
from dataclasses import dataclass
import math
import re
import time
from typing import Protocol

from .core import AppCLIError
from . import lifecycle_protocol as wire

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")


@dataclass(frozen=True)
class LifecycleRegistration:
    """Operator-reviewed evidence, supplied in code, never in invocation JSON."""

    app_id: str
    manifest_digest: str
    implementation_id: str
    conformance_id: str
    operations: frozenset[str] = wire.BASE_OPERATIONS
    renewable_commands: frozenset[str] = frozenset()


@dataclass(frozen=True)
class AuthorizationGrant:
    principal: str
    owner: str
    app: str
    command: str
    request_key: str
    intent_digest: str
    side_effect: str
    operations: frozenset[str]
    access_expires_ms: int
    execution_expires_ms: int
    max_deadline_ms: int | None
    task_id: str | None = None
    revision: int = 1

    def __post_init__(self):
        ids = (self.principal, self.owner, self.request_key)
        if (not all(type(value) is str and _ID.fullmatch(value) for value in ids)
                or not all(type(value) is str and 0 < len(value) <= 128 for value in (self.app, self.command))
                or type(self.intent_digest) is not str or not _DIGEST.fullmatch(self.intent_digest)
                or self.side_effect not in {"read_only", "local_mutation", "remote_mutation"}
                or type(self.operations) is not frozenset or not self.operations <= wire.OPERATIONS
                or any(type(value) is not int or not 0 < value <= wire.MAX_SAFE_INTEGER
                       for value in (self.access_expires_ms, self.execution_expires_ms, self.revision))
                or self.access_expires_ms < self.execution_expires_ms
                or (self.max_deadline_ms is not None and (type(self.max_deadline_ms) is not int
                    or not 0 < self.max_deadline_ms <= wire.MAX_SAFE_INTEGER))
                or (self.task_id is not None and (type(self.task_id) is not str or not _ID.fullmatch(self.task_id)))):
            raise ValueError("Invalid authorization grant")


class AuthorizationProvider(Protocol):
    def resolve(self, reference: str) -> AuthorizationGrant: ...


@dataclass(frozen=True)
class ExecutionContext:
    authorization_ref: str
    grant: AuthorizationGrant
    authorized_at_ms: int


class LifecycleAdapter(Protocol):
    """A registered extension; a method alone does not confer admission."""

    def invoke_lifecycle(self, request: dict, context: ExecutionContext) -> dict: ...


class LifecycleDispatcher:
    def __init__(self, registry, registrations: Iterable[LifecycleRegistration],
                 authorization: AuthorizationProvider | None, clock: Callable[[], float] = time.time):
        self.registry = registry
        self.authorization = authorization
        self.clock = clock
        self.registrations = {}
        for registration in registrations:
            if type(registration) is not LifecycleRegistration:
                raise AppCLIError("MANIFEST_INVALID", "Lifecycle registration must be explicit.", 2)
            adapter, manifest, commands = registry._app(registration.app_id)
            if (registration.app_id in self.registrations
                    or registration.manifest_digest != wire.digest(manifest)
                    or not callable(getattr(adapter, "invoke_lifecycle", None))
                    or not all(type(value) is str and _ID.fullmatch(value)
                               for value in (registration.implementation_id, registration.conformance_id))
                    or type(registration.operations) is not frozenset
                    or not wire.BASE_OPERATIONS <= registration.operations <= wire.OPERATIONS
                    or type(registration.renewable_commands) is not frozenset
                    or not registration.renewable_commands <= commands.keys()
                    or (registration.renewable_commands and not {"renew", "events"} <= registration.operations)):
                raise AppCLIError("MANIFEST_INVALID", "Lifecycle registration or manifest binding is invalid.", 2)
            self.registrations[registration.app_id] = (registration, adapter.invoke_lifecycle)

    def _authorize(self, request, side_effect, registration):
        if self.authorization is None:
            raise AppCLIError("AUTHORIZATION_REQUIRED", "A trusted authorization provider is required.")
        try:
            grant = self.authorization.resolve(request["authorization_ref"])
            now = self.clock() * 1000
            if type(grant) is not AuthorizationGrant or not math.isfinite(now):
                raise ValueError()
        except Exception:
            raise AppCLIError("AUTHORIZATION_INVALID", "Authorization could not be verified.") from None
        operation = request["operation"]
        allowed = (grant.app == request["app"] and grant.command == request["command"]
                   and operation in grant.operations and now < grant.access_expires_ms)
        if "request_key" in request:
            allowed = allowed and grant.request_key == request["request_key"]
        if "task_id" in request and grant.task_id is not None:
            allowed = allowed and grant.task_id == request["task_id"]
        if operation in wire.EXECUTION_OPERATIONS:
            allowed = allowed and now < grant.execution_expires_ms and grant.side_effect == side_effect
        if operation == "invoke":
            allowed = allowed and grant.intent_digest == wire.intent_digest(request)
            deadline = request.get("deadline_ms")
            if deadline is None:
                allowed = (allowed and request["command"] in registration.renewable_commands
                           and grant.max_deadline_ms is None)
            else:
                allowed = (allowed and grant.max_deadline_ms is not None
                           and now < deadline <= grant.max_deadline_ms)
        if not allowed:
            raise AppCLIError("AUTHORIZATION_DENIED", "Authorization does not permit this lifecycle operation.")
        return ExecutionContext(request["authorization_ref"], grant, int(now))

    def dispatch(self, request):
        request = wire.validate_request(request)
        _, _, commands = self.registry._app(request["app"])
        if request["command"] not in commands:
            raise AppCLIError("COMMAND_NOT_FOUND", "Application command is not registered.", 2)
        entry = self.registrations.get(request["app"])
        if entry is None or request["operation"] not in entry[0].operations:
            raise AppCLIError("CAPABILITY_NOT_SUPPORTED", "This adapter has no registered lifecycle capability.")
        registration, invoke = entry
        spec, input_validator, output_validator = commands[request["command"]]
        if request["operation"] == "invoke":
            self.registry._validate(request["arguments"], input_validator, "INPUT_VALIDATION_FAILED",
                                    "Arguments do not match the command schema.")
        if request["operation"] == "renew" and request["command"] not in registration.renewable_commands:
            raise AppCLIError("CAPABILITY_NOT_SUPPORTED", "The command is not renewable.")
        context = self._authorize(request, spec["side_effect"], registration)
        try:
            # The backend receives its own detached request, not our response-check identity.
            response = invoke(wire.decode(wire.encode(request)), context)
        except AppCLIError:
            raise
        except Exception:
            raise AppCLIError("ADAPTER_EXECUTION_FAILED", "The lifecycle backend could not complete the operation.") from None
        response = wire.validate_response(request, response)
        if response["kind"] == "error":
            raise AppCLIError(response["error"]["code"], "The lifecycle backend rejected the operation.",
                              task=response.get("task"))
        if response["kind"] == "task" and response["task"]["status"] == "completed":
            try:
                self.registry._validate(response["data"], output_validator, "OUTPUT_VALIDATION_FAILED",
                                        "Task output does not match the original command schema.")
            except AppCLIError as error:
                error.task = response["task"]
                raise
        return response
