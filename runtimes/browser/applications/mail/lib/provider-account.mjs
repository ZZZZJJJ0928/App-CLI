export const READ_PROVIDERS = Object.freeze({
  qq_mail: { url: "https://wx.mail.qq.com/home/index#/list/1/1", origins: ["https://wx.mail.qq.com", "https://mail.qq.com"] },
  outlook: { url: "https://outlook.live.com/mail/0/inbox", origins: ["https://outlook.live.com", "https://outlook.office.com", "https://outlook.office365.com"] },
  gmail: { url: "https://mail.google.com/mail/u/0/#inbox", origins: ["https://mail.google.com"] },
});
// Shared account identity evidence used by native sending.
export function providerAccountDOM(provider) {
  const visible = node => {
    if (!node?.isConnected) return false;
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const all = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(visible);
  const text = node => (node?.innerText ?? node?.textContent ?? "").trim();
  const address = value => String(value ?? "").match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u)?.[0] ?? "";
  const result = value => ({ url: location.href, ...value });
  if (provider === 'qq_mail' && all('.login-page').length) return result({error:'email_login_required'});
  let account = "";
  if (provider === "gmail") account = address(document.querySelector('[aria-label^="Google Account:"]')?.getAttribute("aria-label"));
  if (provider === "qq_mail") account = address(text(document.querySelector('.frame-header .profile-user-info .user-email')));
  if (provider === "outlook") {
    const roots=all('[role="tree"] [role="treeitem"][aria-level="1"][data-folder-name]');
    const accounts=roots.map(node=>{
      const title=address(node.getAttribute('title'));
      const labels=all(':scope > span',node).map(child=>address(text(child))).filter(Boolean);
      return title && labels.length===1 && title.toLowerCase()===labels[0].toLowerCase() ? title : '';
    }).filter(Boolean);
    account=accounts.length===1 ? accounts[0] : address(text(document.querySelector('#mectrl_currentAccount_secondary'))) ||
      address(document.querySelector('#O365_MainLink_MePhoto, #O365_MeFlexPane_ButtonID, [data-testid="mectrl_headerPicture"]')?.getAttribute('aria-label'));
  }
  return result({ account_address: account });
}
