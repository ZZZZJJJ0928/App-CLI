#!/usr/bin/env node

import {isManagedSend,sendManagedMail} from "./lib/managed-send.mjs";
import {
  GMAIL_ORIGIN,
  GmailCliError,
  inspectGmailLogin,
  recipientDigest,
  requireExactObject,
  requireInvocationId,
} from "./gmail-browser.mjs";

export const GMAIL_SEND_SELECTORS = Object.freeze({
  compose: '[role="button"][gh="cm"]',
  expand: '[role="dialog"] button[aria-label="Maximise"], [role="dialog"] button[aria-label="Maximize"], [role="dialog"] button[aria-label="最大化"]',
  subject: 'input[name="subjectbox"]',
  recipientInput: [
    '[role="dialog"] textarea[name="to"]',
    '[role="dialog"] input[peoplekit-id]',
    '[role="dialog"] input[role="combobox"][aria-label^="To"]'
  ].join(", "),
  // A collapsed modern editor also renders [email] summaries for the same recipients.
  recipientChip: '[role="dialog"] [role="option"][data-hovercard-id], [role="dialog"]:not(:has([role="option"][data-hovercard-id])) [email]',
  body: '[role="dialog"] [role="textbox"][contenteditable="true"]',
  send: [
    '[role="dialog"] [role="button"][data-tooltip^="Send"]',
    '[role="dialog"] [role="button"][aria-label^="Send"]',
    '[role="dialog"] [role="button"][data-tooltip^="发送"]',
    '[role="dialog"] [role="button"][aria-label^="发送"]'
  ].join(", "),
  sentStatus: ".bAq"
});

const KNOWN_ERROR_CODES = new Set([
  "email_send_invalid_input",
  "email_send_configuration_error",
  "email_login_required",
  "email_provider_origin_invalid",
  "email_login_evidence_conflict",
  "email_page_contract_changed",
  "email_send_timeout",
  "email_browser_output_invalid",
  "email_browser_failed",
  "email_send_precondition_failed",
  "email_tab_cleanup_failed",
  "send_outcome_unknown"
]);

export async function sendGmail(rawInput, runtime = {}) {
  if(isManagedSend(rawInput))return sendManagedMail(rawInput,"gmail",runtime);
  let tab;
  let failure;
  let sendClickAttempted = false;
  let sendConfirmed = false;

  try {
    const request = validateRequest(rawInput);
    if (typeof runtime.createOwnedTab !== "function") {
      throw new GmailCliError("email_send_configuration_error");
    }
    tab = await runtime.createOwnedTab({
      kind: "send",
      configurationErrorCode: "email_send_configuration_error",
      timeoutErrorCode: "email_send_timeout",
      invalidOutputErrorCode: "email_browser_output_invalid",
      browserErrorCode: "email_browser_failed",
      originErrorCode: "email_provider_origin_invalid",
      originConflictErrorCode: "email_login_evidence_conflict"
    });

    await tab.open();
    await inspectGmailLogin(tab);

    try {
      await prepareMessage(tab, request.message);
      sendClickAttempted = true;
      await tab.click(GMAIL_SEND_SELECTORS.send, GMAIL_ORIGIN);
      await confirmSent(tab);
      sendConfirmed = true;
    } catch (caught) {
      if (sendClickAttempted && !sendConfirmed) {
        throw new GmailCliError("send_outcome_unknown");
      }
      if (caught instanceof GmailCliError && isProviderStateError(caught.code)) {
        throw caught;
      }
      throw new GmailCliError("email_send_precondition_failed", { cause: caught });
    }

    return {
      schema_version: request.schema_version,
      status: "sent",
      provider: "gmail",
      recipient_digest: recipientDigest(request.message.recipient)
    };
  } catch (caught) {
    failure = normalizeFailure(caught);
  } finally {
    if (tab !== undefined) {
      try {
        await tab.closeOwnedTab();
      } catch {
        failure ??= new GmailCliError(
          sendClickAttempted ? "send_outcome_unknown" : "email_tab_cleanup_failed"
        );
      }
      await tab.dispose();
    }
  }

  if (failure !== undefined) throw failure;
}

