#!/usr/bin/env node

import {isManagedSend,sendManagedMail} from "./lib/managed-send.mjs";
import {OUTLOOK_BODY_SELECTOR as BODY_SELECTOR,OUTLOOK_SEND_SELECTOR,OUTLOOK_SENT_BASELINE_EXPRESSION,OUTLOOK_SEND_VERIFICATION_EXPRESSION} from "./lib/outlook-send-proof.mjs";
export {OUTLOOK_SEND_SELECTOR,OUTLOOK_SENT_BASELINE_EXPRESSION,OUTLOOK_SEND_VERIFICATION_EXPRESSION} from "./lib/outlook-send-proof.mjs";
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
