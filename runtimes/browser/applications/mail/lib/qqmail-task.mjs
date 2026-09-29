import {
  QQMAIL_URL,
  QQMailScriptError,
} from "./qqmail-browser.mjs";

export const QQMAIL_ALLOWED_ORIGINS = Object.freeze([
  "https://mail.qq.com",
  "https://wx.mail.qq.com",
]);

export function parseQQMailURL(value, invalidCode = "browser_output_invalid") {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new QQMailScriptError(invalidCode, "browser runtime returned an invalid URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !QQMAIL_ALLOWED_ORIGINS.includes(parsed.origin)
  ) {
    throw new QQMailScriptError("provider_origin_mismatch", "QQ Mail left its allowed origins");
  }
  return parsed;
}

export async function withQQMailTaskTab(operation, runtime, callback) {
  if (typeof runtime?.withTaskTab !== "function") {
    throw new QQMailScriptError(
      "browser_runtime_unavailable",
      "Playwright task runtime is unavailable",
    );
  }
  return runtime.withTaskTab(operation, callback, QQMAIL_URL);
}
