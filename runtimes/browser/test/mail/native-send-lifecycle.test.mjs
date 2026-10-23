import test from 'node:test';
import assert from 'node:assert/strict';
import {MailboxClient} from '../../applications/mail/client.mjs';

const account = 'owner@example.invalid';
test('QQ sends share only a same-account credential-bound mutation pool', async () => {
  const client = Object.create(MailboxClient.prototype);
  client.config = {owner_id: 'owner', profile_id: 'profile', workspace_root: '/workspace', host_runtime_root: '/host'};
  client.sharedPages = true; client.watches = new Map();
  client.describe = (provider, operation) => ({binding: {manifest: {id: provider}}, command: operation,
    spec: {script_id: operation, revision: 1}, manifest: {side_effect: 'remote_mutation'}});
  client.requestKey = async (_app, _command, task) => task;
  client.client = {authorize: async request => request};
  const request = {provider: 'qq_mail', operation: 'send', input: {account_address: account},
    taskID: 'first', credentialGeneration: 1, token: 'fixture', scriptID: 'send', revision: 1};
  const pool = async change => (await client.admission({...request, ...change})).resource.pool_key;
  const first = await pool({});
  assert.equal(await pool({taskID: 'second'}), first);
  for (const change of [{credentialGeneration: 2}, {input: {account_address: 'other@example.invalid'}},
    {input: {account_address: account, owner_scope: 'different'}}, {operation: 'mark_read', scriptID: 'mark_read'},
    {operation: 'read', scriptID: 'read'}, {provider: 'gmail'}]) assert.notEqual(await pool(change), first);
});
