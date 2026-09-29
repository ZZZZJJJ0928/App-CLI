#!/usr/bin/env node

import {isManagedSend,sendManagedMail} from "./lib/managed-send.mjs";
import crypto from "node:crypto";

import {
  OUTLOOK_ORIGINS,
  OutlookCliError,
  PROBE_EXPRESSION,
  classifyProbeEvidence,
  hasExactKeys,
  parseProbeEvidence,
  recipientDigest,
  validateInvocationId,
  withOwnedOutlookTab,
} from "./outlook-browser.mjs";

const INPUT_KEYS = [
  "account",
  "invocation_id",
  "message",
  "operation",
  "provider",
  "schema_version",
];
const MESSAGE_REQUIRED_KEYS = ["body", "recipient"];
const MESSAGE_OPTIONAL_KEYS = ["subject"];
const BODY_KEYS = ["content", "format"];
const MAX_SUBJECT_LENGTH = 998;
const MAX_BODY_LENGTH = 200_000;

const NEW_MAIL_SELECTOR = [
  'button[aria-label="New mail"]',
  'button[aria-label="New message"]',
  'button[aria-label="\u65b0\u90ae\u4ef6"]',
  'button[aria-label="\u65b0\u5efa\u90ae\u4ef6"]',
].join(", ");
const RECIPIENT_SELECTOR = [
  '[contenteditable="true"][aria-label="To"]',
  '[contenteditable="true"][aria-label="\u6536\u4ef6\u4eba"]',
  'input[aria-label="To"]',
  'input[aria-label="Recipients"]',
  'input[aria-label="\u6536\u4ef6\u4eba"]',
  'input[placeholder="To"]',
  'input[placeholder="\u6536\u4ef6\u4eba"]',
  '[role="combobox"][aria-label="To"]',
  '[role="combobox"][aria-label="\u6536\u4ef6\u4eba"]',
].join(", ");
const SUBJECT_SELECTOR = [
  'input[aria-label="Add a subject"]',
  'input[aria-label="Subject"]',
  'input[aria-label="\u6dfb\u52a0\u4e3b\u9898"]',
  'input[aria-label="\u4e3b\u9898"]',
  'input[placeholder="Add a subject"]',
  'input[placeholder="\u6dfb\u52a0\u4e3b\u9898"]',
].join(", ");
export const OUTLOOK_RECIPIENT_CHIP_SELECTOR = `[contenteditable="true"] [draggable="true"][aria-label]`;
export const OUTLOOK_RECIPIENT_STATE_EXPRESSION = `() => {
  const field = document.querySelector(${JSON.stringify(RECIPIENT_SELECTOR)});
  if (!field) return { valid: false };
  const copy = field.cloneNode(true);
  copy.querySelectorAll('[draggable="true"][aria-label]').forEach(chip => chip.remove());
  const pending = copy.value ?? copy.textContent ?? "";
  return { valid: pending.replace(/[\\u200b\\ufeff]/g, "").trim() === "" &&
    field.querySelectorAll('[draggable="true"][aria-label]').length === 1 &&
    document.querySelectorAll(${JSON.stringify(OUTLOOK_RECIPIENT_CHIP_SELECTOR)}).length === 1 };
}`;
const BODY_SELECTOR = [
  '[contenteditable="true"][aria-label="Message body"]',
  '[contenteditable="true"][aria-label="Email body"]',
  '[contenteditable="true"][aria-label="\u90ae\u4ef6\u6b63\u6587"]',
  '[contenteditable="true"][aria-label="\u6d88\u606f\u6b63\u6587"]',
].join(", ");
export const OUTLOOK_SEND_SELECTOR = [
  'button[aria-label="Send"]',
  'button[aria-label="\u53d1\u9001"]',
  'button[title="Send"]',
  'button[title="\u53d1\u9001"]',
].join(", ");

export const OUTLOOK_SENT_BASELINE_EXPRESSION = `async () => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const rows = Array.from(document.querySelectorAll('[role="option"][data-convid]'));
    const empty = Array.from(document.querySelectorAll('[role="treeitem"][data-folder-name="sent items"][aria-selected="true"]'))
      .some(folder => / - 0 items(?:\\s|$)/.test(folder.getAttribute("title") || ""));
    if (/\\/sentitems\\/?$/.test(location.pathname) && (rows.length > 0 || empty) && rows.length <= 1000) {
      return { ids: rows.map(row => row.id) };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { ids: null };
}`;

