import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import {verifySendAccount,SEND_ACCOUNT_READS} from '../../applications/mail/lib/managed-send.mjs';
import {MailboxClient} from '../../applications/mail/client.mjs';

test('managed send binds the Reader mailbox instead of an Outlook login alias', async () => {
  const url = 'https://outlook.live.com/mail/0/inbox';
  let observed = 'Mailbox@Outlook.COM';
  const tab = {inspect: async expression => ({origin: url, result: await vm.runInNewContext(`(${expression})()`, {
    location: {origin: 'https://outlook.live.com', href: url}, TextEncoder, Uint8Array, crypto: crypto.webcrypto,
    window: {SparkClawMailReader: {provider: 'outlook', version: '0.2.0', snapshot: options => {assert.equal(options.interval_start, '1970-01-01T00:00:00Z'); assert.equal(options.interval_end, '1970-01-01T00:00:01Z'); return {account_address: observed};}}},
    document: {querySelector() {throw new Error('login alias must not replace Reader evidence');}},
  })})};
  await verifySendAccount(tab, 'outlook', 'mailbox@outlook.com');
  observed = 'other@outlook.com';
  await assert.rejects(verifySendAccount(tab, 'outlook', 'mailbox@outlook.com'), {code: 'email_account_identity_mismatch'});
});

// Host eval model from the .31 Outlook reply failure: one CLI eval has a fixed
// 10 s budget that also pays process start/settle (1 s) and, when the page
// issued requests during a non-trivial evaluation, Playwright's wait for them
// (5 s). The mailbox identity hydrates 7 s after navigation.
function hydratingOutlookTab({hydratedAt = 7000, domAccountAfterMenu = false} = {}) {
  const url = 'https://outlook.live.com/mail/0/inbox';
  const page = {clock: 0, evals: 0, clicks: [], presses: [], menuOpen: false};
  const unavailable = () => Object.assign(new Error('identity'), {code: 'email_account_identity_unavailable'});
  const tab = {
    click: async selector => {page.clicks.push(selector); page.menuOpen = true;},
    press: async key => {page.presses.push(key); page.menuOpen = false;},
    inspect: async expression => {
      page.evals++;
      const started = page.clock;
      const context = {
        location: {origin: 'https://outlook.live.com', href: url}, TextEncoder, Uint8Array, crypto: crypto.webcrypto,
        Date: {now: () => page.clock},
        setTimeout: (resolve, ms) => {page.clock += Math.max(ms, 1); queueMicrotask(resolve);},
        window: {SparkClawMailReader: {provider: 'outlook', version: '0.2.0', snapshot: () => {
          if (page.clock >= hydratedAt) return {account_address: 'Mailbox@Outlook.COM'};
          if (domAccountAfterMenu && page.menuOpen) return {account_address: 'mailbox@outlook.com'};
          throw unavailable();
        }}},
      };
      const result = await vm.runInNewContext(`(${expression})()`, context);
      const inPage = page.clock - started;
      const cost = inPage + 1000 + (inPage > 0 && page.clock < hydratedAt + 5000 ? 5000 : 0);
      page.clock = started + cost;
      if (cost > 10_000) throw Object.assign(new Error('browser provider script timed out'), {code: 'browser_script_timeout'});
      return {origin: url, result};
    },
  };
  return {tab, page};
}

test('Outlook sender check survives a still-hydrating mailbox instead of exceeding one eval budget', async () => {
  const {tab, page} = hydratingOutlookTab();
  await verifySendAccount(tab, 'outlook', 'mailbox@outlook.com');
  assert.ok(page.evals >= 2 && page.evals <= SEND_ACCOUNT_READS, `evals=${page.evals}`);
  assert.deepEqual(page.clicks, []);
});

test('Outlook sender check falls back to the native account menu after bounded reads and always closes it', async () => {
  const {tab, page} = hydratingOutlookTab({hydratedAt: Infinity, domAccountAfterMenu: true});
  await verifySendAccount(tab, 'outlook', 'mailbox@outlook.com');
  assert.equal(page.clicks.length, 1);
  assert.deepEqual(page.presses, ['Escape']);
  const missing = hydratingOutlookTab({hydratedAt: Infinity});
  await assert.rejects(verifySendAccount(missing.tab, 'outlook', 'mailbox@outlook.com'), {code: 'email_account_identity_mismatch'});
  assert.deepEqual(missing.page.presses, ['Escape']);
  assert.ok(missing.page.evals <= 2 * SEND_ACCOUNT_READS);
});

test('direct watch status consumes pending lifecycle events without silently renewing authorization', async () => {
  const client = Object.create(MailboxClient.prototype);
  let polled = false;
  client.pollWatch = async (provider, options) => {assert.equal(provider, 'gmail'); assert.equal(options, undefined); polled = true;};
  client.watchStatus = provider => ({provider, ready: polled});
  assert.deepEqual(await client.execute({operation: 'observe', provider: 'gmail', input: {action: 'status'}}), {provider: 'gmail', ready: true});
});
