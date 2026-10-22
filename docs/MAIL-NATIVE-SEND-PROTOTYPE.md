# Mail learning windows and QQ replay prototype

[简体中文](MAIL-NATIVE-SEND-PROTOTYPE.zh-CN.md)

This is a local prototype, disabled by default. It has not been qualified with
live provider sends. Existing compose/reply/attachment behavior stays on the
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
flow. The prototype does not create resident mutation pages or change the Host
page lifecycle; deployments that close each send page cannot reuse the template.

Only a new plain-text compose to one recipient with no cc or attachments is
eligible. The observed `/send/sendmail` form must contain exactly the 18 known
field names. Duplicate/unknown fields, bcc, attachment/reply metadata, resumed
messages, calendar actions, receipt requests, sender mismatch, unknown content
types and redirects are refused. Field values and recipient encoding assumptions
in the offline fixtures still need live qualification.

Template learning is separate from shape recording: it must be explicitly armed
for an eligible send, and the existing DOM sent-evidence check must complete
before `confirmSendTemplate` promotes it. Confirmation also checks the observed
recipient and subject. Session fields remain only in page memory; the old
recipient, subject, content and draft ID are removed. Expiry, account changes and
disposal clear the template. Each confirmed template can dispatch only once.

The replay substitutes the new recipient, subject and escaped content, clears
the old draft ID, and uses the page's same-origin fetch with a 30-second timeout
and redirects disabled. Dispatch still follows the existing authority release
and durable create-only send journal. After dispatch there is no DOM fallback
or automatic retry, including after a lost response, restart or reconciliation.

**Every prototype dispatch remains `unknown`, including HTTP 200 / `ret=0`.**
The actual send response identifier and independent native Sent lookup have not
been qualified, so the prototype cannot issue a `sent` receipt. This deliberately
limits the prototype to exercising request construction and dispatch semantics;
it does not establish delivery or the proposed latency improvement.

## Local validation and next gate

The tests use synthetic accounts, fake page transports and temporary journals;
they send no mail. They cover the serialized Reader and worker bridge, redaction,
bounds, window correlation, template qualification/expiry, parameter replacement,
concurrent attempts, authorization rejection, and restart/reconcile without a
second dispatch. Existing DOM send and receive tests remain in the runtime suite.

Before enabling real replay, obtain approval for deployment and fresh test sends,
record actual response shapes, identify a provider message ID, and verify that
same ID using an independent native Sent read. Validate session expiry and
same-page reuse as well. Do not retry historical unknown mail. Replies,
attachments, Outlook replay and Gmail replay are outside this prototype.

Validation on 2026-10-22 (macOS, Node 26.2.0, Python 3.11): runtime **508/508**
with `--test-concurrency=1` and recovery cases enabled; Python **90/90**;
generated userscripts/bindings and public-tree checks pass. On this Mac, tests
need a canonical temporary directory (`TMPDIR=/private/tmp`); the default
symlinked temporary path fails existing capture checks on the unchanged base.
Two short-deadline executor cases also fail when baseline and candidate suites
run concurrently; the complete serial candidate run passes without skips.