export const OUTLOOK_SEND_VERIFICATION_EXPRESSION = String.raw`(async (expected) => {
  const isVisible = (element) => {
    if (!element || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden" &&
      Number.parseFloat(style.opacity || "1") > 0;
  };
  const anyVisible = (selector) =>
    Array.from(document.querySelectorAll(selector)).some(isVisible);
  const bodySelector = ${JSON.stringify(BODY_SELECTOR)};
  const sendSelector = ${JSON.stringify(OUTLOOK_SEND_SELECTOR)};
  const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
  const collect = async () => {
    const composeOpen = anyVisible(bodySelector) || anyVisible(sendSelector);
    const rows = Array.from(document.querySelectorAll('[role="option"][data-convid]'));
    const first = rows[0];
    let sentEvidence = false;
    if (!composeOpen && /\/sentitems\/?$/.test(window.location.pathname) && first &&
        isVisible(first) && !expected.ids.includes(first.id) &&
        (expected.ids.length === 0 ? rows.length === 1 : rows[1]?.id === expected.ids[0])) {
      const fields = Array.from(first.querySelectorAll('span')).filter(element =>
        element.children.length === 0 && element.textContent.trim() !== "");
      const recipient = fields[0]?.textContent.trim().toLowerCase() ?? "";
      const subject = fields[1]?.textContent ?? "";
      sentEvidence = await digest(recipient) === expected.recipient &&
        (await digest(subject) === expected.subject || expected.emptySubject === true &&
          ["(No subject)", "(无主题)"].includes(subject));
    }
    return {
      contract_version: 1,
      url: window.location.href,
      sent_evidence: sentEvidence,
      compose_open: composeOpen,
    };
  };
  const deadline = Date.now() + 5000;
  let result = await collect();
  while (!result.sent_evidence && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await collect();
  }
  return result;
})`;

export async function sendOutlook(rawInput, runtime = {}) {
  if(isManagedSend(rawInput))return sendManagedMail(rawInput,"outlook",runtime);
  let sendClickAttempted = false;
  try {
    const input = validateInput(rawInput);
    const timeoutMs = runtime.timeoutMs ?? 10_000;
    return await withOwnedOutlookTab({
      invocationId: input.invocation_id,
      operation: "send",
      timeoutMs,
      runtime,
    }, async (tab) => {
      const evidence = parseProbeEvidence(await tab.inspect(PROBE_EXPRESSION));
      classifyProbeEvidence(evidence);
      const baseline = (await tab.inspect(OUTLOOK_SENT_BASELINE_EXPRESSION)).result;
      if (!Array.isArray(baseline?.ids) || baseline.ids.length > 1000 ||
          baseline.ids.some(id => typeof id !== "string" || !id || id.length > 1024)) {
        throw new OutlookCliError("field_verification_failed");
      }
      await composeAndVerify(tab, input.message);

      sendClickAttempted = true;
      try {
        await tab.act(["click", OUTLOOK_SEND_SELECTOR]);
      } catch {
        throw new OutlookCliError("send_outcome_unknown");
      }

      let verification;
      try {
        verification = parseSendVerification(
          await tab.act([
            "eval",
            "-b",
            Buffer.from(`${OUTLOOK_SEND_VERIFICATION_EXPRESSION}(${JSON.stringify({
              ids: baseline.ids,
              recipient: crypto.createHash("sha256").update(input.message.recipient.toLowerCase()).digest("hex"),
              subject: crypto.createHash("sha256").update(input.message.subject ?? "").digest("hex"),
              emptySubject: !input.message.subject,
            })})`, "utf8").toString("base64"),
          ]),
        );
      } catch {
        throw new OutlookCliError("send_outcome_unknown");
      }
      if (!verification.sent_evidence) {
        throw new OutlookCliError("send_outcome_unknown");
      }
      return {
        schema_version: 1,
        status: "sent",
        provider: "outlook",
        recipient_digest: recipientDigest(input.message.recipient),
      };
    });
  } catch (error) {
    if (sendClickAttempted) {
      throw new OutlookCliError("send_outcome_unknown");
    }
    throw error;
  }
}

