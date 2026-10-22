import {verifyRelease} from './release.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {MachineSessionPool} from './machine-session.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {SignedFileAuthorization, privateDirectory, privateRead} from './authorization.mjs';
import {operationIdentity, parseIdentity} from './identity.mjs';
import {decode, digest, encode, intentDigest, OPERATIONS, PROTOCOL_VERSION, requireCondition, RESPONSE_LIMIT, RuntimeError} from './protocol.mjs';

const TRANSPORT = new Set(['CONTROL_TIMEOUT', 'BACKEND_UNAVAILABLE', 'BACKEND_EXECUTION_FAILED', 'BACKEND_TIMEOUT', 'BACKEND_PROTOCOL_INVALID']);
const TASK_OPERATIONS = OPERATIONS.filter(operation => operation !== 'epoch');

function durableWrite(directory, filename, value, {exclusive = false} = {}) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), {flag: 'wx', mode: 0o600});
  const fd = fs.openSync(temporary, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  let written = true;
  if (exclusive) {
    try {fs.linkSync(temporary, filename);} catch (error) {if (error.code !== 'EEXIST') throw error; written = false;}
    finally {fs.unlinkSync(temporary);}
  } else fs.renameSync(temporary, filename);
  const dir = fs.openSync(directory, 'r'); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
  return written;
}

