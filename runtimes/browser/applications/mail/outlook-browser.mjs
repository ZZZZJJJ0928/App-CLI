import { createHash } from "node:crypto";

export const OUTLOOK_ORIGINS = new Set([
  "https://outlook.live.com",
  "https://outlook.office.com",
  "https://outlook.office365.com",
]);
export const MICROSOFT_LOGIN_ORIGINS = new Set([
  "https://login.live.com",
  "https://login.microsoftonline.com",
]);
const MICROSOFT_OUTLOOK_LANDING_ORIGIN = "https://www.microsoft.com";
const MICROSOFT_OUTLOOK_LANDING_PATH =
  /^\/[a-z]{2}-[a-z]{2}\/microsoft-365\/outlook\/email-and-calendar-software-microsoft-outlook\/?$/;

export const PROBE_EXPRESSION = String.raw`(async () => {
  const isVisible = (element) => {
    if (!element || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden" &&
      Number.parseFloat(style.opacity || "1") > 0;
  };
  const collect = () => {
    const accountControl = Array.from(document.querySelectorAll([
      "#OwaTitleBar button#O365_MainLink_MePhoto",
      "#OwaTitleBar button#O365_MeFlexPane_ButtonID",
      '#OwaTitleBar button[data-testid="mectrl_headerPicture"]',
    ].join(", "))).find(isVisible) || null;
    return {
      contract_version: 1,
      url: window.location.href,
      mailbox_visible: Array.from(document.querySelectorAll([
        'button[aria-label="New mail"]',
        'button[aria-label="New message"]',
        'button[aria-label="\u65b0\u90ae\u4ef6"]',
        'button[aria-label="\u65b0\u5efa\u90ae\u4ef6"]',
        '[role="navigation"] button[aria-label="Mail"]',
        '[role="navigation"] button[aria-label="\u90ae\u4ef6"]',
      ].join(", "))).some(isVisible),
      account_marker: accountControl ? {
        source: "account_control",
        label: accountControl.getAttribute("aria-label") ||
          accountControl.getAttribute("title") || "",
      } : null,
    };
  };

  const deadline = Date.now() + 8000;
  let evidence = collect();
  while (
    Date.now() < deadline &&
    !evidence.mailbox_visible &&
    ${JSON.stringify([...OUTLOOK_ORIGINS])}.includes(new URL(evidence.url).origin)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    evidence = collect();
  }
  return evidence;
})()`;

export class OutlookCliError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "OutlookCliError";
    this.code = code;
  }
}

export function validateInvocationId(value) {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,128}$/.test(value)) {
    throw new OutlookCliError("invalid_request");
  }
  return value;
}

export function recipientDigest(value) {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

export async function withOwnedOutlookTab(options, operation) {
  if (typeof options.runtime?.withTaskTab !== "function") {
    throw new OutlookCliError("browser_runtime_unavailable");
  }
  return options.runtime.withTaskTab(options.operation, operation);
}

export function parseProbeEvidence(evalData) {
  if (!isRecord(evalData)) throw new OutlookCliError("browser_output_invalid");
  const { result, origin } = evalData;
  if (
    !isRecord(result) ||
    result.contract_version !== 1 ||
    typeof result.url !== "string" ||
    typeof origin !== "string" ||
    result.url !== origin ||
    typeof result.mailbox_visible !== "boolean" ||
    !isAccountMarker(result.account_marker)
  ) {
    throw new OutlookCliError("browser_output_invalid");
  }
  return result;
}

export function classifyProbeEvidence(evidence) {
  const url = parseHttpsURL(evidence.url, "browser_output_invalid");
  const isOutlookOrigin = OUTLOOK_ORIGINS.has(url.origin);
  const isLoginOrigin = MICROSOFT_LOGIN_ORIGINS.has(url.origin);
  if (!isOutlookOrigin && !isLoginOrigin) {
    throw new OutlookCliError("outlook_origin_not_allowed");
  }

  if (isLoginOrigin) throw new OutlookCliError("email_login_required");
  if (!url.pathname.startsWith("/mail/") || !evidence.mailbox_visible) {
    throw new OutlookCliError("outlook_page_contract_changed");
  }

  const result = {
    schema_version: 1,
    status: "ready",
    provider: "outlook",
  };
  const accountHint = deriveMaskedAccountHint(evidence.account_marker);
  if (accountHint !== null) result.account_hint = accountHint;
  return result;
}

export function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function parseHttpsURL(value, invalidCode) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OutlookCliError(invalidCode);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new OutlookCliError(invalidCode);
  }
  return url;
}

export function isMicrosoftOutlookLanding(url) {
  return (
    url.origin === MICROSOFT_OUTLOOK_LANDING_ORIGIN &&
    MICROSOFT_OUTLOOK_LANDING_PATH.test(url.pathname.toLowerCase()) &&
    url.searchParams.get("deeplink") === "/mail/"
  );
}

function deriveMaskedAccountHint(marker) {
  if (marker === null) return null;
  const label = marker.label.normalize("NFKC");
  const emailPattern =
    /[\p{L}\p{M}\p{N}.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/giu;
  const candidates = Array.from(label.matchAll(emailPattern), (match) => match[0])
    .filter((email) => {
      const separator = email.lastIndexOf("@");
      const localPart = email.slice(0, separator);
      const domain = email.slice(separator + 1);
      return (
        localPart !== "" &&
        !localPart.startsWith(".") &&
        !localPart.endsWith(".") &&
        !localPart.includes("..") &&
        domain.length <= 253
      );
    });
  if (candidates.length !== 1) return null;
  const email = candidates[0];
  const separator = email.lastIndexOf("@");
  const localPrefix = Array.from(email.slice(0, separator)).slice(0, 2).join("");
  const domain = email.slice(separator + 1).toLowerCase();
  const hint = localPrefix + "***@" + domain;
  return Array.from(hint).length <= 64 ? hint : null;
}

function isAccountMarker(value) {
  return value === null || (
    hasExactKeys(value, ["label", "source"]) &&
    value.source === "account_control" &&
    typeof value.label === "string" &&
    value.label.length <= 512
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
