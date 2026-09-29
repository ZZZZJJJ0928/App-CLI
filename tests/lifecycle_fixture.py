"""Self-owned transactional fixture; not a production backend or application."""

from dataclasses import asdict
from contextlib import closing
import json
import sqlite3
import time
import uuid

from app_cli.adapters.calculator import CalculatorAdapter
from app_cli.core import AppCLIError
from app_cli.lifecycle import AuthorizationGrant
from app_cli import lifecycle_protocol as wire


def manifest(kind="native-api"):
    value = CalculatorAdapter().manifest
    value = json.loads(json.dumps(value))
    value.update(id="fixture-counter", name="Transactional fixture counter")
    value["adapter"] = {"kind": kind, "name": "Self-owned lifecycle fixture"}
    value["commands"] = [{"name": "increment", "description": "Increment a self-owned local counter.",
        "side_effect": "local_mutation",
        "input_schema": {"type": "object", "properties": {"amount": {"type": "integer", "minimum": 1, "maximum": 100}},
                         "required": ["amount"], "additionalProperties": False},
        "output_schema": {"type": "object", "properties": {"value": {"type": "integer", "minimum": 1}},
                          "required": ["value"], "additionalProperties": False}}]
    return value


class GrantProvider:
    def __init__(self, grants):
        self.grants = grants

    def resolve(self, reference):
        return self.grants[reference]


def read_grants(path):
    values = json.loads(path.read_text())
    return GrantProvider({key: AuthorizationGrant(**{**value, "operations": frozenset(value["operations"])})
                          for key, value in values.items()})


def write_grants(path, grants):
    values = {key: {**asdict(value), "operations": sorted(value.operations)} for key, value in grants.items()}
    path.write_text(json.dumps(values))
    path.chmod(0o600)


class CounterAdapter:
    def __init__(self, path, provider, *, clock=time.time):
        self.manifest = manifest()
        self.path, self.provider, self.clock = path, provider, clock

    def invoke(self, command, arguments):
        raise AppCLIError("CAPABILITY_NOT_SUPPORTED", "Fixture mutation requires lifecycle admission.")

    def invoke_lifecycle(self, request, context):
        # Re-resolve at the execution boundary; neither context nor JSON approves itself.
        grant = self.provider.resolve(request["authorization_ref"])
        if grant != context.grant or grant.app != request["app"] or grant.command != request["command"]:
            raise AppCLIError("AUTHORIZATION_DENIED", "Fixture authority mismatch.")
        response = {key: request[key] for key in ("protocol_version", "operation", "app", "command", "request_key") if key in request}
        identity = (grant.principal, grant.owner, grant.app, grant.command, grant.request_key)
        with closing(sqlite3.connect(self.path, timeout=5)) as connection, connection:
            connection.execute('CREATE TABLE IF NOT EXISTS tasks (principal TEXT, owner TEXT, app TEXT, command TEXT, request_key TEXT, digest TEXT, task_id TEXT UNIQUE, result INTEGER, PRIMARY KEY(principal, owner, app, command, request_key))')
            connection.execute('CREATE TABLE IF NOT EXISTS counters (owner TEXT PRIMARY KEY, value INTEGER)')
            connection.execute('BEGIN IMMEDIATE')
            now = self.clock() * 1000
            operation = request["operation"]
            if (operation not in grant.operations or now >= grant.access_expires_ms
                    or (operation in wire.EXECUTION_OPERATIONS and now >= grant.execution_expires_ms)):
                raise AppCLIError("AUTHORIZATION_DENIED", "Fixture authority expired.")
            row = connection.execute('SELECT digest, task_id, result FROM tasks WHERE principal=? AND owner=? AND app=? AND command=? AND request_key=?', identity).fetchone()
            if row and row[0] != grant.intent_digest:
                raise AppCLIError("REQUEST_KEY_CONFLICT", "Original intent differs.")
            if operation == "invoke":
                if (wire.intent_digest(request) != grant.intent_digest or grant.side_effect != "local_mutation"
                        or request["request_key"] != grant.request_key or now >= request["deadline_ms"]):
                    raise AppCLIError("AUTHORIZATION_DENIED", "Fixture intent mismatch.")
                if row is None:
                    old = connection.execute('SELECT value FROM counters WHERE owner=?', (grant.owner,)).fetchone()
                    value = (old[0] if old else 0) + request["arguments"]["amount"]
                    task_id = "task-" + uuid.uuid4().hex
                    connection.execute('INSERT INTO counters(owner,value) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value', (grant.owner, value))
                    connection.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)', (*identity, grant.intent_digest, task_id, value))
                    row = (grant.intent_digest, task_id, value)
            elif row is None:
                if operation == "lookup":
                    return {**response, "kind": "lookup", "outcome": "not_found"}
                raise AppCLIError("TASK_NOT_FOUND", "Original task is unavailable.")
            if "task_id" in request and row[1] != request["task_id"]:
                raise AppCLIError("TASK_NOT_FOUND", "Original task is unavailable.")
            task = {"id": row[1], "status": "completed"}
            if operation == "cancel":
                return {**response, "kind": "ack", "accepted": True, "task": task}
            if operation in {"resume", "renew"}:
                raise AppCLIError("TASK_TERMINAL", "A completed fixture task cannot resume.")
            return {**response, "kind": "task", "task": task, "data": {"value": row[2]}}