// Trusted embedding client: callers must already have passed product admission.
// This is deliberately not a wire operation and cannot turn an `approved` field
// into authority. Every operation still crosses Python Registry.control.
export class ProductClient {
  constructor({configFile, python, sessions = true}) {
    requireCondition(path.isAbsolute(configFile) && path.isAbsolute(python), 'CONFIGURATION_INVALID');
    this.configFile = configFile; this.python = python; this.config = decode(privateRead(configFile));
    // Resident machine sessions amortize interpreter start and release
    // verification; every request still crosses Registry.control.
    this.sessions = sessions ? new MachineSessionPool({python, env: {...process.env, APP_CLI_CONFIG: configFile},
      ...(typeof sessions === 'object' ? sessions : {})}) : null;
    if (this.config.release_digest) verifyRelease(this.config);
    this.authorization = new SignedFileAuthorization(this.config.grants_directory, this.config.issuer_key_file);
    this.index = path.join(this.config.grants_directory, 'index'); privateDirectory(this.index);
    this.epochFile = path.join(this.index, 'epoch-state.json');
    this.epochState = fs.existsSync(this.epochFile) ? decode(privateRead(this.epochFile)) : null;
  }
  async machine(request) {
    const value = this.sessions ? await this.sessions.exchange(request) : null;
    if (value === null) return this.machineOnce(request);
    return this.accept(value);
  }
  accept(value) {
    requireCondition(value.protocol_version === PROTOCOL_VERSION, 'BACKEND_PROTOCOL_INVALID');
    if (value.kind === 'error') throw new RuntimeError(value.error.code, value.error.reason);
    this.observe(value.epoch_state);
    return value;
  }
  close() {this.sessions?.close();}
  machineOnce(request) {
    const payload = encode(request, 2 * 1024 * 1024);
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, ['-m', 'app_cli', '--machine'], {shell: false,
        env: {...process.env, APP_CLI_CONFIG: this.configFile}, stdio: ['pipe', 'pipe', 'ignore'], detached: true});
      const chunks = []; let size = 0, finished = false;
      const kill = () => {try {process.kill(-child.pid, 'SIGKILL');} catch {}};
      const finish = (error, value) => {
        if (finished) return; finished = true; clearTimeout(timer); kill();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new RuntimeError('CONTROL_TIMEOUT')), 25000);
      child.on('error', () => finish(new RuntimeError('BACKEND_UNAVAILABLE')));
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {size += chunk.length; if (size > RESPONSE_LIMIT) finish(new RuntimeError('OUTPUT_VALIDATION_FAILED')); else chunks.push(chunk);});
      child.on('close', () => {
        try {
          finish(null, this.accept(decode(Buffer.concat(chunks), RESPONSE_LIMIT)));
        } catch (error) {finish(error);}
      });
      child.stdin.end(payload);
    });
  }
  // Remember the last epoch state reported by the executor. Identities are
  // issued in its open epoch even while the executor is unreachable.
  observe(state) {
    if (!state || this.epochState && digest(state) === digest(this.epochState)) return;
    if (this.epochState && (state.generation < this.epochState.generation ||
        state.generation === this.epochState.generation && state.open_epoch < this.epochState.open_epoch)) return;
    this.epochState = state;
    durableWrite(this.index, this.epochFile, state);
  }
  allocate() {
    requireCondition(this.epochState, 'EPOCH_STATE_UNAVAILABLE');
    return operationIdentity({generation: this.epochState.generation, epoch: this.epochState.open_epoch});
  }
  headFile(identity) {return path.join(this.index, digest(identity) + '.head.json');}
  legacyFile(identity) {return path.join(this.index, digest(identity) + '.json');}
  // Fixed authorization slots per request: current, one candidate and one
  // transitional previous version. Renewal never grows a chain.
  head({principal, owner, request_key}) {
    const identity = {principal, owner, request_key};
    const file = this.headFile(identity);
    if (fs.existsSync(file)) return decode(privateRead(file, 2 * 1024 * 1024));
    const legacy = this.legacyFile(identity);
    if (!fs.existsSync(legacy)) return null;
    // Migrate a lifecycle 2.0 index and its `.next` chain to a head record.
    const saved = decode(privateRead(legacy, 2 * 1024 * 1024));
    let reference = saved.reference, previous = null, revision = 1;
    while (fs.existsSync(path.join(this.index, reference + '.next'))) {
      previous = reference; revision++;
      reference = decode(privateRead(path.join(this.index, reference + '.next'))).reference;
    }
    const head = {schema_version: 1, revision, request: saved.request, current: reference, previous, candidate: null, legacy: true};
    durableWrite(this.index, file, head);
    return head;
  }
  record(reference) {return this.authorization.record(reference);}
  admissionFrom(head) {
    let record;
    try {record = this.record(head.current);}
    catch (error) {
      // The executor reclaims the current grant with its task row only after
      // the request epoch was sealed: the original identity is retired.
      if (error.code !== 'AUTHORIZATION_UNAVAILABLE') throw error;
      let identity;
      try {identity = parseIdentity(head.request.request_key);} catch {throw error;}
      const state = this.epochState;
      if (identity.kind === 'operation' && state && (identity.generation < state.generation || identity.epoch <= state.sealed_through)) {
        throw new RuntimeError('OPERATION_RETIRED', 'reclaimed');
      }
      throw error;
    }
    const {grant, resource} = record;
    return {request: {...head.request, authorization_ref: head.current}, grant, resource, existing: true};
  }
  issueGrant(grant, resource) {
    return this.authorization.issue({...grant, authorization_generation: this.epochState?.authorization_generation ?? 1}, resource);
  }
  authorize({app, command, arguments: args, request_key, principal, owner, resource, side_effect, timeout_ms, renewable = false}) {
    const identity = {principal, owner, request_key}, file = this.headFile(identity);
    const existing = () => {
      const admission = this.admissionFrom(this.head(identity));
      const request = {...admission.request, operation: 'prepare', app, command, request_key, arguments: args};
      requireCondition(admission.grant.principal === principal && admission.grant.owner === owner && admission.grant.side_effect === side_effect &&
        admission.grant.intent_digest === intentDigest(request) && digest(admission.resource) === digest(resource), 'REQUEST_KEY_CONFLICT');
      return admission;
    };
    if (this.head(identity)) return existing();
    const now = Date.now(), deadline = renewable ? null : now + timeout_ms;
    const request = {protocol_version: PROTOCOL_VERSION, operation: 'prepare', app, command, request_key, arguments: args,
      ...(deadline ? {deadline_ms: deadline} : {})};
    const grant = {principal, owner, app, command, request_key, side_effect, intent_digest: intentDigest(request),
      operations: TASK_OPERATIONS, access_expires_ms: now + 30 * 86400000, execution_expires_ms: renewable ? now + 300000 : deadline,
      max_deadline_ms: deadline, task_id: null, revision: 1};
    const reference = this.issueGrant(grant, resource);
    const created = durableWrite(this.index, file, {schema_version: 1, revision: 1, request, current: reference, previous: null, candidate: null},
      {exclusive: true});
    if (!created) this.authorization.remove?.(reference);
    const admission = existing(); admission.existing = created ? false : true; return admission;
  }
  restore({principal, owner, request_key}) {
    const head = this.head({principal, owner, request_key});
    requireCondition(head, 'ADMISSION_UNRESOLVED');
    const admission = this.admissionFrom(head);
    requireCondition(admission.grant.principal === principal && admission.grant.owner === owner && admission.grant.request_key === request_key, 'TASK_ACCESS_DENIED');
    return admission;
  }
  original(identity) {return this.restore(identity).request;}
  async control(admission, operation, task_id, extra = {}) {
    const send = value => this.machine({protocol_version: PROTOCOL_VERSION, app: value.request.app, command: value.request.command,
      authorization_ref: value.request.authorization_ref, operation,
      ...(operation === 'lookup' ? {request_key: value.request.request_key} : {task_id}), ...extra});
    try {return await send(admission);}
    catch (error) {
      if (error.code !== 'AUTHORIZATION_GENERATION_STALE') throw error;
      // Rollback recovery invalidated older grants: learn the new generation
      // and reissue this request's authorization from the current head.
      await this.epoch({app: admission.request.app, command: admission.request.command, principal: admission.grant.principal,
        owner: admission.grant.owner, resource: admission.resource, side_effect: admission.grant.side_effect});
      const renewed = this.reissue(admission, task_id ?? admission.grant.task_id ?? null);
      Object.assign(admission, renewed);
      return send(renewed);
    }
  }
  reissue(admission, task_id) {
    const identity = {principal: admission.grant.principal, owner: admission.grant.owner, request_key: admission.grant.request_key};
    const head = this.head(identity), file = this.headFile(identity);
    const base = this.record(head.current);
    const grant = {...base.grant, task_id, revision: base.grant.revision + 1,
      operations: [...new Set([...base.grant.operations, ...TASK_OPERATIONS])]};
    const reference = this.issueGrant(grant, base.resource);
    const next = {...head, revision: head.revision + 1, previous: head.current, current: reference, candidate: null};
    delete next.legacy;
    durableWrite(this.index, file, next);
    if (head.previous && !head.legacy) this.authorization.remove?.(head.previous);
    return this.admissionFrom(next);
  }
  async lookup(admission) {
    try {return await this.control(admission, 'lookup');}
    catch (error) {
      if (TRANSPORT.has(error.code)) return {kind: 'lookup', outcome: 'unresolved'};
      throw error;
    }
  }
  // prepare (durable admission without side effects), then invoke the task.
  async invoke(admission) {
    let prepared;
    if (admission.existing) {
      const known = await this.lookup(admission);
      if (known.kind === 'task') prepared = known;
      else if (known.outcome === 'retired') throw new RuntimeError('OPERATION_RETIRED', known.reason);
      else if (known.outcome === 'unresolved') throw new RuntimeError('ADMISSION_UNRESOLVED');
    }
    if (!prepared) {
      try {prepared = await this.machine(admission.request);}
      catch (error) {
        if (!TRANSPORT.has(error.code)) throw error;
        // A lost control response is not permission to submit a new operation.
        const original = await this.lookup(admission);
        if (original.kind !== 'task') throw new RuntimeError('ADMISSION_UNRESOLVED');
        prepared = original;
      }
    }
    if (prepared.task.status !== 'prepared') return prepared;
    return this.control(admission, 'invoke', prepared.task.id);
  }
  async wait(admission, response, {signal, interval = 250} = {}) {
    // Short tasks finish within a few status reads; long ones settle at the cap.
    for (let reads = 1; response.kind === 'task' && ['prepared', 'pending', 'running'].includes(response.task.status); reads++) {
      if (signal?.aborted) {
        await this.control(admission, 'cancel', response.task.id);
        return this.control(admission, 'status', response.task.id);
      }
      await delay(Math.min(interval, 50 * reads));
      response = await this.control(admission, 'status', response.task.id);
    }
    return response;
  }
  // Renewal: compare-and-swap on the head revision. A repeated renewal_id still
  // held in a slot returns the same version instead of creating another.
  refresh(admission, task_id, operation, {renewal_id = randomUUID()} = {}) {
    requireCondition(['renew', 'reconcile', 'resume', 'status', 'resolve', 'ack_result'].includes(operation), 'CAPABILITY_NOT_SUPPORTED');
    if (operation === 'renew') requireCondition(admission.grant.max_deadline_ms === null, 'CAPABILITY_NOT_SUPPORTED');
    const identity = {principal: admission.grant.principal, owner: admission.grant.owner, request_key: admission.grant.request_key};
    const head = this.head(identity), file = this.headFile(identity);
    requireCondition(head, 'ADMISSION_UNRESOLVED');
    if (head.renewal_id === renewal_id && head.current) {
      const updated = this.admissionFrom(head);
      return {admission: updated, acknowledged: this.control(updated, operation, task_id)};
    }
    const base = this.record(head.current).grant;
    requireCondition(admission.grant.revision <= base.revision, 'AUTHORIZATION_STALE');
    if (admission.grant.revision < base.revision && base.task_id === task_id) {
      // The head already advanced from this caller's revision (a lost
      // acknowledgement or a concurrent renewal): converge on it.
      const updated = this.admissionFrom(head);
      return {admission: updated, acknowledged: this.control(updated, operation, task_id)};
    }
    const grant = {...base, task_id, revision: base.revision + 1, execution_expires_ms: Date.now() + 300000,
      operations: [...new Set([...base.operations.filter(op => op !== 'invoke'), ...TASK_OPERATIONS])]};
    if (!grant.max_deadline_ms) grant.max_deadline_ms = null;
    requireCondition(grant.execution_expires_ms < grant.access_expires_ms, 'AUTHORIZATION_EXPIRED');
    const reference = this.issueGrant(grant, this.record(head.current).resource);
    const evicted = head.previous;
    const next = {...head, revision: head.revision + 1, previous: head.current, current: reference, candidate: null, renewal_id};
    delete next.legacy;
    durableWrite(this.index, file, next);
    // The evicted version is beyond the three fixed slots; no lease references it.
    if (evicted && !head.legacy) this.authorization.remove?.(evicted);
    const updated = this.admissionFrom(next);
    return {admission: updated, acknowledged: this.control(updated, operation, task_id)};
  }
  renew(admission, task_id) {return this.refresh(admission, task_id, 'renew');}
  // Durable receiver confirmation of a terminal result (design section 4).
  ack(admission, response, {receiver_id, receipt_id}) {
    requireCondition(response.terminal_revision && response.result_digest, 'INVALID_TASK_STATE');
    return this.control(admission, 'ack_result', response.task.id, {result_digest: response.result_digest,
      terminal_revision: response.terminal_revision, receiver_id, receipt_id});
  }
  resolve(admission, task_id, resolution, evidence_digest) {
    return this.control(admission, 'resolve', task_id, {resolution, ...(evidence_digest ? {evidence_digest} : {})});
  }
  // Owner-level epoch control uses a dedicated control grant per command.
  controlAdmission({app, command, principal, owner, resource, side_effect}) {
    const request_key = `ctl.${digest({principal, owner, app, command}).slice(0, 32)}`;
    const now = Date.now();
    const grant = {principal, owner, app, command, request_key, side_effect, intent_digest: digest({control: request_key}),
      operations: ['epoch'], access_expires_ms: now + 600000, execution_expires_ms: now + 600000, max_deadline_ms: null,
      task_id: null, revision: 1};
    return {request: {app, command, authorization_ref: this.issueGrant(grant, resource)}, grant, resource};
  }
  async epoch(control, action = 'status', extra = {}) {
    const admission = this.controlAdmission(control);
    try {
      return await this.machine({protocol_version: PROTOCOL_VERSION, app: control.app, command: control.command,
        authorization_ref: admission.request.authorization_ref, operation: 'epoch', action, ...extra});
    } finally {this.authorization.remove?.(admission.request.authorization_ref);}
  }
  seal(control, epoch, drainedDigest) {return this.epoch(control, 'seal', {epoch, drained_digest: drainedDigest});}
  // Remove authorization heads (and their remaining slots) for requests whose
  // epoch is sealed and whose current grant the executor already reclaimed.
  // Only identities that the fence now retires are eligible.
  prune({limit = 1000} = {}) {
    if (this.pruneRunning) return this.pruneRunning;
    const run = async () => {
      const state = this.epochState;
      if (!state) return 0;
      const retired = key => {
        let identity;
        try {identity = parseIdentity(key);} catch {return false;}
        return identity.kind === 'operation' && (identity.generation < state.generation || identity.epoch <= state.sealed_through);
      };
      let removed = 0, scanned = 0;
      // Stream the directory and yield between bounded batches even when no
      // entry can be reclaimed. A deletion limit alone does not bound a scan
      // of live authorization heads and must not stall Host heartbeats/HTTP.
      const directory = await fs.promises.opendir(this.index);
      for await (const entry of directory) {
        if (removed >= limit) break;
        if (++scanned % 32 === 0) await new Promise(setImmediate);
        const name = entry.name, file = path.join(this.index, name);
        if (name.endsWith('.head.json')) {
          let head;
          try {head = decode(privateRead(file, 2 * 1024 * 1024));} catch {continue;}
          if (!retired(head.request?.request_key) || fs.existsSync(path.join(this.config.grants_directory, head.current + '.json'))) continue;
          for (const reference of [head.previous, head.candidate].filter(Boolean)) this.authorization.remove(reference);
          fs.unlinkSync(file); removed++;
        } else if (name.startsWith('alias-') && name.endsWith('.json')) {
          let alias;
          try {alias = JSON.parse(fs.readFileSync(file, 'utf8'));} catch {continue;}
          const owner = this.config.owner_id;
          if (!retired(alias.request_key) || fs.existsSync(this.headFile({principal: 'product-owner', owner, request_key: alias.request_key}))) continue;
          fs.unlinkSync(file); removed++;
        }
      }
      return removed;
    };
    const running = run().finally(() => {if (this.pruneRunning === running) this.pruneRunning = null;});
    this.pruneRunning = running;
    return running;
  }
}
