import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import vm from "node:vm";

import { GMAIL_SEND_SELECTORS } from "../../applications/mail/gmail-send.mjs";
import { QQMAIL_LOGIN_PROBE_SELECTORS } from "../../applications/mail/qqmail-login-probe.mjs";
import { QQMAIL_SELECTORS, QQMAIL_SENT_BASELINE_EXPRESSION, QQMAIL_SENT_VERIFICATION_EXPRESSION } from "../../applications/mail/qqmail-send.mjs";
import { OUTLOOK_SEND_SELECTOR, OUTLOOK_SEND_VERIFICATION_EXPRESSION, OUTLOOK_RECIPIENT_STATE_EXPRESSION, OUTLOOK_SENT_BASELINE_EXPRESSION } from "../../applications/mail/outlook-send.mjs";
import { createProviderRuntime } from "../../applications/mail/runtime/mail-page.mjs";
import { ProviderScriptRegistry } from "../../applications/mail/runtime/provider-scripts.mjs";

const CASES = Object.freeze([
  { provider: "qq_mail", adapter: "qq", probe: "qqmail.login_probe", send: "qqmail.send" },
  { provider: "outlook", adapter: "outlook", probe: "outlook.login_probe", send: "outlook.send" },
  { provider: "gmail", adapter: "gmail", probe: "gmail.login_probe", send: "gmail.send" },
]);

test("all provider probes execute through their injected Playwright runtime adapter", async () => {
  const registry = new ProviderScriptRegistry();
  await registry.prepare();

  for (const providerCase of CASES) {
    const registration = registry.resolve({
      provider: providerCase.provider,
      operation: "probe",
      scriptID: providerCase.probe,
      revision: 1,
    });
    const input = probeInput(providerCase.provider);
    const client = new ProviderRuntimeFixture(registration, input);

    registration.validate(input);
    const result = await registration.handler(
      input,
      createProviderRuntime(client, registration),
    );

    assert.equal(result.status, "ready", providerCase.provider);
    assert.equal(result.provider, providerCase.provider, providerCase.provider);
    assert.equal(client.adapter, providerCase.adapter, providerCase.provider);
    assert.equal(client.effectAttempted, false, providerCase.provider);
    client.assertAdapterLifecycle();
  }
});

test("all email registrations preserve background execution", async () => {
  const registry = new ProviderScriptRegistry();
  await registry.prepare();
  for (const providerCase of CASES) {
    for (const operation of ["probe", "send"]) {
      const registration = registry.resolve({ provider: providerCase.provider, operation,
        scriptID: providerCase[operation], revision: 1 });
      assert.notEqual(registration.visibleWindow, true);
    }
  }
});

test("QQ Mail probe owns a bounded signed-in CLI budget and preserves timeout classification", async () => {
  const registry = new ProviderScriptRegistry();
  await registry.prepare();
  const registration = registry.resolve({
    provider: "qq_mail",
    operation: "probe",
    scriptID: "qqmail.login_probe",
    revision: 1,
  });
  const client = {
    qqTask: () => ({
      onTab: async () => {
        throw Object.assign(new Error("private controller detail"), {
          code: "browser_script_timeout",
        });
      },
    }),
  };

  assert.equal(registration.timeoutMS, 90_000);
  await assert.rejects(
    registration.handler(
      probeInput("qq_mail"),
      createProviderRuntime(client, registration),
    ),
    (error) => error.code === "login_probe_timeout",
  );
});

