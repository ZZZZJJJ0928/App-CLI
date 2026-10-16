"""Generate the lifecycle 3.0 JSON Schema into its published and packaged copies.

Usage: python scripts/generate_lifecycle_schema.py schemas/lifecycle-v3.schema.json runtimes/browser/schemas/lifecycle-v3.schema.json src/app_cli/manifests/lifecycle-v3.schema.json
"""
import json, sys
ID = {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"}
HEX = {"type": "string", "pattern": "^[a-f0-9]{64}$"}
INT = {"type": "integer", "minimum": 0, "maximum": 9007199254740991}
POS = {"type": "integer", "minimum": 1, "maximum": 9007199254740991}
NAME = {"type": "string", "minLength": 1, "maxLength": 128}
REASON = {"type": "string", "pattern": "^[a-z][a-z0-9_]{0,63}$"}
STATUS = ["prepared", "pending", "running", "waiting_confirmation", "uncertain", "blocked",
          "completed", "failed", "cancelled", "resolved"]
OPS = ["prepare", "invoke", "lookup", "status", "cancel", "resume", "renew", "events", "reconcile",
       "ack_result", "resolve", "epoch"]
base = {"protocol_version": {"const": "3.0"}, "app": NAME, "command": NAME, "authorization_ref": ID}
def request(op, props, required):
    return {"type": "object", "additionalProperties": False,
            "properties": {**base, "operation": {"const": op}, **props},
            "required": ["protocol_version", "operation", "app", "command", "authorization_ref", *required]}
task_ops = ["invoke", "status", "cancel", "resume", "renew", "reconcile"]
requests = [request("prepare", {"request_key": ID, "arguments": {"type": "object"}, "deadline_ms": POS}, ["request_key", "arguments"]),
            request("lookup", {"request_key": ID}, ["request_key"])]
requests += [request(op, {"task_id": ID}, ["task_id"]) for op in task_ops]
requests.append(request("events", {"task_id": ID, "cursor": INT, "limit": {"type": "integer", "minimum": 1, "maximum": 200}}, ["task_id", "cursor"]))
requests.append(request("ack_result", {"task_id": ID, "result_digest": HEX, "terminal_revision": POS, "receiver_id": ID, "receipt_id": ID},
                        ["task_id", "result_digest", "terminal_revision", "receiver_id", "receipt_id"]))
requests.append(request("resolve", {"task_id": ID, "resolution": {"enum": ["confirmed_sent", "confirmed_not_sent", "accept_unknown"]},
                                    "evidence_digest": HEX}, ["task_id", "resolution"]))
requests.append({**request("epoch", {"action": {"enum": ["status", "rotate", "seal", "register_schedule", "delete_schedule"]},
                                      "epoch": POS, "drained_digest": HEX,
                                      "schedule_id": {"type": "string", "pattern": "^s3\\.(0|[1-9][0-9]{0,14})\\.(0|[1-9][0-9]{0,14})\\.[0-9a-f]{32}$"},
                                      "revision": POS}, ["action"]),
                 "allOf": [{"if": {"properties": {"action": {"const": "seal"}}}, "then": {"required": ["epoch", "drained_digest"]}},
                           {"if": {"properties": {"action": {"const": "register_schedule"}}}, "then": {"required": ["schedule_id", "revision"]}},
                           {"if": {"properties": {"action": {"const": "delete_schedule"}}}, "then": {"required": ["schedule_id"]}}]})
task = {"type": "object", "additionalProperties": False, "properties": {"id": ID, "status": {"enum": STATUS}}, "required": ["id", "status"]}
epoch_state = {"type": "object", "additionalProperties": False,
               "properties": {"generation": POS, "open_epoch": POS, "draining_epoch": {"anyOf": [POS, {"type": "null"}]},
                              "sealed_through": INT, "authorization_generation": POS},
               "required": ["generation", "open_epoch", "draining_epoch", "sealed_through", "authorization_generation"]}
common = {"protocol_version": {"const": "3.0"}, "operation": {"enum": OPS}, "app": NAME, "command": NAME,
          "request_key": ID, "epoch_state": epoch_state}
keyed = {"if": {"properties": {"operation": {"enum": ["prepare", "lookup"]}}}, "then": {"required": ["request_key"]},
         "else": {"not": {"required": ["request_key"]}}}
def response(kind, props, required, extra=()):
    return {"type": "object", "additionalProperties": False, "properties": {**common, "kind": {"const": kind}, **props},
            "required": ["protocol_version", "operation", "app", "command", "kind", *required], "allOf": [keyed, *extra]}
responses = [
    response("task", {"task": task, "data": {"type": "object"}, "reason": {"type": "string", "pattern": "^[A-Z][A-Z0-9_]{0,63}$"},
                      "attempt": INT, "effect": {"type": "boolean"}, "terminal_revision": POS, "result_digest": HEX,
                      "resolution": {"enum": ["confirmed_sent", "confirmed_not_sent", "accept_unknown"]}}, ["task"],
             [{"if": {"properties": {"task": {"properties": {"status": {"const": "completed"}}}}}, "then": {"required": ["data"]},
               "else": {"not": {"required": ["data"]}}}]),
    response("lookup", {"outcome": {"enum": ["not_admitted", "retired", "unresolved"]}, "reason": REASON}, ["outcome"],
             [{"if": {"properties": {"outcome": {"const": "retired"}}}, "then": {"required": ["reason"]}, "else": {"not": {"required": ["reason"]}}}]),
    response("ack", {"accepted": {"const": True}, "task": task}, ["accepted", "task"]),
    response("events", {"task": task, "cursor": INT, "gap": {"type": "boolean"},
                        "events": {"type": "array", "maxItems": 200, "items": {"type": "object", "additionalProperties": False,
                                   "properties": {"sequence": POS, "type": {"type": "string", "pattern": "^[a-z][a-z0-9_.-]{0,63}$"},
                                                  "payload": {"type": "object"}}, "required": ["sequence", "type", "payload"]}}},
             ["task", "cursor", "gap", "events"]),
    response("epoch", {"schedule": {"type": "object", "additionalProperties": False,
                                    "properties": {"schedule_id": {"type": "string"}, "revision": POS, "fired_through": {"type": "integer"},
                                                   "deleted": {"type": "boolean"}}, "required": ["schedule_id", "revision", "fired_through", "deleted"]}},
             ["epoch_state"]),
    {"type": "object", "additionalProperties": False,
     "properties": {**common, "operation": {"enum": OPS}, "app": NAME, "command": NAME, "kind": {"const": "error"}, "task": task,
                    "error": {"type": "object", "additionalProperties": False,
                              "properties": {"code": {"type": "string", "pattern": "^[A-Z][A-Z0-9_]{0,63}$"},
                                             "reason": REASON, "message": {"type": "string", "maxLength": 256}}, "required": ["code"]}},
     "required": ["protocol_version", "kind", "error"]},
]
schema = {"$schema": "https://json-schema.org/draft/2020-12/schema",
          "$id": "https://app-cli.example/schemas/lifecycle-v3.schema.json",
          "title": "App-CLI lifecycle machine and runtime messages 3.0",
          "$defs": {"request": {"oneOf": requests}, "response": {"oneOf": responses}}}
for target in sys.argv[1:]:
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(schema, handle, indent=2, ensure_ascii=False); handle.write("\n")
