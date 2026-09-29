// Native Sent-folder evidence shared by legacy and managed sends.
export const OUTLOOK_BODY_SELECTOR = [
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
  const bodySelector = ${JSON.stringify(OUTLOOK_BODY_SELECTOR)};
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
      sentEvidence = (expected.recipient_hashes ?? [expected.recipient]).includes(await digest(recipient)) &&
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