test("all provider sends use the registered effect selector exactly once", async () => {
  const registry = new ProviderScriptRegistry();
  await registry.prepare();

  for (const providerCase of CASES) {
    const registration = registry.resolve({
      provider: providerCase.provider,
      operation: "send",
      scriptID: providerCase.send,
      revision: 1,
    });
    const input = sendInput(providerCase.provider);
    const client = new ProviderRuntimeFixture(registration, input);

    registration.validate(input);
    const result = await registration.handler(
      input,
      createProviderRuntime(client, registration),
    );

    assert.equal(result.status, "sent", providerCase.provider);
    assert.equal(result.provider, providerCase.provider, providerCase.provider);
    assert.equal(result.recipient_digest, recipientDigest(input.message.recipient));
    assert.equal(client.adapter, providerCase.adapter, providerCase.provider);
    assert.equal(client.effectAttempted, true, providerCase.provider);
    assert.deepEqual(client.effectSelectors, [registration.effectSelector], providerCase.provider);
    client.assertAdapterLifecycle();
  }
});

test("send runtime exposes separate mailbox navigation for reply target lookup", async () => {
  const calls = [];
  const registration = { operation: "send", provider: "gmail" };
  const client = {
    gmailTab: () => ({ inspect: async () => ({}) }),
    runReadCode: async code => { calls.push(code); return true; },
    waitFor: async selector => { calls.push(selector); return true; },
  };
  const runtime = createProviderRuntime(client, registration);
  const tab = await runtime.withSendTab(value => value);
  await tab.navigate("https://mail.google.com/mail/u/0/#all");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /page\.goto\("https:\/\/mail\.google\.com\/mail\/u\/0\/#all"\)/u);
  await tab.waitFor('.mail-list-page');
  assert.equal(calls[1], '.mail-list-page');
});

test("QQ draft rejects extra recipients and changed body before Send", async () => {
  const registry = new ProviderScriptRegistry();
  await registry.prepare();
  const registration = registry.resolve({ provider: "qq_mail", operation: "send", scriptID: "qqmail.send", revision: 1 });
  for (const failure of ["extra_recipient", "changed_body", "uncommitted_recipient"]) {
    const input = sendInput("qq_mail");
    const client = new ProviderRuntimeFixture(registration, input);
    const command = client.qqCommand.bind(client);
    client.qqCommand = args => {
      const result = command(args);
      if (failure === "extra_recipient" && args[1] === "count" && args[2] === QQMAIL_SELECTORS.allRecipientChips) result.count = 2;
      if (failure === "changed_body" && args[1] === "lines") result.text += "unexpected";
      if (failure === "uncommitted_recipient" && args[1] === "value" && args[2] === QQMAIL_SELECTORS.recipient && client.qqRecipientCommitted) result.value = "remaining@example.test";
      return result;
    };
    await assert.rejects(registration.handler(input, createProviderRuntime(client, registration)), { code: "draft_verification_failed" });
    assert.equal(client.effectAttempted, false);
  }
});

test("Gmail rejects extra, changed and uncommitted recipients before Send", async () => {
  const registry = new ProviderScriptRegistry();
  await registry.prepare();
  const registration = registry.resolve({ provider: "gmail", operation: "send", scriptID: "gmail.send", revision: 1 });
  for (const failure of ["extra", "changed", "uncommitted"]) {
    const input = sendInput("gmail");
    const client = new ProviderRuntimeFixture(registration, input);
    const original = client.gmailTab.bind(client);
    client.gmailTab = () => {
      const tab = original();
      if (failure === "extra") {
        const count = client.gmailCount.bind(client);
        client.gmailCount = selector => selector === GMAIL_SEND_SELECTORS.recipientChip ? 2 : count(selector);
      }
      if (failure === "changed") client.gmailAttribute = () => "wrong@example.test";
      if (failure === "uncommitted") tab.press = async () => { client.gmailRecipientCommitted = true; };
      return tab;
    };
    await assert.rejects(registration.handler(input, createProviderRuntime(client, registration)), { code: "email_send_precondition_failed" });
    assert.equal(client.effectAttempted, false);
  }
});

