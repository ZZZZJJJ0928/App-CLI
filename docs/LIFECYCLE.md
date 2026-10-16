# Lifecycle contract 3.0

[简体中文](LIFECYCLE.zh-CN.md)

This fork extends the existing Registry and Adapter boundary. Runtime protocol
1.0 and legacy CLI envelopes remain unchanged. The public JSON contract is
[the lifecycle schema](../schemas/lifecycle-v3.schema.json); its package copy is
checked for byte parity. No browser/mail integration is claimed by this contract.

A reviewed registration binds an app's manifest digest, implementation identity,
conformance evidence, supported operations and renewable commands. Implementing
`invoke_lifecycle(request, context)` alone does not enable mutation: Registry
requires that explicit registration and an injected trusted authorization provider.
There is no adapter import, endpoint, executable or approval flag in business input.
RuntimeAdapter 3.0 is a transport implementation, not the authority for other
adapters' admission. A native adapter can implement the same interface.

`app-cli --machine` reads one bounded UTF-8 JSON request on stdin. It cannot be
mixed with legacy options. Requests are at most 2 MiB, serialized arguments at
most 1.5 MiB, and responses at most 1 MiB. Duplicate keys, non-finite numbers,
unpaired surrogates and integers outside JavaScript's safe range are rejected.
The legacy CLI retains its old numeric behavior. Native failures are sanitized.

Operations are prepare, invoke, lookup, status, cancel, resume, renew, events,
reconcile, ack_result, resolve and epoch. Each supplies app, command and an opaque
authorization_ref. prepare supplies a stable request_key and arguments, plus
deadline_ms unless the command is explicitly renewable; it durably admits the
task without side effects. invoke starts that prepared task by task_id. lookup
supplies the original request_key. Other task operations supply the original
task_id; events also supplies cursor and optional limit (default 100, maximum
200). ack_result binds a terminal revision and result digest to a durable
receiver; resolve records an explicit user conclusion for an uncertain external
write and never dispatches; epoch reads or changes owner-level request epochs.
Deadlines are UTC epoch milliseconds, not transport timeouts.

New request keys are `op3.<generation>.<epoch>.<32 hex>` operation identities
issued by the trusted product in the open request epoch, or
`sch3.<generation>.<epoch>.<nonce>.<revision>.<occurrence_ms>` scheduled
occurrences of a registered schedule. Epochs rotate: the runtime opens E+1 and
drains E; the product seals E once no identity it issued there is unsubmitted;
the runtime force-seals only after the offline window. An absent identity in a
sealed epoch is retired, so replay is rejected without per-request tombstones.
Pre-3.0 keys belong to the sealed legacy epoch 0.

The intent digest is SHA-256 of a deterministic, typed binary encoding of the
object containing app, command, request_key, arguments and any deadline_ms.
Each node is tag + ASCII payload-byte-length + ':' + payload. Tags: n (null,
empty payload), b (boolean 0 or 1), s (UTF-8 string), d (8-byte big-endian IEEE-754
number with negative zero normalized), a (concatenated encoded elements), o
(concatenated encoded key/value pairs, keys sorted by UTF-8 bytes). Integral
numbers must fit +/-9007199254740991; equivalent integer/float values have the
same encoding. This avoids Python/JavaScript JSON float-format differences.

Valid responses echo version, operation, app and command, plus request_key for
prepare/lookup, and the current epoch_state. kind=task carries one of ten
statuses (prepared, pending, running, waiting_confirmation, uncertain, blocked,
completed, failed, cancelled, resolved) and an ID; `effect` reports whether any
effect began (for an external write: whether a dispatch was released), and a
terminal task carries terminal_revision and result_digest for ack_result. Only
completed carries data, checked against the original command output schema.
kind=ack acknowledges cancellation or a durable receipt, not completion.
kind=events carries a bounded sequence page, cursor and explicit gap. lookup
returns the original task, or kind=lookup with not_admitted, retired (with a
reason) or unresolved. Only an authoritative intact ledger can prove
not_admitted; transport failure cannot. No operation automatically retries or
creates another business intent.

External writes reserve a dispatch, persist consume_pending, advance an
independent progress anchor by compare-and-advance and persist released before
the worker may act. A crash before release is provably undispatched and the
task stays resumable with a new attempt; only a released attempt can become
uncertain. Startup compares the ledger with the anchor and fences forward after a
whole-set rollback (sealing epochs, raising the authorization generation and
classifying unfinished external writes).

A machine-level failure is kind=error with a sanitized error code/message and,
when available, the original request_key/task metadata. It is distinct from a
valid task outcome. A valid control response exits 0 even for pending or failed
business state; input errors exit 2, transport/execution errors 1, interruption
130. The legacy execute APIs retain their incomplete-task errors.

The backend owns durable admission, exact intent binding, task recovery, target
serialization, execution epochs, cancellation and independent reconciliation.
It must not declare completion from a mere transport acknowledgement. Expired
leases cannot be revived; renew is only for active renewable tasks, resume for
original blocked/waiting tasks. Support for those transitions must be qualified
by the concrete backend, not inferred from schema acceptance.

## Implemented scope and qualification

The core implements machine parsing, reviewed lifecycle registration, trusted
provider admission and response/output validation. RuntimeAdapter 3.0 sends one
request to a fixed executable with bounded stdout and a maximum 30-second client
budget, killing its POSIX process group on completion/failure. This transport is
currently enabled only on POSIX; v1 and native adapters retain their portability.
The transport is for reviewed clients, not a sandbox for escaping executables.

The default installed CLI has no lifecycle registrations or grant resolver and
fails closed. Integrators construct Registry with `lifecycle=[...]` and a trusted
`authorization` provider, then use `Registry.control()` or inject that registry
into `cli.main`. No automatic module loading, user-supplied executable or generic
--allow-write switch is provided.

The independent native/Runtime fixtures transact a synthetic counter and original
task together in SQLite. Tests cover concurrent replay, intent drift, expired
execution versus access authority, wrong owners, original output validation,
and response loss after durable commit. Fixtures are not shipped as production
mail adapters. The optional [application runtime](APPLICATION-RUNTIME.md) now implements the
Node Executor, execution-binding/BrowserHostPort schemas, epoch handoff, watch
renewal, provider implementations and SparkClaw consumption. Its own runtime,
Host and product integration tests qualify those boundaries separately.
`APP_CLI_CONFIG` enables the signed, explicit deployment assembly; without it,
the default installation still exposes only the original reference commands.
