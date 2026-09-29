import assert from "node:assert/strict";
import test from "node:test";
import { collectUnread, discoverEmail, enumerateThread, markRead } from "../../applications/mail/read.mjs";

const interval = { lane: "recent_inbound", account_address: "owner@example.test", interval_start: "2026-09-08T00:00:00Z", interval_end: "2026-09-08T01:00:00Z", limit: 50, continuation: "" };
const baseInput = (operation, provider = "gmail") => ({ schema_version: 1, operation, provider, account: "default", owner_scope: "a".repeat(64), invocation_id: "email-test" });

function readerTab(provider, state = {}) {
  const account = state.account ?? "owner@example.test";
  const rows = state.rows ?? [{ provider_message_id: "read-message", provider_selection_id: "read-message", provider_thread_id: "thread", folder: "inbox", unread: false, draft: false, sent: false, received_at: "2026-09-08T00:30:00Z" }];
  const reader = {
    provider,
    version: "0.2.0",
    snapshot: () => ({ provider, account_address: account, rows, unsupported_rows: 0, scan_complete: false }),
    listPage: ({ page = 0 } = {}) => ({ provider, account_address: account, page, rows, unsupported_rows: 0, has_next: false, scope: "inbound_received", folder: "inbox" }),
    prepareOriginal: () => ({ selector: "#sparkclaw-mail-original", bytes: 0, account_address: account, provider_message_id: "read-message" }),
    markRead: () => ({ provider, account_address: account, provider_message_id: "read-message", read_state: "read" }),
  };
  return { runReadCode: async code => {
    if (code.includes("confirmOriginal")) return true;
    const method = /"method":"([^"]+)"/u.exec(code)?.[1];
    if (method && typeof reader[method] === "function") {
      const start = code.lastIndexOf("},") + 2;
      const end = code.lastIndexOf(")");
      const request = JSON.parse(code.slice(start, end));
      return reader[method](request);
    }
    if (code.includes("reader.listPage(request)")) {
      const start = code.lastIndexOf("},") + 2;
      const end = code.lastIndexOf(")");
      const request = JSON.parse(code.slice(start, end));
      return reader.listPage(request);
    }
    return null;
  } };
}

test("network capture selects an already-read message inside the requested interval", async () => {
  const selected = [];
  const result = await collectUnread(readerTab("gmail"), "gmail", { account_address: interval.account_address, discovery_options: interval, onSelected: async message => selected.push(message) });
  assert.equal(result.provider_message_id, "read-message");
  assert.equal(result.read_state, "read");
  assert.equal(result.network_original, true);
  assert.deepEqual(selected.map(message => message.provider_message_id), ["read-message"]);
});

test("network capture requires an interval for an unpinned message", async () => {
  await assert.rejects(collectUnread(readerTab("gmail"), "gmail", { account_address: "owner@example.test", onSelected: async () => {} }), { code: "email_network_interval_required" });
});

test("network discovery rejects the retired unread lane and missing interval", async () => {
  const tab = readerTab("gmail");
  await assert.rejects(discoverEmail({ ...baseInput("discover"), discovery: { ...interval, lane: "unread" } }, { withReadTab: callback => callback(tab) }, "gmail"), { code: "invalid_request" });
  await assert.rejects(discoverEmail({ ...baseInput("discover"), discovery: { ...interval, interval_start: undefined } }, { withReadTab: callback => callback(tab) }, "gmail"), { code: "invalid_request" });
});

test("network discovery returns account identity and interval candidates without DOM access", async () => {
  const result = await discoverEmail({ ...baseInput("discover"), discovery: interval }, { withReadTab: callback => callback(readerTab("gmail")) }, "gmail");
  assert.equal(result.account_address, "owner@example.test");
  assert.deepEqual(result.candidates.map(target => target.provider_message_id), ["read-message"]);
  assert.equal(result.coverage.scope, "inbound_received");
  assert.equal(result.coverage.lane, "recent_inbound");
});

test("bootstrap discovery obtains the account from the network snapshot", async () => {
  const result = await discoverEmail(baseInput("discover", "qq_mail"), { withReadTab: callback => callback(readerTab("qq_mail")) }, "qq_mail");
  assert.equal(result.account_address, "owner@example.test");
  assert.equal(result.coverage.scope, "account");
});

test("mark-read is a separate network capability", async () => {
  const result = await markRead(readerTab("gmail"), "gmail", { account_address: "owner@example.test", provider_message_id: "read-message" });
  assert.equal(result, "read");
});

test("thread enumeration uses network rows and preserves read state as evidence", async () => {
  const input = { ...baseInput("enumerate_thread"), provider: "gmail", thread: { account_address: "owner@example.test", provider_thread_id: "thread", provider_selection_id: "thread", folder: "inbox" }, continuation: "", limit: 50 };
  const tab = readerTab("gmail", { rows: [{ provider_message_id: "thread-message", provider_selection_id: "thread", provider_thread_id: "thread", folder: "inbox", unread: false, draft: false, sent: false, received_at: "2026-09-08T00:30:00Z" }] });
  const result = await enumerateThread(input, { withReadTab: callback => callback(tab) }, "gmail");
  assert.equal(result.members.length, 1);
  assert.equal(result.members[0].read_state, "read");
  assert.equal(result.coverage.scope, "thread");
});