test("QQ confirms a new matching sent record, not an old message or another folder", async () => {
  for (const scenario of ["sent", "empty", "old", "wrong_subject", "compose_open", "inbox", "missing", "unrelated_insert"]) {
    let now = 0;
    const first = {
      getAttribute: () => scenario === "old" ? "old" : "new",
      getBoundingClientRect: () => ({ width: 20, height: 20 }),
      querySelector: () => ({ textContent: scenario === "wrong_subject" ? "wrong" : "subject" }),
    };
    const rows = scenario === "missing" ? [] : scenario === "empty" ? [first] :
      [first, { getAttribute: () => scenario === "unrelated_insert" ? "other" : "old" }];
    const verify = vm.runInNewContext(QQMAIL_SENT_VERIFICATION_EXPRESSION, {
      Date: { now: () => now }, setTimeout: callback => { now += 6000; callback(); },
      crypto: crypto.webcrypto, TextEncoder, Uint8Array,
      location: { hash: scenario === "inbox" ? "#/list/1" : "#/list/3" },
      getComputedStyle: () => ({ visibility: "visible" }),
      document: { querySelectorAll: () => rows, querySelector: () => scenario === "compose_open" ? first : null },
    });
    const result = await verify({ ids: scenario === "empty" ? [] : ["old"],
      subject: crypto.createHash("sha256").update("subject").digest("hex"), emptySubject: false });
    assert.equal(result.sent_evidence, ["sent", "empty"].includes(scenario), scenario);
  }
});

test("Outlook confirms only a newly inserted matching sent item after compose closes", async () => {
  const hash = text => crypto.createHash("sha256").update(text).digest("hex");
  for (const scenario of ["sent", "empty", "old", "wrong_recipient", "wrong_subject", "open", "inbox", "missing", "unrelated_insert"]) {
    let now = 0;
    const row = { id: scenario === "old" ? "old" : "new", isConnected: true,
      getBoundingClientRect: () => ({ width: 20, height: 20 }),
      querySelectorAll: () => [scenario === "wrong_recipient" ? "wrong@example.test" : "one@example.test", scenario === "wrong_subject" ? "wrong" : "subject"].map(textContent => ({ textContent, children: [] })),
    };
    const inspect = vm.runInNewContext(OUTLOOK_SEND_VERIFICATION_EXPRESSION, {
      Date: { now: () => now += 6000 }, setTimeout, crypto: crypto.webcrypto, TextEncoder, Uint8Array,
      window: { location: { href: "https://outlook.live.com/mail/0/sentitems", pathname: scenario === "inbox" ? "/mail/0/inbox" : "/mail/0/sentitems" }, getComputedStyle: () => ({}) },
      document: { querySelectorAll: selector => selector.includes('[data-convid]') ? scenario === "missing" ? [] : scenario === "empty" ? [row] : [row, {id: scenario === "unrelated_insert" ? "unexpected" : "old"}] : scenario === "open" ? [row] : [] },
    });
    const result = await inspect({ids: scenario === "empty" ? [] : ["old"], recipient: hash("one@example.test"), subject: hash("subject")});
    assert.equal(result.sent_evidence, ["sent", "empty"].includes(scenario), scenario);
  }
});

test("Outlook recipient state rejects pending text and extra chips", () => {
  for (const [pending, inField, total, expected] of [["\u200b", 1, 1, true], ["other@example.test", 1, 1, false], ["", 0, 0, false], ["", 1, 2, false]]) {
    const field = {
      querySelectorAll: () => Array(inField),
      cloneNode: () => ({ textContent: pending, querySelectorAll: () => [] }),
    };
    const inspect = vm.runInNewContext(OUTLOOK_RECIPIENT_STATE_EXPRESSION, {
      document: { querySelector: () => field, querySelectorAll: () => Array(total) },
    });
    assert.equal(inspect().valid, expected);
  }
});

