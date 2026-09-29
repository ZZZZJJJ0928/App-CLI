import { createHash } from "node:crypto";

export const GMAIL_REGISTRATION_URL = "https://mail.google.com/mail/u/0/";
export const GMAIL_ORIGIN = "https://mail.google.com";
export const GOOGLE_ACCOUNTS_ORIGIN = "https://accounts.google.com";

const ALLOWED_HTTPS_ORIGINS = new Set([GMAIL_ORIGIN, GOOGLE_ACCOUNTS_ORIGIN]);

export const GMAIL_PROBE_EXPRESSION = String.raw`(async () => {
  const isVisible = (element) => {
    if (!element || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden" &&
      Number.parseFloat(style.opacity || "1") > 0;
  };
  const collect = () => {
    const account = Array.from(document.querySelectorAll('[aria-label^="Google Account:"]'))
      .find(isVisible);
    return {
      url: window.location.href,
      compose_visible: Array.from(document.querySelectorAll('[role="button"][gh="cm"]'))
        .some(isVisible),
      account_label: account?.getAttribute("aria-label") ?? "",
    };
  };
  const deadline = Date.now() + 8000;
  let state = collect();
  while (Date.now() < deadline && !state.compose_visible &&
      new URL(state.url).origin === ${JSON.stringify(GMAIL_ORIGIN)}) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = collect();
  }
  return state;
})()`;

export class GmailCliError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "GmailCliError";
    this.code = code;
  }
}

export function requireExactObject(value, requiredKeys, optionalKeys, errorCode) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new GmailCliError(errorCode);
  }
  const required = new Set(requiredKeys);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actualKeys = Object.keys(value);
  if (
    actualKeys.some((key) => !allowed.has(key)) ||
    [...required].some((key) => !Object.hasOwn(value, key))
  ) {
    throw new GmailCliError(errorCode);
  }
  return value;
}

export function requireInvocationId(value, errorCode) {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,128}$/.test(value)) {
    throw new GmailCliError(errorCode);
  }
  return value;
}

export function recipientDigest(value) {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

export async function inspectGmailLogin(tab, { includeAccountHint = false } = {}) {
  const data = await tab.inspect(GMAIL_PROBE_EXPRESSION);
  const state = data?.result;
  if (!state || typeof state.url !== "string" || typeof data.origin !== "string" ||
      typeof state.compose_visible !== "boolean" || typeof state.account_label !== "string" ||
      state.account_label.length > 512) {
    throw new GmailCliError("email_browser_output_invalid");
  }
  const origin = requireAllowedOrigin(state.url, "email_provider_origin_invalid");
  requireAllowedOrigin(data.origin, "email_provider_origin_invalid");
  if (state.url !== data.origin) {
    throw new GmailCliError("email_login_evidence_conflict");
  }
  if (origin === GOOGLE_ACCOUNTS_ORIGIN) throw new GmailCliError("email_login_required");
  if (!new URL(state.url).pathname.startsWith("/mail/") || !state.compose_visible) {
    throw new GmailCliError("email_page_contract_changed");
  }
  return { accountHint: includeAccountHint ? extractAccountHint(state.account_label) : undefined };
}

export function requireAllowedOrigin(rawURL, errorCode) {
  let parsed;
  try {
    parsed = new URL(rawURL);
  } catch {
    throw new GmailCliError(errorCode);
  }
  if (parsed.username || parsed.password || !ALLOWED_HTTPS_ORIGINS.has(parsed.origin)) {
    throw new GmailCliError(errorCode);
  }
  return parsed.origin;
}

function extractAccountHint(label) {
  if (!label.startsWith("Google Account:")) {
    return undefined;
  }
  const accountMarker = label.match(/\(([^()\r\n]{1,128})\)\s*$/);
  if (accountMarker === null) {
    return undefined;
  }
  const candidate = accountMarker[1];
  const separator = candidate.indexOf("@");
  if (
    separator <= 0 ||
    separator !== candidate.lastIndexOf("@") ||
    separator === candidate.length - 1
  ) {
    return undefined;
  }

  const localPart = candidate.slice(0, separator);
  const rawDomain = candidate.slice(separator + 1);
  const localPattern = /^[\p{L}\p{N}\p{M}.!#$%&'*+/=?^_\x60{|}~-]+$/u;
  const domainPattern =
    /^[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;
  if (
    !localPattern.test(localPart) ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..") ||
    !domainPattern.test(rawDomain)
  ) {
    return undefined;
  }

  const prefix = Array.from(localPart).slice(0, 2).join("");
  const hint = prefix + "***@" + rawDomain.toLowerCase();
  return Array.from(hint).length <= 64 ? hint : undefined;
}
