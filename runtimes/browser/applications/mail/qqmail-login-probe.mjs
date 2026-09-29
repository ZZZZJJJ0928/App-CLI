#!/usr/bin/env node

import {
  QQMailScriptError,
  normalizeVisibleText,
  resultAt,
} from "./lib/qqmail-browser.mjs";
import {
  parseQQMailURL,
  withQQMailTaskTab,
} from "./lib/qqmail-task.mjs";

const ACCOUNT_HINT_LIMIT = 64;

export const QQMAIL_LOGIN_PROBE_SELECTORS = Object.freeze({
  accountMarker: ".frame-header .xmail-cmp-profile-btn .profile-user-info .user-email",
  loginPage: ".login-page",
});

function strictInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new QQMailScriptError("invalid_input", "stdin must contain one JSON object");
  }

  const expectedKeys = ["account", "invocation_id", "operation", "provider", "schema_version"];
  const actualKeys = Object.keys(input).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new QQMailScriptError("invalid_input", "stdin does not match the login probe schema");
  }
  if (
    input.schema_version !== 1 ||
    input.operation !== "probe" ||
    input.provider !== "qq_mail" ||
    input.account !== "default"
  ) {
    throw new QQMailScriptError("invalid_input", "stdin does not match the login probe schema");
  }
  if (
    typeof input.invocation_id !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.invocation_id)
  ) {
    throw new QQMailScriptError("invalid_input", "invocation_id must be an opaque ASCII identifier");
  }
}

function visibleAt(results, index, phase) {
  const visible = resultAt(results, index, phase).visible;
  if (typeof visible !== "boolean") {
    throw new QQMailScriptError(
      "login_probe_invalid_output",
      "browser runtime returned invalid login visibility",
    );
  }
  return visible;
}

function accountHint(value) {
  const account = normalizeVisibleText(value);
  if (
    account.length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(account)
  ) {
    throw new QQMailScriptError("page_contract_changed", "QQ Mail account marker is not usable");
  }

  const separator = account.lastIndexOf("@");
  const local = account.slice(0, separator);
  const domain = account.slice(separator + 1).toLowerCase();
  const localPrefix = [...local].slice(0, Math.min(2, [...local].length)).join("");
  const hint = `${localPrefix}***@${domain}`;
  return [...hint].slice(0, ACCOUNT_HINT_LIMIT).join("");
}

function normalizedProbeError(error) {
  if (error?.code === "browser_script_timeout") {
    return new QQMailScriptError("login_probe_timeout", "QQ Mail login probe timed out");
  }
  if (!(error instanceof QQMailScriptError)) {
    return new QQMailScriptError("login_probe_browser_failure", "QQ Mail login probe failed");
  }
  if (error.code.endsWith("_timeout")) {
    return new QQMailScriptError("login_probe_timeout", "QQ Mail login probe timed out");
  }
  if (error.code.endsWith("_invalid_output") || error.code.endsWith("_browser_output_invalid")) {
    return new QQMailScriptError(
      "login_probe_invalid_output",
      "browser runtime returned invalid login probe output",
    );
  }
  const preserved = new Set([
    "email_login_required",
    "browser_runtime_unavailable",
    "page_contract_changed",
    "provider_origin_mismatch",
    "task_tab_cleanup_failed",
  ]);
  if (preserved.has(error.code)) return error;
  return new QQMailScriptError("login_probe_browser_failure", "QQ Mail login probe failed");
}

export async function probeQQMailLogin(rawInput, runtime = {}) {
  strictInput(rawInput);
  try {
    return await withQQMailTaskTab("probe", runtime, async (task) => {
      const phase = "login_probe_state";
      let results;
      for (let attempt=0;attempt<6;attempt++) {
      results = await task.onTab(
        [
          ["get", "url"],
          ["is", "visible", QQMAIL_LOGIN_PROBE_SELECTORS.loginPage],
          ["is", "visible", QQMAIL_LOGIN_PROBE_SELECTORS.accountMarker],
          ["get", "text", QQMAIL_LOGIN_PROBE_SELECTORS.accountMarker],
        ],
        phase,
      );
      const current=parseQQMailURL(resultAt(results,0,phase).url,"login_probe_invalid_output");
      if (visibleAt(results,1,phase) || visibleAt(results,2,phase) || !['/','/home/index'].includes(current.pathname) || attempt===5) break;
      await task.onTab([["wait","200"]],"login_probe_loading");
      }
      const location = parseQQMailURL(
        resultAt(results, 0, phase).url,
        "login_probe_invalid_output",
      );
      // A visible login page wins over a stale account header during sign-out.
      if (visibleAt(results, 1, phase)) {
        throw new QQMailScriptError("email_login_required", "QQ Mail login is required");
      }
      if (location.pathname !== "/home/index" || !visibleAt(results, 2, phase)) {
        throw new QQMailScriptError("page_contract_changed", "QQ Mail login state is not recognized");
      }
      const hint = accountHint(resultAt(results, 3, phase).text);
      return {
        schema_version: 1,
        status: "ready",
        provider: "qq_mail",
        account_hint: hint,
      };
    });
  } catch (error) {
    throw normalizedProbeError(error);
  }
}
