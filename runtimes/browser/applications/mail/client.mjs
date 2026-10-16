import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ProductClient} from '../../src/product-client.mjs';
import {digest, requireCondition, RuntimeError} from '../../src/protocol.mjs';
import {parseIdentity} from '../../src/identity.mjs';
import {attachmentMessageFingerprint, validateAttachments} from './lib/workspace-attachments.mjs';

function reconciliationIntent(input) {
  // Receipt lookup compares approved bytes, not the expired upload location.
  // Validate first so projecting metadata cannot hide extra attachment fields.
  validateAttachments(input.message.attachments, 'reconcile');
  return {...input, message: attachmentMessageFingerprint(input.message)};
}

// Product-facing mail convenience calls. Execution always passes through the
// Python catalog and lifecycle admission; provider handlers are never imported.
export class MailboxClient {
  constructor(options) {
    this.sharedPages = options.sharedPages ?? true;
    this.client = new ProductClient(options); this.config = this.client.config;
    this.bindings = new Map(); this.watches = new Map(); this.watchWork = new Map();
    for (const installed of this.config.bindings) {
      const binding = JSON.parse(fs.readFileSync(installed.path, 'utf8'));
      requireCondition(digest(binding) === installed.digest, 'RELEASE_MISMATCH');
      if (binding.application?.group === 'mail') this.bindings.set(binding.application.provider, binding);
    }
  }
  describe(provider, operation) {
    const binding = this.bindings.get(provider), command = operation === 'observe' ? 'watch' : operation;
    const spec = binding?.commands[command];
    requireCondition(Boolean(spec), 'COMMAND_NOT_FOUND');
    return {binding, command, spec, manifest: binding.manifest.commands.find(value => value.name === command)};
  }
  control(provider) {
    const {binding, manifest} = this.describe(provider, 'probe');
    return {app: binding.manifest.id, command: 'probe', principal: 'product-owner', owner: this.config.owner_id,
      resource: {binding_digest: digest(binding)}, side_effect: manifest.side_effect};
  }
  async epochState(provider, action = 'status', extra = {}) {
    const response = await this.client.epoch(this.control(provider), action, extra);
    return response.epoch_state;
  }
  aliasFile(app, command, taskID) {
    return path.join(this.client.index, 'alias-' + digest({owner: this.config.owner_id, taskID, app, command}) + '.json');
  }
  // Product identities: a Gateway-issued `op3` identity is used directly; an
  // existing lifecycle 2.0 key keeps controlling its original task; any other
  // caller key is mapped once to a persisted `op3` alias in the open epoch.
  async requestKey(app, command, taskID, {allocate = true} = {}) {
    if (parseIdentity(taskID).kind === 'operation') return taskID;
    const legacy = digest({taskID, app, command});
    // Test doubles without head() model the lifecycle 2.0 index directly.
    if (typeof this.client.head !== 'function' ||
        this.client.head({principal: 'product-owner', owner: this.config.owner_id, request_key: legacy})) return legacy;
    const file = this.aliasFile(app, command, taskID);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).request_key;
    if (!allocate) return legacy;
    if (!this.client.epochState) await this.client.epoch({...this.control([...this.bindings.keys()][0]), app, command});
    const key = this.client.allocate();
    const temporary = `${file}.${crypto.randomUUID()}`;
    fs.writeFileSync(temporary, JSON.stringify({request_key: key}), {flag: 'wx', mode: 0o600});
    const fd = fs.openSync(temporary, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    try {fs.linkSync(temporary, file);} catch (error) {if (error.code !== 'EEXIST') throw error;} finally {fs.unlinkSync(temporary);}
    const directory = fs.openSync(this.client.index, 'r'); try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
    return JSON.parse(fs.readFileSync(file, 'utf8')).request_key;
  }
  // Read-only and replay-safe work may continue under a fresh identity after
  // its epoch was retired; an external write never does.
  rekey(app, command, taskID) {
    const file = this.aliasFile(app, command, taskID);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  async admission({provider, operation, input, taskID, credentialGeneration, token, scriptID, revision}, {sessionKey, previousTask, previousRequestKey} = {}) {
    const {binding, command, spec, manifest} = this.describe(provider, operation);
    requireCondition(scriptID === spec.script_id && revision === spec.revision, 'RELEASE_MISMATCH');
    const owner = this.config.owner_id;
    const account = (input.account_address ?? input.discovery?.account_address ?? input.target?.account_address ?? '').toLowerCase();
    const pool_key = digest({owner, provider, account, scope: input.owner_scope ?? '', credentialGeneration, binding: digest(binding)});
    const resource = {...(previousRequestKey ? {previous_request_key: previousRequestKey} : {}), ...(previousTask ? {previous_task_id: previousTask} : {}), binding_digest: digest(binding), profile_id: this.config.profile_id, credential_generation: credentialGeneration,
      token, account_address: account, workspace_root: this.config.workspace_root, host_runtime_root: this.config.host_runtime_root,
      pool_key: ['collect_page', 'watch'].includes(command) && account ? (this.sharedPages ? pool_key : digest({pool_key, command})) : digest({taskID, command}), document_nonce: pool_key};
    const args = command === 'watch' ? {schema_version: 1, owner_scope: input.owner_scope, account_address: input.account_address} : input;
    return this.client.authorize({app: binding.manifest.id, command, arguments: args,
      request_key: await this.requestKey(binding.manifest.id, command, sessionKey ?? taskID), principal: 'product-owner', owner, resource,
      side_effect: manifest.side_effect, timeout_ms: spec.timeout_ms, renewable: spec.renewable});
  }
  async invoke(request, options) {
    let admission = await this.admission(request, options);
    try {return {admission, response: await this.client.invoke(admission)};}
    catch (error) {
      const {binding, command, manifest} = this.describe(request.provider, request.operation);
      if (error.code !== 'OPERATION_RETIRED' || manifest.side_effect === 'remote_mutation' ||
          parseIdentity(options?.sessionKey ?? request.taskID).kind === 'operation') throw error;
      this.rekey(binding.manifest.id, command, options?.sessionKey ?? request.taskID);
      admission = await this.admission(request, options);
      return {admission, response: await this.client.invoke(admission)};
    }
  }
  async restoreTask(provider, operation, taskID) {
    const {binding, command} = this.describe(provider, operation);
    return this.client.restore({principal: 'product-owner', owner: this.config.owner_id,
      request_key: await this.requestKey(binding.manifest.id, command, taskID, {allocate: false})});
  }
  // Product outbox drain check: was this original operation ever admitted?
  async lookupTask(provider, operation, taskID) {
    let admission;
    try {admission = await this.restoreTask(provider, operation, taskID);}
    catch (error) {
      if (error.code === 'OPERATION_RETIRED') return {outcome: 'retired', reason: error.reason ?? 'reclaimed'};
      if (error.code !== 'ADMISSION_UNRESOLVED') throw error;
      // No authorization was ever recorded here, so it was never submitted.
      let identity;
      try {identity = parseIdentity(taskID);} catch {return {outcome: 'unresolved'};}
      const state = this.client.epochState;
      if (identity.kind === 'operation' && state && (identity.generation < state.generation || identity.epoch <= state.sealed_through)) {
        return {outcome: 'retired', reason: 'recovery'};
      }
      return {outcome: 'not_admitted'};
    }
    const known = await this.client.lookup(admission);
    if (known.kind === 'task') return {outcome: 'known', task: known.task};
    return {outcome: known.outcome, ...(known.reason ? {reason: known.reason} : {})};
  }
  // Durable product receipt of a terminal result (Gateway commits first).
  async acknowledge({provider, operation, taskID, terminal_revision, result_digest, receipt_id}) {
    const admission = await this.restoreTask(provider, operation, taskID);
    const known = await this.client.control(admission, 'lookup');
    requireCondition(known.kind === 'task', 'ADMISSION_UNRESOLVED');
    const response = await this.client.ack(admission, {...known, terminal_revision, result_digest},
      {receiver_id: 'product-owner', receipt_id});
    return {task: response.task};
  }
  // Explicit user conclusion for an unknown send; never a resend.
  async resolve({provider, operation = 'send', taskID, resolution, evidence_digest}) {
    let admission = await this.restoreTask(provider, operation, taskID);
    const known = await this.client.control(admission, 'lookup');
    requireCondition(known.kind === 'task', 'ADMISSION_UNRESOLVED');
    if (!admission.grant.operations.includes('resolve')) admission = this.client.reissue(admission, known.task.id);
    const response = await this.client.resolve(admission, known.task.id, resolution, evidence_digest);
    return this.legacyResult(provider, operation, response, admission);
  }
  async execute(request) {
    if (request.operation === 'observe') {
      if (request.input.action === 'stop') return this.stopWatch(request.provider);
      if (request.input.action === 'status') {
        await this.pollWatch(request.provider);
        return this.watchStatus(request.provider);
      }
      return this.startWatch(request);
    }
    let admission, response;
    if (request.operation === 'send' && request.input.mode === 'reconcile') {
      const {binding, command, spec} = this.describe(request.provider, request.operation);
      requireCondition(request.scriptID === spec.script_id && request.revision === spec.revision, 'RELEASE_MISMATCH');
      admission = this.client.restore({principal: 'product-owner', owner: this.config.owner_id,
        request_key: await this.requestKey(binding.manifest.id, command, request.taskID, {allocate: false})});
      const original = admission.request;
      const args = {...request.input, mode: original.arguments.mode};
      if (original.arguments.mode === undefined) delete args.mode;
      requireCondition(digest(reconciliationIntent(args)) === digest(reconciliationIntent(original.arguments)), 'REQUEST_KEY_CONFLICT');
      // Journal-only reconciliation retains the original resource binding even
      // when the current Bridge credential has changed. It cannot acquire a page.
      response = await this.client.control(admission, 'lookup');
      requireCondition(response.task, 'ADMISSION_UNRESOLVED');
      if (response.task.status === 'uncertain') {
        const recovery = this.client.refresh(admission, response.task.id, 'reconcile');
        admission = recovery.admission; response = await recovery.acknowledged;
      }
    } else {
      try {({admission, response} = await this.invoke(request));}
      catch (error) {
        if (error.code !== 'OPERATION_RETIRED') throw error;
        const {spec} = this.describe(request.provider, request.operation);
        return {state: 'failed', result: {schema_version: 1, status: 'error', provider: request.provider, code: 'operation_retired',
          retired_reason: error.reason ?? 'recovery'}, sourceChecksum: spec.source_checksum};
      }
    }
    if (admission.existing && request.input.mode !== 'reconcile' && response.task &&
        response.task.status === 'blocked' && admission.grant.max_deadline_ms > Date.now()) {
      const recovery = this.client.refresh(admission, response.task.id, 'resume');
      admission = recovery.admission; response = await recovery.acknowledged;
    }
    if (admission.existing && ['read', 'capture', 'collect_page'].includes(request.operation) && response.task?.status === 'uncertain') {
      // Local capture journals bind deterministic capture IDs and verify files.
      // Recover that same task; this never applies to remote writes.
      const recovery = this.client.refresh(admission, response.task.id, 'reconcile');
      admission = recovery.admission; response = await recovery.acknowledged;
    }
    response = await this.client.wait(admission, response, {signal: request.signal});
    if (request.operation === 'send') response = await this.finalizeUndispatched(admission, response);
    return this.legacyResult(request.provider, request.operation, response, admission);
  }
  // A send whose dispatch was never released is provably not sent. Close a
  // resumable original task so it can never dispatch later, and report it as
  // definitively not dispatched instead of an unknown outcome.
  async finalizeUndispatched(admission, response) {
    if (response.kind !== 'task' || response.effect !== false || !['blocked', 'waiting_confirmation'].includes(response.task.status)) return response;
    await this.client.control(admission, 'cancel', response.task.id);
    return this.client.control(admission, 'status', response.task.id);
  }
  legacyResult(provider, operation, response, admission) {
    const {spec} = this.describe(provider, operation);
    // Identity and terminal revision the product echoes back in ack_result.
    const lifecycle = response.task ? {operation_id: admission?.request?.request_key, task_id: response.task.id, status: response.task.status,
      ...(response.terminal_revision ? {terminal_revision: response.terminal_revision, result_digest: response.result_digest} : {}),
      ...(response.attempt ? {attempt: response.attempt} : {}), ...(response.resolution ? {resolution: response.resolution} : {}),
      ...(typeof response.effect === 'boolean' ? {effect: response.effect} : {})} : undefined;
    if (response.kind === 'task' && response.task.status === 'completed') return {state: 'completed', result: response.data, sourceChecksum: spec.source_checksum, lifecycle};
    const undispatched = operation === 'send' && response.effect === false && ['failed', 'cancelled'].includes(response.task?.status);
    const code = undispatched ? 'send_not_dispatched' : response.task?.status === 'uncertain' ? (operation === 'send' ? 'send_outcome_unknown' : 'email_source_recovery_pending') :
      response.task?.status === 'resolved' ? 'send_resolved_by_user' : (response.reason ?? 'provider_script_failed').toLowerCase();
    return {state: 'failed', result: {schema_version: 1, status: 'error', provider, code}, sourceChecksum: spec.source_checksum,
      task: response.task, lifecycle};
  }
  async startWatch(request) {
    const prior = this.watches.get(request.provider);
    const identity = crypto.createHash('sha256').update(JSON.stringify([request.token, request.credentialGeneration,
      request.provider, request.input.account_address.toLowerCase(), request.input.owner_scope,
      digest(this.describe(request.provider, 'observe').binding)])).digest('hex');
    if (prior && prior.identity === identity && ['pending', 'running'].includes(prior.task.status)) return this.watchStatus(request.provider);
    if (prior) await this.stopWatch(request.provider);
    // A new watch after a terminal task is an explicit new session, with an
    // initial gap. It cannot be used to reissue a message-sending operation.
    const filename = path.join(this.client.index, 'watch-' + digest({owner: this.config.owner_id, provider: request.provider}) + '.json');
    let saved = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
    if (saved?.sessionKey && !saved.taskID) {
      const {binding, command, spec, manifest} = this.describe(request.provider, 'observe');
      const original = this.client.restore({principal: 'product-owner', owner: this.config.owner_id,
        request_key: await this.requestKey(binding.manifest.id, command, saved.sessionKey, {allocate: false})});
      const previous = await this.client.control(original, 'lookup');
      if (previous.task) saved.taskID = previous.task.id;
      else {
        // An unknown outcome is not proof that admission never happened. Only
        // replace an expired, unbound, read-only watch; Host expiry/cleanup still
        // fences its resources. Never relax ProductClient's write retry rules.
        const grant = original.grant;
        requireCondition(previous.kind === 'lookup' && ['unresolved', 'not_admitted', 'retired'].includes(previous.outcome) &&
          command === 'watch' && spec.renewable === true && manifest.side_effect === 'read_only' &&
          original.request.command === command && original.request.app === binding.manifest.id &&
          grant?.command === command && grant.app === binding.manifest.id && grant.side_effect === 'read_only' &&
          grant.max_deadline_ms === null && grant.task_id === null &&
          Number.isSafeInteger(grant.execution_expires_ms) && grant.execution_expires_ms <= Date.now(), 'ADMISSION_UNRESOLVED');
        saved = {identity, sessionKey: crypto.randomUUID(), previousTask: saved.previousTask,
          previousRequestKey: original.request.request_key};
      }
    }
    if (!saved || saved.identity !== identity) {
      saved = {identity, sessionKey: crypto.randomUUID(), previousTask: prior?.task.id ?? saved?.taskID};
    }
    const persist = () => {
      const temporary = filename + '.' + crypto.randomUUID();
      fs.writeFileSync(temporary, JSON.stringify(saved), {flag: 'wx', mode: 0o600});
      const fd = fs.openSync(temporary, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      fs.renameSync(temporary, filename);
      const directory = fs.openSync(this.client.index, 'r'); try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
    };
    persist();
    let {admission, response} = await this.invoke(request, saved);
    if (response.task && !['prepared', 'pending', 'running'].includes(response.task.status)) {
      saved = {identity, sessionKey: crypto.randomUUID(), previousTask: response.task.id}; persist();
      ({admission, response} = await this.invoke(request, saved));
    }
    requireCondition(response.task, 'BACKEND_PROTOCOL_INVALID');
    saved.taskID = response.task.id; persist();
    const watch = {identity, admission, task: response.task, cursor: 0, epoch: response.task.id, ready: false, state: 'starting',
      onEvent: request.onEvent ?? (() => {}), expires: admission.grant.execution_expires_ms};
    this.watches.set(request.provider, watch);
    return this.watchStatus(request.provider);
  }
  watchStatus(provider) {
    const watch = this.watches.get(provider), {spec} = this.describe(provider, 'observe');
    return {state: 'completed', sourceChecksum: spec.source_checksum, result: {schema_version: 1, provider,
      status: watch?.state ?? 'stopped', watch_epoch: watch?.epoch ?? '', resync_required: !watch?.ready}};
  }
  async pollWatch(provider, {renew = false} = {}) {
    if (this.watchWork.has(provider)) return this.watchWork.get(provider);
    const work = this.poll(provider, renew).finally(() => this.watchWork.delete(provider));
    this.watchWork.set(provider, work); return work;
  }
  async poll(provider, renew) {
    const watch = this.watches.get(provider); if (!watch) return null;
    if (renew && watch.expires - Date.now() < 60000 && watch.task.status === 'running') {
      if (!watch.pendingRenewal) {
        const renewal = this.client.renew(watch.admission, watch.task.id);
        watch.admission = renewal.admission; watch.pendingRenewal = true;
        await renewal.acknowledged;
      } else await this.client.control(watch.admission, 'renew', watch.task.id);
      watch.expires = watch.admission.grant.execution_expires_ms; watch.pendingRenewal = false;
    }
    const response = await this.client.control(watch.admission, 'events', watch.task.id, {cursor: watch.cursor, limit: 100});
    watch.task = response.task;
    if (response.gap) watch.onEvent(watch, 'resync_required');
    for (const event of response.events) {
      if (event.type === 'watch_ready') {watch.ready = true; watch.state = 'watching'; watch.onEvent(watch, 'resync_required');}
      if (event.type === 'gap') watch.onEvent(watch, 'resync_required');
      if (event.type === 'mailbox_changed') watch.onEvent(watch, 'mailbox_changed', event.payload.reason);
    }
    watch.cursor = response.cursor;
    if (response.task.status === 'waiting_confirmation') watch.state = 'login_required';
    else if (['blocked', 'failed', 'uncertain'].includes(response.task.status)) watch.state = 'degraded';
    else if (response.task.status === 'cancelled') watch.state = 'stopped';
    watch.onEvent(watch, 'state'); return watch;
  }
  async stopWatch(provider) {
    const watch = this.watches.get(provider);
    if (watch) {
      await this.client.control(watch.admission, 'cancel', watch.task.id);
      await this.client.wait(watch.admission, await this.client.control(watch.admission, 'status', watch.task.id));
      this.watches.delete(provider);
    }
    return this.watchStatus(provider);
  }
  // Periodic product-side maintenance: refresh the epoch state and drop
  // authorization heads/aliases of requests the executor has reclaimed.
  async maintain() {
    if (!this.bindings.size) return 0;
    await this.client.epoch(this.control([...this.bindings.keys()][0]));
    return this.client.prune();
  }
  async close() {await Promise.all([...this.watches.keys()].map(provider => this.stopWatch(provider)));}
}