test("Outlook batch rejects modified fields and a disabled or ambiguous Send control", async () => {
  const registry = new ProviderScriptRegistry();
  await registry.prepare();
  const registration = registry.resolve({ provider: "outlook", operation: "send", scriptID: "outlook.send", revision: 1 });
  for (const failure of ["recipient", "subject", "body", "send_count", "disabled"]) {
    const input = sendInput("outlook");
    const client = new ProviderRuntimeFixture(registration, input);
    const original = client.outlookTab.bind(client);
    client.outlookTab = () => {
      const tab = original();
      const read = tab.readMany;
      tab.readMany = async commands => {
        const values = await read(commands);
        if (failure === "recipient") values[0].value = "wrong@example.test";
        if (failure === "subject") values[1].value += " changed";
        if (failure === "body") values[2].text += " changed";
        if (failure === "send_count") values[3].count = 2;
        if (failure === "disabled") values[4].enabled = false;
        return values;
      };
      return tab;
    };
    await assert.rejects(registration.handler(input, createProviderRuntime(client, registration)));
    assert.equal(client.effectAttempted, false, failure);
  }
});

class ProviderRuntimeFixture {
  constructor(registration, input) {
    this.registration = registration;
    this.input = input;
    this.adapter = "";
    this.effectAttempted = false;
    this.effectSelectors = [];
    this.fields = new Map();
    this.qqComposeOpen = false;
    this.qqSent = false;
    this.outlookInspectCalls = 0;
    this.outlookActCalls = 0;
    this.gmailOpened = 0;
    this.gmailClosed = 0;
    this.gmailDisposed = 0;
    this.gmailComposeOpen = false;
    this.gmailRecipientCommitted = false;
    this.gmailSent = false;
  }

  qqTask() {
    this.adapter = "qq";
    return {
      onTab: async (commands) => commands.map((command) => ({
        success: true,
        result: this.qqCommand(command),
      })),
    };
  }

  outlookTab() {
    this.adapter = "outlook";
    return {
      inspect: async (expression) => {
        this.outlookInspectCalls += 1;
        if (expression === OUTLOOK_RECIPIENT_STATE_EXPRESSION) return { result: { valid: true } };
        if (expression === OUTLOOK_SENT_BASELINE_EXPRESSION) return { result: { ids: ["old"] } };
        return outlookProbeEvidence();
      },
      act: async (command) => {
        this.outlookActCalls += 1;
        return this.outlookCommand(command);
      },
      readMany: async commands => commands.map(command => this.outlookCommand(command)),
    };
  }

  gmailTab() {
    this.adapter = "gmail";
    return {
      open: async () => { this.gmailOpened += 1; },
      inspect: async () => ({
        origin: "https://mail.google.com/mail/u/0/#inbox",
        result: {
          url: "https://mail.google.com/mail/u/0/#inbox",
          compose_visible: true,
          account_label: "Google Account: Person (person@example.test)",
        },
      }),
      getUrl: async () => "https://mail.google.com/mail/u/0/#inbox",
      getCount: async (selector) => this.gmailCount(selector),
      getAttribute: async (selector, attribute) => this.gmailAttribute(selector, attribute),
      getValue: async (selector) => this.fields.get(selector) ?? "",
      getText: async (selector) => this.gmailText(selector),
      readMany: async commands => commands.map(([, subtype, selector, attribute]) => {
        if (subtype === "count") return { count: this.gmailCount(selector) };
        if (subtype === "attr") return { value: this.gmailAttribute(selector, attribute) };
        if (subtype === "text") return { text: this.gmailText(selector) };
        if (subtype === "value") return { value: this.fields.get(selector) ?? "" };
        if (subtype === "enabled") return { enabled: true };
        throw new Error("unsupported Gmail read");
      }),
      waitFor: async () => {},
      click: async (selector) => this.gmailClick(selector),
      fill: async (selector, value) => { this.fields.set(selector, value); },
      focus: async () => {},
      press: async () => {
        this.gmailRecipientCommitted = true;
        this.fields.set(GMAIL_SEND_SELECTORS.recipientInput, "");
      },
      closeOwnedTab: async () => { this.gmailClosed += 1; },
      dispose: async () => { this.gmailDisposed += 1; },
    };
  }

