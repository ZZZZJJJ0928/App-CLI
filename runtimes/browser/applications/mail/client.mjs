import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ProductClient} from '../../src/product-client.mjs';
import {digest, requireCondition, RuntimeError} from '../../src/protocol.mjs';

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
  admission({provider, operation, input, taskID, credentialGeneration, token, scriptID, revision}, {sessionKey, previousTask} = {}) {
    const {binding, command, spec, manifest} = this.describe(provider, operation);
    requireCondition(scriptID === spec.script_id && revision === spec.revision, 'RELEASE_MISMATCH');
    const owner = this.config.owner_id;
    const account = (input.account_address ?? input.discovery?.account_address ?? input.target?.account_address ?? '').toLowerCase();
    const pool_key = digest({owner, provider, account, scope: input.owner_scope ?? '', credentialGeneration, binding: digest(binding)});
    const resource = {...(previousTask ? {previous_task_id: previousTask} : {}), binding_digest: digest(binding), profile_id: this.config.profile_id, credential_generation: credentialGeneration,
      token, account_address: account, workspace_root: this.config.workspace_root, host_runtime_root: this.config.host_runtime_root,
      pool_key: ['collect_page', 'watch'].includes(command) && account ? (this.sharedPages ? pool_key : digest({pool_key, command})) : digest({taskID, command}), document_nonce: pool_key};
    const args = command === 'watch' ? {schema_version: 1, owner_scope: input.owner_scope, account_address: input.account_address} : input;
    return this.client.authorize({app: binding.manifest.id, command, arguments: args,
      request_key: digest({taskID: sessionKey ?? taskID, app: binding.manifest.id, command}), principal: 'product-owner', owner, resource,
      side_effect: manifest.side_effect, timeout_ms: spec.timeout_ms, renewable: spec.renewable});
  }
  async execute(request) {
    if (request.operation === 'observe') {
      if (request.input.action === 'stop') return this.stopWatch(request.provider);
      if (request.input.action === 'status') return this.watchStatus(request.provider);
      return this.startWatch(request);
    }
    let admission, response;
    if (request.operation === 'send' && request.input.mode === 'reconcile') {
      const {binding, command} = this.describe(request.provider, request.operation);
      const original = this.client.original({principal: 'product-owner', owner: this.config.owner_id,
        request_key: digest({taskID: request.taskID, app: binding.manifest.id, command})});
      requireCondition(original, 'ADMISSION_UNRESOLVED');
      const args = {...request.input, mode: original.arguments.mode};
      if (original.arguments.mode === undefined) delete args.mode;
      requireCondition(digest(args) === digest(original.arguments), 'REQUEST_KEY_CONFLICT');
      admission = this.admission({...request, input: original.arguments});
      response = await this.client.control(admission, 'lookup');
      requireCondition(response.task, 'ADMISSION_UNRESOLVED');
      if (response.task.status === 'uncertain') {
        const recovery = this.client.refresh(admission, response.task.id, 'reconcile');
        admission = recovery.admission; response = await recovery.acknowledged;
      }
    } else {
      admission = this.admission(request);
      response = await this.client.invoke(admission);
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
    return this.legacyResult(request.provider, request.operation, response);
  }
  legacyResult(provider, operation, response) {
    const {spec} = this.describe(provider, operation);
    if (response.kind === 'task' && response.task.status === 'completed') return {state: 'completed', result: response.data, sourceChecksum: spec.source_checksum};
    const code = response.task?.status === 'uncertain' ? (operation === 'send' ? 'send_outcome_unknown' : 'email_source_recovery_pending') : (response.reason ?? 'provider_script_failed').toLowerCase();
    return {state: 'failed', result: {schema_version: 1, status: 'error', provider, code}, sourceChecksum: spec.source_checksum,
      task: response.task};
  }
  async startWatch(request) {
    const prior = this.watches.get(request.provider);
    const identity = crypto.createHash('sha256').update(JSON.stringify([request.token, request.credentialGeneration,
      request.provider, request.input.account_address.toLowerCase(), request.input.owner_scope])).digest('hex');
    if (prior && prior.identity === identity && ['pending', 'running'].includes(prior.task.status)) return this.watchStatus(request.provider);
    if (prior) await this.stopWatch(request.provider);
    // A new watch after a terminal task is an explicit new session, with an
    // initial gap. It cannot be used to reissue a message-sending operation.
    const filename = path.join(this.client.index, 'watch-' + digest({owner: this.config.owner_id, provider: request.provider}) + '.json');
    let saved = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
    if (!saved || saved.identity !== identity) saved = {identity, sessionKey: crypto.randomUUID(), previousTask: prior?.task.id};
    const persist = () => {
      const temporary = filename + '.' + crypto.randomUUID();
      fs.writeFileSync(temporary, JSON.stringify(saved), {flag: 'wx', mode: 0o600});
      const fd = fs.openSync(temporary, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      fs.renameSync(temporary, filename);
      const directory = fs.openSync(this.client.index, 'r'); try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
    };
    persist();
    let admission = this.admission(request, saved);
    let response = await this.client.invoke(admission);
    if (response.task && !['pending', 'running'].includes(response.task.status)) {
      saved = {identity, sessionKey: crypto.randomUUID(), previousTask: response.task.id}; persist();
      admission = this.admission(request, saved); response = await this.client.invoke(admission);
    }
    requireCondition(response.task, 'BACKEND_PROTOCOL_INVALID');
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
  async close() {await Promise.all([...this.watches.keys()].map(provider => this.stopWatch(provider)));}
}
