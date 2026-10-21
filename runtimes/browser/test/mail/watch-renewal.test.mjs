import assert from 'node:assert/strict';
import test from 'node:test';
import {MailboxClient} from '../../applications/mail/client.mjs';

function fixture(states, renewalError) {
  const mailbox = Object.create(MailboxClient.prototype), calls = [], events = [];
  const admission = {grant: {execution_expires_ms: Date.now() - 1000}};
  const watch = {admission, task: {id: 'original-watch', status: 'running'}, cursor: 0,
    expires: admission.grant.execution_expires_ms, ready: true, state: 'watching',
    onEvent(value, kind) {events.push({kind, state: value.state});}};
  mailbox.watches = new Map([['outlook', watch]]); mailbox.watchWork = new Map();
  mailbox.client = {
    async control(value, operation, id, extra) {
      calls.push(operation); assert.equal(id, 'original-watch');
      assert.equal(operation, 'events');
      return {task: {id, status: states.shift() ?? 'running'}, cursor: extra.cursor + 1, events: []};
    },
    renew(value, id) {
      calls.push('renew'); assert.equal(id, 'original-watch');
      return {admission: {grant: {execution_expires_ms: Date.now() + 300000}},
        acknowledged: renewalError ? Promise.reject(Object.assign(new Error(renewalError), {code: renewalError})) : Promise.resolve()};
    },
  };
  return {mailbox, watch, calls, events};
}

test('an expired cached running watch converges to its terminal result before renewal', async () => {
  const {mailbox, watch, calls, events} = fixture(['failed'], 'INVALID_TASK_STATE');
  watch.pendingRenewal = true;
  await mailbox.pollWatch('outlook', {renew: true});
  assert.deepEqual(calls, ['events']); assert.equal(watch.state, 'degraded');
  assert.equal(watch.task.status, 'failed'); assert.equal(watch.pendingRenewal, false);
  assert.deepEqual(events.at(-1), {kind: 'state', state: 'degraded'});
});

for (const code of ['INVALID_TASK_STATE', 'AUTHORIZATION_DENIED']) test(`watch failure racing renewal converges after ${code}`, async () => {
  const {mailbox, watch, calls} = fixture(['running', 'failed'], code);
  await mailbox.pollWatch('outlook', {renew: true});
  assert.deepEqual(calls, ['events', 'renew', 'events']);
  assert.equal(watch.state, 'degraded'); assert.equal(watch.pendingRenewal, false);
});

test('failed renewal of a still-running watch stays visible and is not replaced', async () => {
  const {mailbox, watch, calls} = fixture(['running', 'running'], 'AUTHORIZATION_DENIED');
  await assert.rejects(mailbox.pollWatch('outlook', {renew: true}), {code: 'AUTHORIZATION_DENIED'});
  assert.deepEqual(calls, ['events', 'renew', 'events']);
  assert.equal(watch.task.id, 'original-watch'); assert.equal(watch.pendingRenewal, true);
});

test('live watch is renewed after reading its current state', async () => {
  const {mailbox, watch, calls} = fixture(['running']);
  await mailbox.pollWatch('outlook', {renew: true});
  assert.deepEqual(calls, ['events', 'renew']);
  assert.equal(watch.pendingRenewal, false); assert.ok(watch.expires > Date.now() + 200000);
});