function validateRequest(request) {
  requireExactObject(
    request,
    ["schema_version", "operation", "invocation_id", "provider", "account", "message"],
    [],
    "email_send_invalid_input"
  );
  if (request.schema_version !== 1 || request.operation !== "send" ||
      request.provider !== "gmail" || request.account !== "default") {
    throw new GmailCliError("email_send_invalid_input");
  }
  requireInvocationId(request.invocation_id, "email_send_invalid_input");

  requireExactObject(
    request.message,
    ["recipient", "body"],
    ["subject"],
    "email_send_invalid_input"
  );
  requireRecipient(request.message.recipient);

  if (Object.hasOwn(request.message, "subject")) {
    const subject = request.message.subject;
    if (typeof subject !== "string" || /[\r\n\x00]/.test(subject) ||
        Array.from(subject).length > 998 || Buffer.byteLength(subject, "utf8") > 4000) {
      throw new GmailCliError("email_send_invalid_input");
    }
  }

  requireExactObject(
    request.message.body,
    ["format", "content"],
    [],
    "email_send_invalid_input"
  );
  const body = request.message.body;
  if (body.format !== "text" || typeof body.content !== "string" ||
      body.content.trim().length === 0 ||
      Buffer.byteLength(body.content, "utf8") > 200 * 1024) {
    throw new GmailCliError("email_send_invalid_input");
  }

  return request;
}

function requireRecipient(recipient) {
  if (typeof recipient !== "string" || recipient.length === 0 || recipient.length > 320 ||
      recipient !== recipient.trim() || /[\s<>\x00-\x1f\x7f]/u.test(recipient)) {
    throw new GmailCliError("email_send_invalid_input");
  }
  const separator = recipient.indexOf("@");
  if (separator <= 0 || separator !== recipient.lastIndexOf("@") ||
      separator === recipient.length - 1) {
    throw new GmailCliError("email_send_invalid_input");
  }

  if (!recipient.slice(separator + 1).includes(".")) {
    throw new GmailCliError("email_send_invalid_input");
  }
}

async function prepareMessage(tab, message) {
  await tab.click(GMAIL_SEND_SELECTORS.compose, GMAIL_ORIGIN);
  const expandCount = await tab.getCount(GMAIL_SEND_SELECTORS.expand, GMAIL_ORIGIN);
  if (expandCount > 1) throw new GmailCliError("email_send_precondition_failed");
  if (expandCount === 1) await tab.click(GMAIL_SEND_SELECTORS.expand, GMAIL_ORIGIN);
  await tab.fill(GMAIL_SEND_SELECTORS.recipientInput, message.recipient, GMAIL_ORIGIN);
  await tab.press("Enter", GMAIL_ORIGIN);
  const subject = message.subject ?? "";
  await tab.fill(GMAIL_SEND_SELECTORS.subject, subject, GMAIL_ORIGIN);
  await tab.fill(GMAIL_SEND_SELECTORS.body, message.body.content, GMAIL_ORIGIN);
  const [chips, legacyAddress, address, pending, draftSubject, body, send, enabled] = await tab.readMany([
    ["get", "count", GMAIL_SEND_SELECTORS.recipientChip],
    ["get", "attr", GMAIL_SEND_SELECTORS.recipientChip, "email"],
    ["get", "attr", GMAIL_SEND_SELECTORS.recipientChip, "data-hovercard-id"],
    ["get", "value", GMAIL_SEND_SELECTORS.recipientInput],
    ["get", "value", GMAIL_SEND_SELECTORS.subject],
    ["get", "text", GMAIL_SEND_SELECTORS.body],
    ["get", "count", GMAIL_SEND_SELECTORS.send],
    ["is", "enabled", GMAIL_SEND_SELECTORS.send],
  ], GMAIL_ORIGIN);
  if (chips.count !== 1 || (legacyAddress.value || address.value).toLowerCase() !== message.recipient.toLowerCase() ||
      pending.value !== "" || draftSubject.value !== subject ||
      normalizeLineEndings(body.text) !== normalizeLineEndings(message.body.content) ||
      send.count !== 1 || enabled.enabled !== true) {
    throw new GmailCliError("email_send_precondition_failed");
  }
}

async function confirmSent(tab) {
  await tab.waitFor(GMAIL_SEND_SELECTORS.sentStatus, GMAIL_ORIGIN);
  const [receipt, compose] = await tab.readMany([
    ["get", "text", GMAIL_SEND_SELECTORS.sentStatus],
    ["get", "count", GMAIL_SEND_SELECTORS.subject],
  ], GMAIL_ORIGIN);
  const status = receipt.text
    .replace(/\s+/g, " ")
    .trim();
  if (!(status.startsWith("Message sent") || status.startsWith("邮件已发送"))) {
    throw new GmailCliError("send_outcome_unknown");
  }
  if (compose.count !== 0) {
    throw new GmailCliError("send_outcome_unknown");
  }
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isProviderStateError(code) {
  return code === "email_provider_origin_invalid" ||
    code === "email_login_evidence_conflict" ||
    code === "email_page_contract_changed";
}

function normalizeFailure(caught) {
  if (caught instanceof GmailCliError && KNOWN_ERROR_CODES.has(caught.code)) {
    return caught;
  }
  return new GmailCliError("email_browser_failed", { cause: caught });
}
