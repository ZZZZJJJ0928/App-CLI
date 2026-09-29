import {compileSchema, digest, encode, envelope, intentDigest, requireCondition,
  RuntimeError, TERMINAL, validateRequest, validateResponse} from './protocol.mjs';

import {readFileSync} from 'node:fs';
const validateBinding = compileSchema(JSON.parse(readFileSync(new URL('../schemas/execution-binding-v1.schema.json', import.meta.url))));

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EXECUTION = new Set(['invoke', 'resume', 'renew', 'reconcile']);
const OPERATIONS = new Set(['invoke', 'lookup', 'status', 'cancel', 'resume', 'renew', 'events', 'reconcile']);
export class Executor {
  constructor({ledger, authorization, bindings, handlers, host, clock = Date.now}) {
    this.ledger = ledger; this.authorization = authorization; this.host = host; this.clock = clock;
    this.active = new Map(); this.lanes = new Map(); this.closing = false;
    // Bindings are installed release inputs, never accepted from a wire request.
    this.commands = new Map();
    for (const binding of bindings) {
      requireCondition(validateBinding(binding), "RELEASE_MISMATCH");
      requireCondition(binding.manifest_digest === digest(binding.manifest), 'RELEASE_MISMATCH');
      for (const command of binding.manifest.commands) {
        const execution = binding.commands[command.name], handler = handlers[execution?.handler];
        requireCondition(handler && typeof handler.run === 'function', 'RELEASE_MISMATCH');
        const key = `${binding.manifest.id}\0${command.name}`;
        requireCondition(!this.commands.has(key), 'RELEASE_MISMATCH');
        this.commands.set(key, {...execution, handler, side_effect: command.side_effect,
          input: compileSchema(command.input_schema), output: compileSchema(command.output_schema),
          binding_digest: digest(binding)});
      }
    }
  }
  authorize(request, spec) {
    const {grant, resource} = this.authorization.record(request.authorization_ref);
    const now = this.clock();
    requireCondition(grant && resource && ['principal', 'owner', 'request_key'].every(key => typeof grant[key] === 'string' && ID.test(grant[key])) &&
      ['access_expires_ms', 'execution_expires_ms', 'revision'].every(key => Number.isSafeInteger(grant[key]) && grant[key] > 0) &&
      grant.access_expires_ms >= grant.execution_expires_ms && /^[0-9a-f]{64}$/u.test(grant.intent_digest) &&
      Array.isArray(grant.operations) && grant.operations.every(op => OPERATIONS.has(op)), 'AUTHORIZATION_INVALID');
    requireCondition(grant.app === request.app && grant.command === request.command && grant.operations.includes(request.operation) &&
      grant.access_expires_ms > now && (!request.request_key || request.request_key === grant.request_key) &&
      (!grant.task_id || !request.task_id || grant.task_id === request.task_id), 'AUTHORIZATION_DENIED');
    if (EXECUTION.has(request.operation)) requireCondition(grant.execution_expires_ms > now && grant.side_effect === spec.side_effect, 'AUTHORIZATION_DENIED');
    if (request.operation === 'invoke') {
      requireCondition(grant.intent_digest === intentDigest(request), 'AUTHORIZATION_DENIED');
      requireCondition(request.deadline_ms === undefined ? spec.renewable === true && grant.max_deadline_ms === null :
        Number.isSafeInteger(grant.max_deadline_ms) && now < request.deadline_ms && request.deadline_ms <= grant.max_deadline_ms, 'AUTHORIZATION_DENIED');
    }
    if (spec.renewable) requireCondition(grant.execution_expires_ms <= now + 300_000, 'AUTHORIZATION_DENIED');
    requireCondition(resource.binding_digest === spec.binding_digest, 'RELEASE_MISMATCH');
    return {grant, resource};
  }
  async control(request) {
    requireCondition(validateRequest(request));
    const spec = this.commands.get(`${request.app}\0${request.command}`);
    requireCondition(Boolean(spec), 'COMMAND_NOT_FOUND');
    const {grant, resource} = this.authorize(request, spec);
    let row;
    if (request.operation === 'invoke') {
      requireCondition(!this.closing, 'EXECUTOR_DRAINING');
      requireCondition(spec.input(request.arguments), 'INPUT_VALIDATION_FAILED');
      encode(request.arguments, 1536 * 1024);
      const admitted = this.ledger.admit(request, grant, intentDigest(request), digest(resource));
      row = admitted.row;
      if (admitted.fresh) this.start(row, spec, resource);
    } else {
      row = request.operation === 'lookup' ? this.ledger.find(grant) : this.ledger.get(request.task_id);
      if (!row && request.operation === 'lookup') return envelope(request, {kind: 'lookup', outcome: 'unresolved'});
      requireCondition(row && row.principal === grant.principal && row.owner === grant.owner &&
        row.request_key === grant.request_key && row.intent === grant.intent_digest && row.app === request.app && row.command === request.command &&
        row.resource_digest === digest(resource), 'TASK_ACCESS_DENIED');
      const active = this.active.get(row.id);
      switch (request.operation) {
        case 'cancel':
          if (!TERMINAL.has(row.status)) {
            this.ledger.event(row.id, 'cancel_requested', {});
            if (active) {
              active.stopReason = 'CANCEL_REQUESTED'; active.abort.abort();
              if (row.status === 'pending') this.transition(row.id, 'cancelled', 'CANCEL_REQUESTED');
            }
            else this.transition(row.id, row.effect ? 'uncertain' : 'cancelled', 'CANCEL_REQUESTED');
          }
          return this.response(request, this.ledger.get(row.id), 'ack');
        case 'renew':
          requireCondition(spec.renewable && active && row.status === 'running', 'INVALID_TASK_STATE');
          this.refresh(row, request, grant);
          return this.response(request, this.ledger.get(row.id), 'ack');
        case 'resume':
          requireCondition(!this.closing && !active && ['waiting_confirmation', 'blocked'].includes(row.status) && !row.effect, 'INVALID_TASK_STATE');
          this.refresh(row, request, grant);
          this.start(this.ledger.get(row.id), spec, resource);
          break;
        case 'reconcile':
          requireCondition(!this.closing && !active && row.status === 'uncertain' && typeof spec.handler.reconcile === 'function', 'INVALID_TASK_STATE');
          this.refresh(row, request, grant);
          this.start(this.ledger.get(row.id), spec, resource, true);
          break;
        case 'events': return envelope(request, {kind: 'events', task: {id: row.id, status: row.status}, ...this.ledger.events(row, request.cursor, request.limit)});
      }
    }
    return this.response(request, this.ledger.get(row.id));
  }
  refresh(row, request, grant) {
    requireCondition(grant.revision >= row.grant_revision && (grant.revision > row.grant_revision ||
      (request.authorization_ref === row.grant_ref && grant.execution_expires_ms === row.expires)), 'AUTHORIZATION_STALE');
    if (request.authorization_ref === row.grant_ref) return;
    this.ledger.transaction(() => {
      this.ledger.update(row.id, {grant_ref: request.authorization_ref, grant_revision: grant.revision, expires: grant.execution_expires_ms});
      this.ledger.event(row.id, 'authorization_renewed', {revision: grant.revision});
    });
  }
  response(request, row, kind = 'task') {
    const value = envelope(request, {kind, task: {id: row.id, status: row.status},
      ...(kind === 'ack' ? {accepted: true} : row.status === 'completed' ? {data: JSON.parse(row.data)} : row.reason ? {reason: row.reason} : {})});
    requireCondition(validateResponse(value), 'OUTPUT_VALIDATION_FAILED'); encode(value); return value;
  }
  transition(id, status, reason = null, data = null) {
    this.ledger.transaction(() => {
      this.ledger.update(id, {status, reason, data}); this.ledger.event(id, 'state', {status, ...(reason ? {reason} : {})});
    });
  }
  start(row, spec, resource, reconcile = false) {
    const active = {abort: new AbortController(), stopReason: null};
    this.active.set(row.id, active);
    const lane = `${row.owner}\0${spec.resource ?? row.app}`;
    const prior = this.lanes.get(lane) ?? Promise.resolve();
    active.promise = prior.catch(() => {}).then(() => this.execute(row, spec, resource, active, reconcile));
    this.lanes.set(lane, active.promise);
    void active.promise.finally(() => {
      this.active.delete(row.id);
      if (this.lanes.get(lane) === active.promise) this.lanes.delete(lane);
    }).catch(() => {});
  }
  async execute(row, spec, resource, active, reconcile) {
    if (TERMINAL.has(this.ledger.get(row.id).status)) return;
    let session, timer;
    const original = JSON.parse(row.request);
    try {
      const check = () => {
        const current = this.ledger.get(row.id);
        if (this.clock() >= current.expires) { active.stopReason = 'AUTHORIZATION_EXPIRED'; active.abort.abort(); }
        if (!reconcile && original.deadline_ms && this.clock() >= original.deadline_ms) { active.stopReason = 'DEADLINE_EXCEEDED'; active.abort.abort(); }
        if (active.abort.signal.aborted) throw new RuntimeError(active.stopReason ?? 'CANCEL_REQUESTED');
      };
      check();
      this.transition(row.id, 'running');
      timer = setInterval(() => { try { check(); } catch { /* Handler receives the abort signal. */ } }, 100);
      timer.unref();
      const context = {task_id: row.id, epoch: this.ledger.epoch, signal: active.abort.signal, resource,
        check, emit: (type, payload) => {check(); this.ledger.transaction(() => this.ledger.event(row.id, type, payload));},
        beforeEffect: () => {
          check(); requireCondition(!reconcile && spec.side_effect !== 'read_only', 'EFFECT_DENIED');
          this.ledger.transaction(() => {this.ledger.update(row.id, {effect: 1}); this.ledger.event(row.id, 'effect_started', {});});
        },
        authorization: () => this.ledger.get(row.id).grant_ref};
      if (spec.host && !(reconcile && spec.reconcile_requires_host === false)) {
        requireCondition(this.host, 'HOST_UNAVAILABLE');
        session = await this.host.acquire({...context, binding: spec, resource});
        context.browser = session;
      }
      const result = await spec.handler[reconcile ? 'reconcile' : 'run'](original.arguments, context);
      check();
      let status = result?.status ?? 'completed';
      requireCondition(['completed', 'waiting_confirmation', 'uncertain', 'failed', 'blocked'].includes(status), 'OUTPUT_VALIDATION_FAILED');
      if (this.ledger.get(row.id).effect && ['blocked', 'waiting_confirmation'].includes(status)) status = 'uncertain';
      let data = null;
      if (status === 'completed') {
        requireCondition(spec.output(result.data), 'OUTPUT_VALIDATION_FAILED');
        data = encode(result.data, 1000 * 1024).toString();
      }
      if (session) {await session.release({park: status === 'completed' && result.retain === true && spec.host?.reuse_idle_ms > 0, invalidate: result.invalidate === true}); session = null;}
      check();
      this.transition(row.id, status, result.reason ?? null, data);
    } catch (error) {
      let cleanupFailed = false;
      if (session) try { await session.release({invalidate: !active.stopReason}); } catch { cleanupFailed = true; }
      const current = this.ledger.get(row.id);
      const reason = cleanupFailed ? 'HOST_CLEANUP_FAILED' : active.stopReason ??
        (/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code : 'EXECUTION_FAILED');
      const recoverable = ['HOST_STALE', 'HOST_LEASE_EXPIRED', 'HOST_LEASE_INVALID', 'HOST_UNAVAILABLE', 'HOST_TIMEOUT',
        'EXECUTOR_STOPPING', 'HOST_RESOURCE_BUSY', 'BROWSER_BUSY', 'BROWSER_EXTENSION_UNAVAILABLE', 'BROWSER_PAGE_STALE'].includes(reason);
      const state = current.effect ? 'uncertain' : cleanupFailed || recoverable ? 'blocked' :
        reason === 'CANCEL_REQUESTED' ? 'cancelled' : reason === 'AUTHORIZATION_EXPIRED' ? 'waiting_confirmation' : 'failed';
      this.transition(row.id, state, reason);
    } finally { clearInterval(timer); }
  }
  async close() {
    this.closing = true;
    for (const active of this.active.values()) {active.stopReason = 'EXECUTOR_STOPPING'; active.abort.abort();}
    await Promise.all([...this.active.values()].map(active => active.promise));
  }
}
