import {compileSchema, digest, encode, envelope, intentDigest, OPERATIONS, requireCondition,
  RuntimeError, TERMINAL, validateRequest, validateResponse} from './protocol.mjs';
import {NoAnchor} from './anchor.mjs';

import fs, {readFileSync} from 'node:fs';
import path from 'node:path';
const validateBinding = compileSchema(JSON.parse(readFileSync(new URL('../schemas/execution-binding-v1.schema.json', import.meta.url))));

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EXECUTION = new Set(['prepare', 'invoke', 'resume', 'renew', 'reconcile']);
const KNOWN = new Set(OPERATIONS);
const CLASSES = new Set(['pure_read', 'replay_safe_local', 'external_write', 'subscription']);

export function recoveryClass(execution, sideEffect) {
  if (execution.recovery_class) return execution.recovery_class;
  if (sideEffect === 'remote_mutation') return 'external_write';
  if (sideEffect === 'local_mutation') return 'replay_safe_local';
  return execution.renewable ? 'subscription' : 'pure_read';
}

export class Executor {
  constructor({ledger, authorization, bindings, handlers, host, anchor = new NoAnchor(), clock = Date.now,
    anchorRetries = 3, rotationIntervalMs = 60_000, gcIntervalMs = 300_000, storage = {}}) {
    this.ledger = ledger; this.authorization = authorization; this.host = host; this.clock = clock; this.anchor = anchor;
    this.anchorRetries = anchorRetries;
    // Placeholder budget (design section 9); deployments derive their own.
    const budget = storage.budget_bytes ?? 2 * 1024 ** 3;
    this.storage = {budget, reserve: storage.reserve_bytes ?? Math.max(64 * 1024 ** 2, Math.floor(budget / 10)),
      directories: storage.directories ?? (authorization?.directory ? [authorization.directory] : []),
      freeFloor: storage.free_floor_bytes ?? 256 * 1024 ** 2};
    this.gcRunning = null;
    this.active = new Map(); this.lanes = new Map(); this.closing = false; this.releasing = Promise.resolve();
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
        const recovery = recoveryClass(execution, command.side_effect);
        requireCondition(CLASSES.has(recovery) && (recovery !== 'external_write' || command.side_effect === 'remote_mutation'), 'RELEASE_MISMATCH');
        this.commands.set(key, {...execution, handler, side_effect: command.side_effect, recovery_class: recovery,
          input: compileSchema(command.input_schema), output: compileSchema(command.output_schema),
          binding_digest: digest(binding)});
      }
    }
    if (rotationIntervalMs > 0) {
      this.rotation = setInterval(() => {try {this.ledger.rotate();} catch { /* retried next interval */ }}, rotationIntervalMs);
      this.rotation.unref();
    }
    if (gcIntervalMs > 0) {
      this.collector = setInterval(() => {void this.gc().catch(() => { /* retried next interval */ });}, gcIntervalMs);
      this.collector.unref();
    }
  }
  // Resolve a pending release and detect rollback before serving anything.
  async start() {
    this.ledger.recoverLocal();
    // An unreachable anchor delays only releases; reads and admission proceed.
    try {await this.ledger.verifyAnchor(this.anchor);}
    catch (error) {if (error.code !== 'ANCHOR_UNAVAILABLE') throw error;}
    return this.ledger.epochState();
  }
  authorize(request, spec) {
    const {grant, resource} = this.authorization.record(request.authorization_ref);
    const now = this.clock();
    requireCondition(grant && resource && ['principal', 'owner', 'request_key'].every(key => typeof grant[key] === 'string' && ID.test(grant[key])) &&
      ['access_expires_ms', 'execution_expires_ms', 'revision'].every(key => Number.isSafeInteger(grant[key]) && grant[key] > 0) &&
      grant.access_expires_ms >= grant.execution_expires_ms && /^[0-9a-f]{64}$/u.test(grant.intent_digest) &&
      Array.isArray(grant.operations) && grant.operations.every(op => KNOWN.has(op)), 'AUTHORIZATION_INVALID');
    requireCondition(grant.app === request.app && grant.command === request.command && grant.operations.includes(request.operation) &&
      grant.access_expires_ms > now && (!request.request_key || request.request_key === grant.request_key) &&
      (!grant.task_id || !request.task_id || grant.task_id === request.task_id), 'AUTHORIZATION_DENIED');
    // A rollback recovery raises the authorization generation; older grants
    // must be reissued from the issuer's current revocation state.
    // Epoch status is how a product learns the current generation; it reads
    // owner metadata only and is exempt from the authorization generation.
    if (request.operation === 'epoch') return {grant, resource};
    requireCondition((grant.authorization_generation ?? 1) >= this.ledger.meta('authorization_generation'), 'AUTHORIZATION_GENERATION_STALE');
    if (EXECUTION.has(request.operation)) requireCondition(grant.execution_expires_ms > now && grant.side_effect === spec.side_effect, 'AUTHORIZATION_DENIED');
    if (request.operation === 'prepare') {
      requireCondition(grant.intent_digest === intentDigest(request), 'AUTHORIZATION_DENIED');
      requireCondition(request.deadline_ms === undefined ? spec.renewable === true && grant.max_deadline_ms === null :
        Number.isSafeInteger(grant.max_deadline_ms) && now < request.deadline_ms && request.deadline_ms <= grant.max_deadline_ms, 'AUTHORIZATION_DENIED');
    }
    if (spec.renewable && EXECUTION.has(request.operation)) requireCondition(grant.execution_expires_ms <= now + 300_000, 'AUTHORIZATION_DENIED');
    // Durable access survives a compatible application update. The ledger
    // still checks the original signed owner, intent and resource below.
    // Re-execution requires today's binding; only explicitly journal-only
    // reconciliation may inspect an old resource without acquiring a Host.
    if (EXECUTION.has(request.operation) && !(request.operation === 'reconcile' && spec.reconcile_requires_host === false)) {
      requireCondition(resource.binding_digest === spec.binding_digest, 'RELEASE_MISMATCH');
    }
    return {grant, resource};
  }
  async control(request) {
    requireCondition(validateRequest(request));
    const spec = this.commands.get(`${request.app}\0${request.command}`);
    requireCondition(Boolean(spec), 'COMMAND_NOT_FOUND');
    requireCondition(this.ledger.recovered, 'EXECUTOR_RECOVERING');
    const {grant, resource} = this.authorize(request, spec);
    if (request.operation === 'epoch') return this.epoch(request);
    let row;
    if (request.operation === 'prepare') {
      requireCondition(!this.closing, 'EXECUTOR_DRAINING');
      requireCondition(spec.input(request.arguments), 'INPUT_VALIDATION_FAILED');
      const bytes = encode(request.arguments, 1536 * 1024).length;
      if (!this.ledger.find(grant)) this.admitStorage(bytes);
      row = this.ledger.prepare(request, grant, intentDigest(request), digest(resource), spec.recovery_class).row;
      return this.response(request, row);
    }
    if (request.operation === 'lookup') {
      const found = this.ledger.lookup(grant);
      if (!found.row) {
        return envelope(request, {kind: 'lookup', outcome: found.outcome, ...(found.reason ? {reason: found.reason} : {}),
          epoch_state: this.ledger.epochState()});
      }
      row = found.row;
    } else row = this.ledger.get(request.task_id);
    requireCondition(row && row.principal === grant.principal && row.owner === grant.owner &&
      row.request_key === grant.request_key && row.intent === grant.intent_digest && row.app === request.app && row.command === request.command &&
      row.resource_digest === digest(resource), 'TASK_ACCESS_DENIED');
    const active = this.active.get(row.id);
    switch (request.operation) {
      case 'invoke':
        if (row.status === 'prepared') {
          requireCondition(!this.closing, 'EXECUTOR_DRAINING');
          this.transition(row.id, 'pending');
          this.begin(this.ledger.get(row.id), spec, resource);
        }
        break;
      case 'cancel':
        if (!TERMINAL.has(row.status) && row.status !== 'uncertain') {
          this.ledger.transaction(() => this.ledger.event(row.id, 'cancel_requested', {}));
          if (active) {
            active.stopReason = 'CANCEL_REQUESTED'; active.abort.abort();
            if (row.status === 'pending') this.transition(row.id, row.effect ? 'uncertain' : 'cancelled', 'CANCEL_REQUESTED');
          } else this.transition(row.id, row.effect ? 'uncertain' : 'cancelled', 'CANCEL_REQUESTED');
        }
        return this.response(request, this.ledger.get(row.id), 'ack');
      case 'renew':
        requireCondition(spec.renewable && active && row.status === 'running', 'INVALID_TASK_STATE');
        this.refresh(row, request, grant);
        return this.response(request, this.ledger.get(row.id));
      case 'resume':
        requireCondition(!this.closing && !active && ['waiting_confirmation', 'blocked'].includes(row.status) && !row.effect, 'INVALID_TASK_STATE');
        this.refresh(row, request, grant);
        this.begin(this.ledger.get(row.id), spec, resource);
        break;
      case 'reconcile':
        requireCondition(!this.closing && !active && row.status === 'uncertain' && typeof spec.handler.reconcile === 'function', 'INVALID_TASK_STATE');
        this.refresh(row, request, grant);
        // A queued recovery must acknowledge its new admission, not the
        // original uncertain outcome that clients treat as terminal. Keep
        // the original row for the handler's trusted reconciliation facts.
        row = this.ledger.get(row.id);
        this.transition(row.id, 'pending');
        this.begin(row, spec, resource, true);
        break;
      case 'ack_result':
        this.ledger.acknowledge(row.id, request);
        return this.response(request, this.ledger.get(row.id), 'ack');
      case 'resolve':
        requireCondition(spec.recovery_class === 'external_write' && !active, 'INVALID_TASK_STATE');
        this.ledger.resolve(row.id, {resolution: request.resolution, principal: grant.principal, evidence_digest: request.evidence_digest ?? null});
        break;
      case 'events': return envelope(request, {kind: 'events', task: {id: row.id, status: row.status}, ...this.ledger.events(row, request.cursor, request.limit)});
    }
    return this.response(request, this.ledger.get(row.id));
  }
  // Current usage, not lifetime request count, decides admission. The
  // recovery reserve stays available to existing tasks, ACK and cancellation.
  usage() {
    if (this.usageCache && this.clock() - this.usageCache.at < 5000) return this.usageCache.value;
    let used = this.ledger.storageBytes();
    const walk = directory => {
      let entries;
      try {entries = fs.readdirSync(directory, {withFileTypes: true});} catch {return;}
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) {try {used += fs.statSync(file).size;} catch {}}
      }
    };
    for (const directory of this.storage.directories) walk(directory);
    let free = Infinity;
    try {const stat = fs.statfsSync(this.ledger.directory); free = stat.bavail * stat.bsize;} catch {}
    const value = {used, free, budget: this.storage.budget, reserve: this.storage.reserve};
    this.usageCache = {at: this.clock(), value};
    return value;
  }
  admitStorage(bytes) {
    const {used, free, budget, reserve} = this.usage();
    if (used >= budget * 0.7) void this.gc().catch(() => {});
    // Reserve room for the worst reasonable footprint: arguments, result,
    // compact evidence and WAL growth before admitting new work.
    const peak = bytes * 4 + 1024 * 1024;
    requireCondition(used + peak + reserve <= budget && free - peak >= this.storage.freeFloor, 'STORAGE_PRESSURE');
  }
  // Background single-writer reclamation; queries never delete.
  gc() {
    if (this.gcRunning) return this.gcRunning;
    const run = async () => {
      const report = {reclaimed: 0, events: 0, schedules: 0};
      {
        this.ledger.rotate();
        const ids = this.ledger.reclaimable(new Set(this.active.keys()));
        const queue = ids.length ? this.ledger.queueReclaim(ids) : this.ledger.reclaimQueue();
        for (const item of queue) {
          // Files are deleted only after the row is gone and the queue records
          // them; a crash simply retries this idempotent step.
          let resource = null;
          try {resource = this.authorization.record(item.grant_ref).resource;} catch {}
          const spec = this.commands.get(`${item.app}\0${item.command}`);
          if (resource && spec?.handler.reclaim) {
            try {await spec.handler.reclaim(JSON.parse(item.arguments), {resource});} catch {continue;}
          }
          try {this.authorization.remove(item.grant_ref);} catch {continue;}
          this.ledger.finishReclaim(item.task); report.reclaimed++;
        }
        report.events = this.ledger.trimEvents();
        report.schedules = this.ledger.pruneSchedules();
        this.ledger.checkpoint();
        return report;
      }
    };
    const running = run().finally(() => {if (this.gcRunning === running) this.gcRunning = null;});
    this.gcRunning = running;
    return running;
  }
  epoch(request) {
    let schedule;
    switch (request.action) {
      case 'rotate': this.ledger.rotate({force: true}); break;
      case 'seal': this.ledger.seal(request.epoch, request.drained_digest); break;
      case 'register_schedule': schedule = this.ledger.registerSchedule(request.schedule_id, request.revision); break;
      case 'delete_schedule': schedule = this.ledger.deleteSchedule(request.schedule_id); break;
      default: this.ledger.rotate();
    }
    return envelope(request, {kind: 'epoch', epoch_state: this.ledger.epochState(), ...(schedule ? {schedule} : {})});
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
    const terminal = TERMINAL.has(row.status) || row.status === 'uncertain';
    const resolution = row.resolution ? JSON.parse(row.resolution).resolution : null;
    const value = envelope(request, {kind, task: {id: row.id, status: row.status},
      ...(kind === 'ack' ? {accepted: true} : {
        ...(row.status === 'completed' ? {data: JSON.parse(row.data)} : row.reason ? {reason: row.reason} : {}),
        ...(row.attempt ? {attempt: row.attempt} : {}),
        ...(terminal && row.terminal_revision ? {terminal_revision: row.terminal_revision, result_digest: row.result_digest} : {}),
        ...(resolution ? {resolution} : {}),
        epoch_state: this.ledger.epochState()})});
    requireCondition(validateResponse(value), 'OUTPUT_VALIDATION_FAILED'); encode(value); return value;
  }
  transition(id, status, reason = null, data = null) {
    this.ledger.transaction(() => {
      this.ledger.update(id, {status, reason, data}); this.ledger.event(id, 'state', {status, ...(reason ? {reason} : {})});
    });
  }
  begin(row, spec, resource, reconcile = false) {
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
  // Release one reserved dispatch: persist consume_pending, advance the
  // independent anchor by CAS, persist released, and only then return.
  // Releases and pending-release reconciliation are strictly serialized.
  withReleaseLock(run) {
    const next = this.releasing.catch(() => {}).then(run);
    this.releasing = next;
    return next;
  }
  async settleRelease() {
    if (!this.ledger.anchorVerified) await this.ledger.verifyAnchor(this.anchor);
    if (this.ledger.pendingRelease()) await this.resolvePending();
  }
  async release(id, token) {
    const run = async () => {
      await this.settleRelease();
      const body = this.ledger.beginRelease(id, token);
      let lastError;
      for (let attempt = 0; attempt < this.anchorRetries; attempt++) {
        try {
          await this.anchor.advance(body);
          return this.ledger.completeRelease(id);
        } catch (error) {
          lastError = error;
          if (error.code === 'ANCHOR_CONFLICT') break;
        }
      }
      // The worker never receives this release. Leave the pending slot for
      // reconciliation against the anchor; the attempt stays undispatched.
      throw new RuntimeError(lastError?.code === 'ANCHOR_CONFLICT' ? 'ANCHOR_CONFLICT' : 'ANCHOR_UNAVAILABLE');
    };
    return this.withReleaseLock(run);
  }
  async resolvePending() {
    const pending = this.ledger.pendingRelease(), local = this.ledger.anchorState();
    if (!pending) return;
    const remote = await this.anchor.read();
    if (!remote || remote.generation === local.generation && remote.seq === local.seq && remote.digest === local.digest) {
      this.ledger.voidPending({adopt: false});
    } else if (remote.generation === local.generation && remote.seq === pending.seq && remote.digest === pending.digest) {
      this.ledger.voidPending({adopt: true});
    } else {
      await this.ledger.fenceForward(this.anchor, remote);
    }
  }
  async execute(row, spec, resource, active, reconcile) {
    if (TERMINAL.has(this.ledger.get(row.id).status)) return;
    let session, timer;
    const original = JSON.parse(row.request);
    try {
      requireCondition(intentDigest(original) === row.intent && digest(resource) === row.resource_digest, 'TASK_ACCESS_DENIED');
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
      const external = spec.recovery_class === 'external_write';
      // A previous attempt left in consume_pending (anchor outage or lost
      // response) is reconciled against the anchor before any new attempt.
      if (external && !reconcile && this.ledger.get(row.id).dispatch === 'consume_pending') {
        await this.withReleaseLock(() => this.settleRelease());
        requireCondition(this.ledger.get(row.id).dispatch !== 'consume_pending', 'RELEASE_PENDING');
        requireCondition(this.ledger.get(row.id).status === 'running', 'EFFECT_DENIED');
      }
      let reservation = null;
      const reserveDispatch = () => {
        check(); requireCondition(!reconcile && external, 'EFFECT_DENIED');
        reservation = this.ledger.reserveDispatch(row.id);
        return reservation.attempt;
      };
      const releaseDispatch = async () => {
        check(); requireCondition(!reconcile && external, 'EFFECT_DENIED');
        if (!reservation) reserveDispatch();
        const released = this.ledger.get(row.id);
        if (released.dispatch === 'released') return released.attempt;
        await this.release(row.id, reservation.token);
        check();
        return reservation.attempt;
      };
      const context = {task_id: row.id, epoch: this.ledger.epoch, signal: active.abort.signal, resource,
        executionEvidence: Object.freeze({task_id: row.id, intent_digest: row.intent,
          resource_digest: row.resource_digest, binding_digest: resource.binding_digest, ledger_epoch: this.ledger.epoch}),
        // Captured before the running transition, after authenticated lookup and
        // the !active admission check. Applications cannot supply these facts.
        reconciliation: reconcile ? Object.freeze({status: row.status, reason: row.reason, effect: row.effect,
          dispatch: row.dispatch, attempt: row.attempt}) : null,
        check, emit: (type, payload) => {check(); this.ledger.transaction(() => this.ledger.event(row.id, type, payload));},
        reserveDispatch, releaseDispatch,
        // External writes must be released through the anchor before acting.
        beforeEffect: async () => {
          check(); requireCondition(!reconcile && spec.side_effect !== 'read_only', 'EFFECT_DENIED');
          if (external) return releaseDispatch();
          this.ledger.transaction(() => {this.ledger.update(row.id, {effect: 1}); this.ledger.event(row.id, 'effect_started', {});});
          return null;
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
      this.finish(row.id, status, result.reason ?? null, data, external && status === 'completed' && !reconcile ? 'sent' : null);
    } catch (error) {
      let cleanupFailed = false;
      if (session) try { await session.release({invalidate: !active.stopReason}); } catch { cleanupFailed = true; }
      const current = this.ledger.get(row.id);
      const reason = cleanupFailed ? 'HOST_CLEANUP_FAILED' : active.stopReason ??
        (/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code : 'EXECUTION_FAILED');
      const recoverable = ['HOST_STALE', 'HOST_LEASE_EXPIRED', 'HOST_LEASE_INVALID', 'HOST_UNAVAILABLE', 'HOST_TIMEOUT',
        'EXECUTOR_STOPPING', 'HOST_RESOURCE_BUSY', 'BROWSER_BUSY', 'BROWSER_EXTENSION_UNAVAILABLE', 'BROWSER_PAGE_STALE',
        'ANCHOR_UNAVAILABLE', 'RELEASE_PENDING'].includes(reason);
      const state = current.effect ? 'uncertain' : cleanupFailed || recoverable ? 'blocked' :
        reason === 'CANCEL_REQUESTED' ? 'cancelled' : reason === 'AUTHORIZATION_EXPIRED' ? 'waiting_confirmation' : 'failed';
      this.finish(row.id, state, reason);
    } finally { clearInterval(timer); }
  }
  finish(id, status, reason, data = null, dispatch = null) {
    this.ledger.transaction(() => {
      // Rollback recovery already classified this task; keep its conclusion.
      const current = this.ledger.get(id);
      if (current.status === 'uncertain' && /^ROLLBACK_/u.test(current.reason ?? '')) return;
      // A reservation that was never released is provably undispatched.
      this.ledger.voidReservation(id);
      this.ledger.update(id, {status, reason, data, ...(dispatch ? {dispatch} : {})});
      this.ledger.event(id, 'state', {status, ...(reason ? {reason} : {})});
    });
  }
  async close() {
    this.closing = true; clearInterval(this.rotation); clearInterval(this.collector);
    for (const active of this.active.values()) {active.stopReason = 'EXECUTOR_STOPPING'; active.abort.abort();}
    await Promise.all([...this.active.values()].map(active => active.promise));
  }
}
