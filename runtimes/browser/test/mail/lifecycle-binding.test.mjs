import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {compileSchema, digest} from '../../src/protocol.mjs';
import {outputSchema} from '../../applications/mail/output-schema.mjs';
import {mailHandlers} from '../../applications/mail/handlers.mjs';
import {openSendJournal} from '../../applications/mail/lib/send-journal.mjs';
import {validateManagedSend} from '../../applications/mail/lib/managed-send.mjs';
import {MailPage} from '../../applications/mail/runtime/mail-page.mjs';

for (const resolved of [true, false]) test(`legacy watch index migration preserves original lookup (${resolved})`, async t => {
  const {MailboxClient} = await import('../../applications/mail/client.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-watch-migration-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const filename = path.join(root, 'watch-' + digest({owner:'fixture-owner', provider:'gmail'}) + '.json');
  const saved = {identity:'legacy-binding-identity', sessionKey:'old-session-key'};
  await fs.writeFile(filename, JSON.stringify(saved), {mode:0o600});
  const mailbox = Object.create(MailboxClient.prototype), calls = [];
  mailbox.config = {owner_id:'fixture-owner'}; mailbox.watches = new Map();
  mailbox.describe = () => ({binding:{manifest:{id:'mail-gmail'}}, command:'watch', spec:{source_checksum:'fixture'}});
  mailbox.admission = (request, options) => {
    assert.equal(options.previousTask, 'old-task'); assert.notEqual(options.sessionKey, saved.sessionKey);
    return {grant:{execution_expires_ms:Date.now()+300000}};
  };
  mailbox.client = {index:root,
    restore(identity) {assert.equal(identity.request_key, digest({taskID:saved.sessionKey,app:'mail-gmail',command:'watch'}));calls.push('restore');return {};},
    async control(admission, operation) {assert.equal(operation,'lookup');calls.push('lookup');return resolved ? {task:{id:'old-task',status:'cancelled'}} : {kind:'lookup',outcome:'unresolved'};},
    async invoke() {calls.push('invoke');return {task:{id:'new-watch',status:'pending'}};},
  };
  const action = () => mailbox.startWatch({provider:'gmail',token:'fixture-token',credentialGeneration:2,input:{account_address:'owner@example.invalid',owner_scope:'fixture-scope'}});
  if (resolved) {
    const result = await action();assert.equal(result.result.watch_epoch,'new-watch');
    await action();assert.deepEqual(calls,['restore','lookup','invoke']);
    assert.equal(JSON.parse(await fs.readFile(filename)).taskID,'new-watch');
  } else {
    await assert.rejects(action,{code:'ADMISSION_UNRESOLVED'});
    assert.deepEqual(calls,['restore','lookup']);assert.deepEqual(JSON.parse(await fs.readFile(filename)),saved);
  }
});

test('mark-read public schema accepts the product observation receipt without inventing a status field', () => {
  const validate = compileSchema(outputSchema('qq_mail', 'mark_read'));
  const receipt = {schema_version: 1, provider: 'qq_mail', target: {}, read_state: 'read', observed_at: '2026-09-29T00:00:00Z'};
  assert.equal(validate(receipt), true);
  assert.equal(validate({...receipt, read_state: 'invented'}), false);
  assert.equal(validate({...receipt, status: 'sent'}), false);
});
test('all three installed send reconciliation handlers read journals without a browser or a second effect', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-lifecycle-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const handlers = await mailHandlers();
  for (const provider of ['gmail', 'outlook', 'qq_mail']) {
    const input = {schema_version: 1, operation: 'send', provider, account: 'default', account_address: 'owner@example.invalid',
      invocation_id: `fixture-${provider}`, mode: 'compose', message: {to: ['recipient@example.invalid'], subject: 'Fixture', body: {format: 'text', content: 'Synthetic fixture'}}};
    const validated = validateManagedSend(input, provider);
    const journal = await openSendJournal(root, validated);
    await journal.write('dispatching');
    const context = {resource: {workspace_root: root}, beforeEffect: () => assert.fail('reconciliation must not dispatch')};
    assert.equal((await handlers[`${provider}.send`].reconcile(input, context)).status, 'uncertain');
    const receipt = {schema_version: 1, provider, status: 'sent', recipient_digest: validated.recipientDigest};
    await journal.write('sent', receipt);
    assert.deepEqual((await handlers[`${provider}.send`].reconcile(input, context)).data, receipt);
    assert.equal(compileSchema(outputSchema(provider, 'send'))(receipt), true);
  }
});
test('probe loading waits use the action port while read batches remain read-only', async () => {
  const calls = [];
  const page = new MailPage({call: async (method, ...args) => {calls.push([method, args]); return method === 'probeReads' ? [] : true;}},
    {operation: 'probe'}, {resource: {}});
  await page.qqTask().onTab([['get', 'url']]);
  await page.qqTask().onTab([['wait', '200']]);
  assert.deepEqual(calls.map(value => value[0]), ['probeReads', 'act']);
});