  qqCommand(command) {
    const [name, subtype, selector] = command;
    if (name === "eval") {
      const expression = Buffer.from(selector, "base64").toString("utf8");
      return { result: expression === QQMAIL_SENT_BASELINE_EXPRESSION ? { ids: ["old"] } : { sent_evidence: true }, origin: this.qqURL() };
    }
    if (name === "get" && subtype === "url") return { url: this.qqURL() };
    if (name === "get" && subtype === "count") {
      return { count: this.qqCount(selector), selector };
    }
    if (name === "get" && ["text", "lines"].includes(subtype)) {
      return { text: this.qqText(selector), origin: this.qqURL() };
    }
    if (name === "get" && subtype === "value") {
      return { value: this.fields.get(selector) ?? "", origin: this.qqURL() };
    }
    if (name === "is" && subtype === "visible") {
      return { visible: this.qqVisible(selector), origin: this.qqURL() };
    }
    if (name === "is" && subtype === "enabled") {
      return { enabled: true, origin: this.qqURL() };
    }
    if (name === "click") {
      if (subtype === QQMAIL_SELECTORS.composeButton) this.qqComposeOpen = true;
      if (subtype === this.registration.effectSelector) {
        this.markEffect(subtype);
        this.qqComposeOpen = false;
        this.qqSent = true;
      }
      return { clicked: subtype };
    }
    if (name === "fill") {
      if (subtype === QQMAIL_SELECTORS.subject) {
        assert.equal(this.qqRecipientCommitted, true, "resolve QQ recipient before filling subject");
      }
      this.fields.set(subtype, selector);
      return { filled: subtype };
    }
    if (name === "focus") {
      if (subtype === QQMAIL_SELECTORS.subject) {
        this.qqRecipientCommitted = true;
        this.fields.set(QQMAIL_SELECTORS.recipient, "");
      }
      return { focused: subtype };
    }
    if (name === "press") {
      if (subtype === "Tab") {
        this.qqRecipientCommitted = true;
        this.fields.set(QQMAIL_SELECTORS.recipient, "");
      }
      return { pressed: subtype };
    }
    if (name === "wait") {
      if (subtype === QQMAIL_SELECTORS.recipientChip) {
        assert.equal(this.qqRecipientCommitted, true, "QQ recipient commits on blur");
      }
      return { waited: subtype };
    }
    throw new Error(`unsupported QQ Mail command: ${JSON.stringify(command)}`);
  }

  qqURL() {
    if (this.qqSent) return "https://wx.mail.qq.com/home/index#/list/3";
    if (this.qqComposeOpen) return "https://wx.mail.qq.com/home/index#/compose/new";
    return "https://wx.mail.qq.com/home/index";
  }

  qqCount(selector) {
    if (selector === QQMAIL_SELECTORS.loginPage) return 0;
    if (Object.values(QQMAIL_LOGIN_PROBE_SELECTORS).includes(selector)) {
      return selector.includes("login-page") ? 0 : 1;
    }
    return 1;
  }

  qqVisible(selector) {
    if (selector.includes("login-page")) return false;
    if (selector === QQMAIL_SELECTORS.composePage) return this.qqComposeOpen;
    if (selector === QQMAIL_SELECTORS.sentPage) return this.qqSent;
    return true;
  }

  qqText(selector) {
    if (selector === QQMAIL_LOGIN_PROBE_SELECTORS.accountMarker) return "person@example.test";
    if (selector === QQMAIL_SELECTORS.recipientChip) return this.input.message.recipient;
    if (selector === QQMAIL_SELECTORS.body) return this.input.message.body.content;
    if (selector === QQMAIL_SELECTORS.sendButton) return "Send";
    return this.fields.get(selector) ?? "";
  }

