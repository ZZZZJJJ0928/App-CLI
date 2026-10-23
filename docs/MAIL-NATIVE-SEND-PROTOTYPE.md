# Mail learning windows and the maintained native send

[简体中文](MAIL-NATIVE-SEND-PROTOTYPE.zh-CN.md)

QQ new-compose sends use a maintained request template, `qq_sendmail_v1`,
instead of a template learned from a DOM send. Replies, cc, attachments, Gmail
and Outlook keep the managed DOM path until each has its own template. The
learning window below remains for request-shape evidence only; it no longer
teaches or confirms any send.

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

## Network-native send

The send runtime splits the native send into a provider-independent flow
(`lib/native-send.mjs`) and provider modules. A provider module supplies the
scope, the recovery page, the template version and the explicit rejection-code
list; its page side implements `nativeSendPreflight`, `nativeSendDispatch` and
`nativeSendLookup` on the Reader. QQ is the first module (`lib/qq-native-send.mjs`,
`userscripts/lib/qq-sendmail-v1.mjs`). `lib/native-send-config.mjs` is the
release configuration: whether a provider's native send is enabled and whether
its response identifier becomes the receipt's `provider_message_id`. There is no
environment override; `APP_CLI_MAIL_NATIVE_SEND` is retired.

Scope (QQ v1): a new plain-text compose to one recipient with no cc and no
attachments, at most 200 KiB of body. Everything else uses the DOM flow. A v1
message never uses a DOM send to obtain a template and never falls back to one.

Normal path, two page calls through the host's guarded code request
(`runCodeRequest`: a fixed page function plus a private `argument`, so message
content is never part of any argument list):

1. `preflight` carries no message content. A reused page must still hold the
   admitted document nonce; a cold page waits inside the call, at most 5 s, for
   the Reader and the signed-in account. It checks a visible login page, the
   account (case-insensitive) and the template preconditions (QQ: origin
   `https://wx.mail.qq.com`, path `/home/index`, a sid, a short `window.lang`)
   and returns a one-use ticket valid for 60 s. A page, Reader or precondition
   failure gets one recovery navigation and one more preflight, then
   `email_native_send_unavailable`. All of this precedes the dispatch release.
2. The executor releases the dispatch and the `dispatching` journal entry is
   written. `dispatch` carries the ticket and the content once. The page checks
   the ticket (token, document, account, expiry) and otherwise answers
   `refused_before_request`; then it submits one `fetch` with a 25 s timeout.

QQ's form follows its own `sendMail`/`k(e)` builder and `post()` parameters:
`func=1`, `mailid=`, QQ's two time-zone formulas, `calendar=`, subject, body,
`is_text/is_urgent/is_resume/need_receipt=false`, `from` = the checked account,
`save_to_send=true`, `separated_copy=false`, `to`, `language`, QQ's `r` formula
and the sid. The body follows the editor's plain-text rule (leading/trailing
space and space runs to no-break spaces, tabs to 6-column EN-space stops, one
`<div>` per line, `<div><br></div>` for an empty line). The sid is taken like
QQ's `ee()`: cookie `xm_muti_sid`/`xm_uin`/`xm_sid` for the current uin first,
the address bar only as a fallback; it never leaves the page.

Only the response decides the result:

- accepted: HTTP 200 from the request URL, JSON of at most 1 MiB, `head.ret`
  0, valid `body.mailid` and `body.messageid`, and the same account after the
  response. The receipt is `sent`; it carries `provider_message_id` only when
  the release switch is on. The private journal keeps both IDs, the template
  version, timings and the front-end drift signal.
- explicitly rejected: one of QQ's 12 listed codes (login `-5012 -20002 -20062
  -20071 -21021`, parameter `-20011 -21101 -5151 -21501 -21132`, temporary
  `-21519 -20003`). The result is `status: completed` with
  `{status: not_sent, not_sent: {kind: provider_rejected, reason, provider_code}}`
  bound to the original task, and the journal replaces `dispatching` with
  `not_sent` atomically. A login rejection invalidates the page.
- pending confirmation: anything else (network error, timeout, non-200,
  non-JSON, missing IDs, account change, unlisted code, refused ticket). One
  separate `lookup` call polls Sent for at most 12 s; only a unique match (by
  `messageid` when known, otherwise rows not older than the dispatch time in
  QQ's server time minus 120 s) becomes `sent` with `qq_sent_list_v1` proof.
  Otherwise the task stays uncertain. Nothing is ever resent.

After a decided result the page is parked as is: no `setSecrets`, round reset,
DOM cleanup or navigation. The send's provider-script contract declares
`send_admission: in_page`, so the consumer may admit it from persisted state
instead of a pre-send probe.

`APP_CLI_MAIL_SEND_EVIDENCE=1` logs the path, outcome, recovery, reason codes,
provider codes and bounded request/lookup milliseconds, without message values,
sids or IDs.

## Local validation and next gate

The tests use synthetic accounts, a VM page with the real Reader and template,
a stand-in QQ server and temporary journals; they send no mail. They pin the
field set and every value rule, time zones including DST, body conversion, sid
priority and disagreement, every success-condition counterexample, the 12 codes
and codes outside the list, login page versus unreadable account,
`refused_before_request`, the lookup's time bound and uniqueness, no DOM
fallback, no content outside the dispatch argument, no resend after any
outcome, and reconcile of a `provider_rejected` receipt.

Live qualification still needs owner-approved test messages: a first message
on a cold page, a second on the warm page and a third after a reload; and checks
that `mailid` equals the Sent row's `emailid`, that the `from` display name and
body whitespace look as they do for a DOM send. Only then may the
`provider_message_id` switch be enabled. Historical unknown mail is never retried.