async function composeAndVerify(tab, message) {
  try {
    await tab.act(["click", NEW_MAIL_SELECTOR]);
    await tab.act(["fill", RECIPIENT_SELECTOR, message.recipient]);
    await tab.act(["press", "Enter"]);
    await tab.act(["fill", SUBJECT_SELECTOR, message.subject ?? ""]);
    await tab.act(["fill", BODY_SELECTOR, message.body.content]);
    const [committed, subject, body, send, enabled] = await tab.readMany([
      ["get", "attr", OUTLOOK_RECIPIENT_CHIP_SELECTOR, "aria-label"],
      ["get", "value", SUBJECT_SELECTOR],
      ["get", "text", BODY_SELECTOR],
      ["get", "count", OUTLOOK_SEND_SELECTOR],
      ["is", "enabled", OUTLOOK_SEND_SELECTOR],
    ]);
    const recipientState = await tab.inspect(OUTLOOK_RECIPIENT_STATE_EXPRESSION);
    if (committed.value?.toLowerCase() !== message.recipient.toLowerCase() || recipientState.result?.valid !== true ||
        subject.value !== (message.subject ?? "") || normalizeNewlines(body.text) !== normalizeNewlines(message.body.content)) {
      throw new OutlookCliError("field_verification_failed");
    }
    if (send.count !== 1 || enabled.enabled !== true) throw new OutlookCliError("send_unavailable");
  } catch (error) {
    if (error instanceof OutlookCliError) throw error;
    throw new OutlookCliError("send_preparation_failed", { cause: error });
  }
}

function validateInput(input) {
  if (!hasExactKeys(input, INPUT_KEYS)) throw new OutlookCliError("invalid_request");
  if (
    input.schema_version !== 1 || input.operation !== "send" ||
    input.provider !== "outlook" || input.account !== "default"
  ) {
    throw new OutlookCliError("invalid_request");
  }
  validateInvocationId(input.invocation_id);
  if (!hasRequiredAndOptionalKeys(input.message, MESSAGE_REQUIRED_KEYS, MESSAGE_OPTIONAL_KEYS)) {
    throw new OutlookCliError("invalid_request");
  }
  if (!hasExactKeys(input.message.body, BODY_KEYS)) {
    throw new OutlookCliError("invalid_request");
  }

  const recipient = input.message.recipient;
  if (!isSingleEmailAddress(recipient)) throw new OutlookCliError("invalid_request");
  if (
    input.message.subject !== undefined &&
    (typeof input.message.subject !== "string" ||
      /[\r\n]/.test(input.message.subject) ||
      Array.from(input.message.subject).length > MAX_SUBJECT_LENGTH)
  ) {
    throw new OutlookCliError("invalid_request");
  }
  if (
    input.message.body.format !== "text" ||
    typeof input.message.body.content !== "string" ||
    input.message.body.content.trim() === "" ||
    Buffer.byteLength(input.message.body.content, "utf8") > MAX_BODY_LENGTH ||
    input.message.body.content.includes("\0")
  ) {
    throw new OutlookCliError("invalid_request");
  }
  return input;
}

function isSingleEmailAddress(value) {
  if (
    typeof value !== "string" || value.length > 320 || value !== value.trim() ||
    /[\s<>]/.test(value)
  ) {
    return false;
  }
  const separator = value.indexOf("@");
  return separator > 0 && separator === value.lastIndexOf("@") &&
    separator < value.length - 1 && value.slice(separator + 1).includes(".");
}

function hasRequiredAndOptionalKeys(value, required, optional) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function parseSendVerification(evalData) {
  if (
    evalData === null || typeof evalData !== "object" || Array.isArray(evalData) ||
    evalData.result === null || typeof evalData.result !== "object" ||
    evalData.result.contract_version !== 1 ||
    typeof evalData.result.url !== "string" || evalData.result.url !== evalData.origin ||
    typeof evalData.result.sent_evidence !== "boolean" ||
    typeof evalData.result.compose_open !== "boolean"
  ) {
    throw new OutlookCliError("browser_output_invalid");
  }
  let url;
  try {
    url = new URL(evalData.result.url);
  } catch {
    throw new OutlookCliError("browser_output_invalid");
  }
  if (url.protocol !== "https:" || !OUTLOOK_ORIGINS.has(url.origin)) {
    throw new OutlookCliError("outlook_origin_not_allowed");
  }
  return evalData.result;
}

function normalizeNewlines(value) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : null;
}
