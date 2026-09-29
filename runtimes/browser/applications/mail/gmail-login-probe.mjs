#!/usr/bin/env node

import {
  GmailCliError,
  inspectGmailLogin,
  requireExactObject,
  requireInvocationId,
} from "./gmail-browser.mjs";

const KNOWN_ERROR_CODES = new Set([
  "email_login_required",
  "email_probe_invalid_input",
  "email_probe_configuration_error",
  "email_provider_origin_invalid",
  "email_login_evidence_conflict",
  "email_page_contract_changed",
  "email_probe_timeout",
  "email_browser_output_invalid",
  "email_browser_failed",
  "email_tab_cleanup_failed"
]);

export async function probeGmailLogin(rawInput, runtime = {}) {
  let tab;
  let failure;

  try {
    const request = validateRequest(rawInput);
    if (typeof runtime.createOwnedTab !== "function") {
      throw new GmailCliError("email_probe_configuration_error");
    }
    tab = await runtime.createOwnedTab({
      kind: "probe",
      configurationErrorCode: "email_probe_configuration_error",
      timeoutErrorCode: "email_probe_timeout",
      invalidOutputErrorCode: "email_browser_output_invalid",
      browserErrorCode: "email_browser_failed",
      originErrorCode: "email_provider_origin_invalid",
      originConflictErrorCode: "email_login_evidence_conflict"
    });

    await tab.open();
    const { accountHint } = await inspectGmailLogin(tab, { includeAccountHint: true });
    const response = {
      schema_version: request.schema_version,
      status: "ready",
      provider: "gmail"
    };
    if (accountHint !== undefined) {
      response.account_hint = accountHint;
    }
    return response;
  } catch (caught) {
    failure = normalizeFailure(caught);
  } finally {
    if (tab !== undefined) {
      try {
        await tab.closeOwnedTab();
      } catch {
        failure ??= new GmailCliError("email_tab_cleanup_failed");
      }
      await tab.dispose();
    }
  }

  if (failure !== undefined) throw failure;
}

function validateRequest(request) {
  requireExactObject(
    request,
    ["schema_version", "operation", "invocation_id", "provider", "account"],
    [],
    "email_probe_invalid_input"
  );
  if (request.schema_version !== 1 || request.operation !== "probe" ||
      request.provider !== "gmail" || request.account !== "default") {
    throw new GmailCliError("email_probe_invalid_input");
  }
  requireInvocationId(request.invocation_id, "email_probe_invalid_input");
  return request;
}

function normalizeFailure(caught) {
  if (caught instanceof GmailCliError && KNOWN_ERROR_CODES.has(caught.code)) {
    return caught;
  }
  return new GmailCliError("email_browser_failed");
}