  outlookCommand(command) {
    const [name, subtype, selector] = command;
    if (name === "fill") {
      this.fields.set(subtype, selector);
      return { filled: subtype };
    }
    if (name === "get" && subtype === "value") return { value: this.fields.get(selector) ?? "" };
    if (name === "get" && subtype === "count") return { count: 1 };
    if (name === "get" && subtype === "attr") return { value: this.input.message.recipient };
    if (name === "get" && subtype === "text") return { text: this.fields.get(selector) ?? "" };
    if (name === "is" && subtype === "enabled") return { enabled: true };
    if (name === "click") {
      if (subtype === this.registration.effectSelector) this.markEffect(subtype);
      return { clicked: subtype };
    }
    if (name === "eval") {
      const url = "https://outlook.live.com/mail/0/inbox";
      return {
        result: {
          contract_version: 1,
          url,
          sent_evidence: true,
          compose_open: false,
        },
        origin: url,
      };
    }
    if (["wait", "focus", "press"].includes(name)) return {};
    throw new Error(`unsupported Outlook command: ${JSON.stringify(command)}`);
  }

  gmailCount(selector) {
    if (selector === GMAIL_SEND_SELECTORS.subject && this.gmailSent) return 0;
    if (selector === GMAIL_SEND_SELECTORS.recipientChip) {
      return this.gmailRecipientCommitted ? 1 : 0;
    }
    if ([
      "[data-identifier]",
      '[jsname="rwl3qc"]',
      "input#identifierId",
      "#identifierNext",
    ].includes(selector)) {
      return 0;
    }
    return 1;
  }

  gmailAttribute(selector, attribute) {
    if (selector === GMAIL_SEND_SELECTORS.recipientChip && attribute === "data-hovercard-id") {
      return this.input.message.recipient;
    }
    if (attribute === "aria-label") return "Google Account: Person (person@example.test)";
    return "";
  }

  gmailText(selector) {
    if (selector === GMAIL_SEND_SELECTORS.sentStatus) return "Message sent";
    return this.fields.get(selector) ?? "";
  }

  gmailClick(selector) {
    if (selector === GMAIL_SEND_SELECTORS.compose) this.gmailComposeOpen = true;
    if (selector === this.registration.effectSelector) {
      this.markEffect(selector);
      this.gmailComposeOpen = false;
      this.gmailSent = true;
    }
  }

  markEffect(selector) {
    this.effectAttempted = true;
    this.effectSelectors.push(selector);
  }

  assertAdapterLifecycle() {
    if (this.registration.provider === "outlook") {
      assert.ok(this.outlookInspectCalls >= 1);
      if (this.registration.operation === "send") assert.ok(this.outlookActCalls >= 1);
    }
    if (this.registration.provider === "gmail") {
      assert.equal(this.gmailOpened, 1);
      assert.equal(this.gmailClosed, 1);
      assert.equal(this.gmailDisposed, 1);
    }
  }
}

function outlookProbeEvidence() {
  const url = "https://outlook.live.com/mail/0/inbox";
  return {
    result: {
      contract_version: 1,
      url,
      mailbox_visible: true,
      account_marker: null,
    },
    origin: url,
  };
}

function probeInput(provider) {
  return {
    schema_version: 1,
    operation: "probe",
    invocation_id: `${provider}-probe-1`,
    provider,
    account: "default",
  };
}

function sendInput(provider) {
  return {
    schema_version: 1,
    operation: "send",
    invocation_id: `${provider}-send-1`,
    provider,
    account: "default",
    message: {
      recipient: "person@example.test",
      subject: "Provider runtime contract",
      body: { format: "text", content: "Line one\nLine two" },
    },
  };
}

function recipientDigest(recipient) {
  return `sha256:${crypto.createHash("sha256").update(recipient).digest("hex")}`;
}

assert.equal(QQMAIL_SELECTORS.sendButton.length > 0, true);
assert.equal(OUTLOOK_SEND_SELECTOR.length > 0, true);
