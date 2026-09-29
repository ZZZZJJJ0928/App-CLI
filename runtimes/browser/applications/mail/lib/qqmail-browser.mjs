import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const QQMAIL_URL = "https://wx.mail.qq.com/";

const DEFAULT_TIMEOUT_MS = 45_000;

export class QQMailScriptError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "QQMailScriptError";
    this.code = code;
  }
}

export function boundedTimeoutMS(raw) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(value, 5_000), 120_000);
}

export function normalizeVisibleText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function resultAt(results, index, phase) {
  const entry = results[index];
  if (!entry || entry.success !== true || !entry.result || typeof entry.result !== "object") {
    throw new QQMailScriptError(`${phase}_failed`, `${phase} did not return the expected browser result`);
  }
  return entry.result;
}
