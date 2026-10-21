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
  if (provider === "gmail") {
    const page = new URL(location.href);
    if (page.origin !== 'https://mail.google.com' || !page.pathname.startsWith('/mail/') || page.username || page.password) return result({account_address: ''});
    // The signed-in account trigger has a stable destination and role; its
    // accessible label is localized. Never search message text or the account
    // switcher, and never pick the first of several possible current accounts.
    const triggers = all('header a[role="button"][href], [role="banner"] a[role="button"][href], #gb a[role="button"][href]').filter(node => {
      let url;
      try {url = new URL(node.getAttribute('href'), location.href);} catch {return false;}
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/SignOutOptions' || url.username || url.password) return false;
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (parent.hidden || parent.inert || parent.getAttribute('aria-hidden') === 'true' ||
            style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
      }
      return true;
    });
    if (triggers.length !== 1) return result({account_address: ''});
    const identities = new Set();
    for (const name of ['aria-label', 'title', 'data-email']) {
      const value = triggers[0].getAttribute(name) || '';
      if (value.length > 1024) return result({account_address: ''});
      for (const candidate of value.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu) || []) identities.add(candidate.toLowerCase());
    }
    if (identities.size === 1) account = [...identities][0];
  }
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
