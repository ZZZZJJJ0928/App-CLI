// Native Sent-folder evidence shared by legacy and managed sends.
export const QQMAIL_SENT_FOLDER_SELECTOR='.frame-sidebar-menu .sidebar-menu-text:text-is("Sent"), .frame-sidebar-menu .sidebar-menu-text:text-is("已发送")';
// The CLI click resolves non-ref selectors immediately, before Playwright's
// action wait. Wait on the same strict locator while a fresh QQ page hydrates.
// Do not retry the click or choose one of multiple matching menu entries.
export const QQMAIL_SENT_READY_CODE = `async page => {
  const target = page.locator(${JSON.stringify(QQMAIL_SENT_FOLDER_SELECTOR)});
  await target.waitFor({state: 'visible', timeout: 5000});
  return await target.count() === 1 && await target.isVisible();
}`;
export const QQMAIL_SENT_BASELINE_EXPRESSION = `async () => {
  const visible = element => element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== "hidden";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (/^#\\/list\\/3(?:$|[/?])/.test(location.hash) && document.querySelector(".mail-list-page")) {
      return { ids: Array.from(document.querySelectorAll(".mail-list-page-item[data-mailid]")).filter(visible).map(row => row.getAttribute("data-mailid")) };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { ids: null };
}`;

export const QQMAIL_SENT_VERIFICATION_EXPRESSION = `async expected => {
  const visible = element => element && element.getBoundingClientRect().width > 0 &&
    element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== "hidden";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = Array.from(document.querySelectorAll(".mail-list-page-item[data-mailid]")).filter(visible);
    const first = rows[0];
    const id = first?.getAttribute("data-mailid");
    if (/^#\\/list\\/3(?:$|[/?])/.test(location.hash) &&
        !visible(document.querySelector(".mail-compose-page")) && visible(first) && id &&
        !expected.ids.includes(id) && (expected.ids.length === 0 ? rows.length === 1 :
          rows[1]?.getAttribute("data-mailid") === expected.ids[0])) {
      const subject = first.querySelector(".mail-subject")?.textContent ?? "";
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject))),
        byte => byte.toString(16).padStart(2, "0")).join("");
      if (digest === expected.subject || expected.emptySubject && ["(No subject)", "(无主题)"].includes(subject)) {
        return { sent_evidence: true, provider_message_id: id };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { sent_evidence: false };
}`;