test('retry of an uncertain local capture reconciles the original task; remote writes are not replayed', async () => {
  const {MailboxClient} = await import('../../applications/mail/client.mjs');
  for (const operation of ['collect_page', 'capture', 'read', 'send', 'mark_read']) {
    const mailbox = Object.create(MailboxClient.prototype), calls = [];
    mailbox.admission = () => ({existing: true, grant: {max_deadline_ms: Date.now() + 10000}});
    mailbox.describe = () => ({spec: {source_checksum: 'fixture-checksum'}});
    mailbox.client = {
      async invoke() {return {kind: 'task', task: {id: 'original', status: 'uncertain'}};},
      refresh(admission, id, op) {
        calls.push({id, op});
        return {admission, acknowledged: Promise.resolve({kind: 'task', task: {id, status: 'completed'}, data: {status: 'collected'}})};
      },
      async wait(admission, response) {return response;},
    };
    const result = await mailbox.execute({provider: 'gmail', operation, input: {}});
    if (['send', 'mark_read'].includes(operation)) {
      assert.deepEqual(calls, []); assert.equal(result.state, 'failed');
    } else {
      assert.deepEqual(calls, [{id: 'original', op: 'reconcile'}]); assert.equal(result.state, 'completed');
    }
  }
});

test('send reconciliation after credential rotation uses original journal authority without new admission', async () => {
  const {MailboxClient} = await import('../../applications/mail/client.mjs');
  const mailbox = Object.create(MailboxClient.prototype), calls = [];
  mailbox.config = {owner_id: 'fixture-owner'};
  const original = {arguments: {mode: 'compose', message: {body: 'original'}}};
  const admission = {request: original, grant: {}, resource: {credential_generation: 1}, existing: true};
  mailbox.describe = () => ({binding: {manifest: {id: 'mail-gmail'}}, command: 'send', spec: {script_id: 'send', revision: 'test', source_checksum: 'test'}});
  mailbox.admission = () => assert.fail('journal reconciliation must not rebind current credentials');
  mailbox.client = {
    restore() {calls.push('restore'); return admission;},
    async control(value, operation) {assert.equal(value, admission); calls.push(operation); return {kind: 'task', task: {id: 'original-task', status: 'uncertain'}};},
    refresh(value, id, operation) {assert.equal(value, admission); assert.equal(id, 'original-task'); calls.push(operation);
      return {admission, acknowledged: Promise.resolve({kind: 'task', task: {id, status: 'completed'}, data: {status: 'sent'}})};},
    async wait(value, response) {return response;},
  };
  const result = await mailbox.execute({provider: 'gmail', operation: 'send', input: {...original.arguments, mode: 'reconcile'},
    taskID: 'original', credentialGeneration: 2, token: 'fixture-new-token', scriptID: 'send', revision: 'test'});
  assert.equal(result.state, 'completed'); assert.deepEqual(calls, ['restore', 'lookup', 'reconcile']);
});
