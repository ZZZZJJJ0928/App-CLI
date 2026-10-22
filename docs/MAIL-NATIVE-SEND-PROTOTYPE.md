# Mail learning windows and QQ replay prototype

[简体中文](MAIL-NATIVE-SEND-PROTOTYPE.zh-CN.md)

This prototype is disabled by default. A fresh authorized QQ DOM send on
2026-10-22 established the real request and response schemas; replay qualification
is recorded separately from that baseline. Existing compose/reply/attachment behavior stays on the
managed DOM path. No new public command or output schema is introduced.

## Learning evidence

The Reader's `armLearning` window now records bounded response structure for
same-origin XHR/fetch mutations and Outlook Worker/MessagePort operations.
Outlook send bindings install the early worker hook before navigation. The hook
observes the site's requests and callbacks without acknowledging, consuming or
replaying them. Request IDs are used only in page memory for correlation.

A request must start in the current window; a late response from an earlier
window is excluded. Each window lasts at most 120 seconds and holds at most
24 records. Response reads are limited to 1 MiB and five seconds, including
chunked responses. Structure traversal is bounded by depth, width and node
count; entries are capped at 8 KiB. Known structural keys and value types/size
classes are recorded; unfamiliar response keys collapse to `dynamic_key`.
JSON/XSSI, text, markup, empty and oversized responses are distinguished.
Mail text, addresses, tokens, request IDs and response values are not evidence.
`APP_CLI_MAIL_LEARNING_EVIDENCE=1` logs the shapes after the managed operation.

## QQ replay scope

`APP_CLI_MAIL_NATIVE_SEND=qq_mail` opts the managed adapter into this prototype.
It requires a still-open QQ page with a previously learned and independently
confirmed DOM send from the same account. A cold page uses the existing DOM
flow. A successful QQ send can retain its separate account/credential/binding
pool for at most 120 seconds, only while a confirmed one-use template is ready.
Message secret slots, Reader records and application-owned DOM references are
cleared before parking. The next lease must prove the same document and account;
its active authority replaces the previous lease before reloading secrets.

Only a new plain-text compose to one recipient with no cc or attachments is
eligible. The observed `/send/sendmail` form must contain exactly the 18 known
field names. Duplicate/unknown fields, bcc, attachment/reply metadata, resumed
messages, calendar actions, receipt requests, sender mismatch, unknown content
types and redirects are refused. The observed send uses `func=1`, string `false`
for the five optional-mode flags, and `save_to_send=true`. Autosave uses `func=2`
and cannot teach or invalidate an actual send template. The subject/body together
with the remaining message input must fit a 48 KiB JSON envelope for native
replay; larger messages retain the DOM path.

Template learning is separate from shape recording: it must be explicitly armed
for an eligible send, and the existing DOM sent-evidence check must complete
before `confirmSendTemplate` promotes it. Confirmation also checks the observed
recipient and subject, then independently queries Sent to join the response
`body.messageid` to the DOM-proved `emailid`. Session fields remain only in page memory; the old
recipient, subject, content and draft ID are removed. Expiry, account changes and
disposal clear the template. Each confirmed template can dispatch only once.

The replay substitutes the new recipient, subject and escaped content, clears
the old draft ID, and uses the page's same-origin fetch with a 30-second timeout
and redirects disabled. Dispatch still follows the existing authority release
and durable create-only send journal. After dispatch there is no DOM fallback
or automatic retry, including after a lost response, restart or reconciliation.

A replay first reads a fresh Sent baseline, sends once, then performs up to five
independent read-only Sent polls. A successful `head.ret=0` and bounded
`body.messageid` are necessary but insufficient. Exactly one fresh row must have
that `messageid`, `dirid=3`, a valid new `emailid`, and the exact expected subject,
single sender and single recipient. The observed Sent request is POST
`/list/maillist` with the page-local session, folder 3, page 0 and page size 50.
The public receipt uses its `emailid` as `provider_message_id`; the private durable
send journal stores both ID namespaces and the matching proof. No public schema
change is needed. Missing, ambiguous, stale, redirected or mismatched evidence
remains `unknown`. Reconciliation reads the original receipt, never sends again.

`APP_CLI_MAIL_SEND_EVIDENCE=1` logs bounded total/send-request/Sent-verification
milliseconds and the selected DOM/native path, without message values or IDs.

## Local validation and next gate

The tests use synthetic accounts, fake page transports and temporary journals;
they send no mail. They cover the serialized Reader and worker bridge, redaction,
bounds, window correlation, template qualification/expiry, parameter replacement,
concurrent attempts, authorization rejection, and restart/reconcile without a
second dispatch. Existing DOM send and receive tests remain in the runtime suite.

Deployment and fresh brief test sends were explicitly authorized on 2026-10-22.
The DOM baseline took 64.935 seconds end to end, including a 367 ms send request.
An independent Sent response joined the IDs 1.209 seconds after the send response;
a later native search also matched sender, recipient and subject. The 92 historical
unknown rows were preserved. Live replay and the installed paired release require
their own evidence; a successful DOM baseline does not establish replay latency. Do not retry historical unknown mail. Replies,
attachments, Outlook replay and Gmail replay are outside this prototype.

Validation on 2026-10-22 (macOS, Node 26.2.0, Python 3.11): runtime **508/508**
with `--test-concurrency=1` and recovery cases enabled; Python **90/90**;
generated userscripts/bindings and public-tree checks pass. On this Mac, tests
need a canonical temporary directory (`TMPDIR=/private/tmp`); the default
symlinked temporary path fails existing capture checks on the unchanged base.
Two short-deadline executor cases also fail when baseline and candidate suites
run concurrently; the complete serial candidate run passes without skips.
