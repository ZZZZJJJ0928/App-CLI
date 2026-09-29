import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import {verifySendAccount} from '../../applications/mail/lib/managed-send.mjs';
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

test('direct watch status consumes pending lifecycle events without silently renewing authorization', async () => {
  const client = Object.create(MailboxClient.prototype);
  let polled = false;
  client.pollWatch = async (provider, options) => {assert.equal(provider, 'gmail'); assert.equal(options, undefined); polled = true;};
  client.watchStatus = provider => ({provider, ready: polled});
  assert.deepEqual(await client.execute({operation: 'observe', provider: 'gmail', input: {action: 'status'}}), {provider: 'gmail', ready: true});
});
