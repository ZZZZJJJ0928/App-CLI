import {verifyRelease} from './release.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {SignedFileAuthorization, privateDirectory, privateRead} from './authorization.mjs';
import {decode, digest, encode, intentDigest, requireCondition, RESPONSE_LIMIT, RuntimeError, TERMINAL} from './protocol.mjs';

// Trusted embedding client: callers must already have passed product admission.
// This is deliberately not a wire operation and cannot turn an `approved` field
// into authority. Every operation still crosses Python Registry.control.
export class ProductClient {
  constructor({configFile, python}) {
    requireCondition(path.isAbsolute(configFile) && path.isAbsolute(python), 'CONFIGURATION_INVALID');
    this.configFile = configFile; this.python = python; this.config = decode(privateRead(configFile));
    if (this.config.release_digest) verifyRelease(this.config);
    this.authorization = new SignedFileAuthorization(this.config.grants_directory, this.config.issuer_key_file);
    this.index = path.join(this.config.grants_directory, 'index'); privateDirectory(this.index);
  }
  machine(request) {
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
          const value = decode(Buffer.concat(chunks), RESPONSE_LIMIT);
          requireCondition(value.protocol_version === '2.0', 'BACKEND_PROTOCOL_INVALID');
          if (value.kind === 'error') throw new RuntimeError(value.error.code);
          finish(null, value);
        } catch (error) {finish(error);}
      });
      child.stdin.end(payload);
    });
  }
  authorize({app, command, arguments: args, request_key, principal, owner, resource, side_effect, timeout_ms, renewable = false}) {
    const filename = path.join(this.index, digest({principal, owner, request_key}) + '.json');
    const existing = () => {
      const saved = decode(privateRead(filename, 2 * 1024 * 1024));
      let ref = saved.reference;
      while (fs.existsSync(path.join(this.index, ref + '.next'))) ref = decode(privateRead(path.join(this.index, ref + '.next'))).reference;
      const record = this.authorization.record(ref), grant = record.grant;
      const request = {protocol_version: '2.0', operation: 'invoke', app, command, request_key, arguments: args,
        ...(grant.max_deadline_ms ? {deadline_ms: grant.max_deadline_ms} : {}), authorization_ref: ref};
      requireCondition(grant.principal === principal && grant.owner === owner && grant.side_effect === side_effect &&
        grant.intent_digest === intentDigest(request) && digest(record.resource) === digest(resource), 'REQUEST_KEY_CONFLICT');
      return {request, grant, resource, existing: true};
    };
    if (fs.existsSync(filename)) return existing();
    const now = Date.now(), deadline = renewable ? null : now + timeout_ms;
    const request = {protocol_version: '2.0', operation: 'invoke', app, command, request_key, arguments: args,
      ...(deadline ? {deadline_ms: deadline} : {})};
    const grant = {principal, owner, app, command, request_key, side_effect, intent_digest: intentDigest(request),
      operations: ['invoke', 'lookup', 'status', 'cancel', 'resume', 'renew', 'events', 'reconcile'],
      access_expires_ms: now + 30 * 86400000, execution_expires_ms: renewable ? now + 300000 : deadline,
      max_deadline_ms: deadline, task_id: null, revision: 1};
    const reference = this.authorization.issue(grant, resource);
    const temporary = filename + '.' + reference;
    fs.writeFileSync(temporary, JSON.stringify({reference, request}), {flag: 'wx', mode: 0o600});
    const fd = fs.openSync(temporary, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    try {fs.linkSync(temporary, filename);} catch (error) {if (error.code !== 'EEXIST') throw error;}
    finally {fs.unlinkSync(temporary);}
    const directory = fs.openSync(this.index, 'r'); try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
    const admission = existing(); admission.existing = false; return admission;
  }
  restore({principal, owner, request_key}) {
    const filename = path.join(this.index, digest({principal, owner, request_key}) + '.json');
    requireCondition(fs.existsSync(filename), 'ADMISSION_UNRESOLVED');
    const saved = decode(privateRead(filename, 2 * 1024 * 1024));
    let reference = saved.reference;
    while (fs.existsSync(path.join(this.index, reference + '.next'))) reference = decode(privateRead(path.join(this.index, reference + '.next'))).reference;
    const {grant, resource} = this.authorization.record(reference);
    const request = {...saved.request, authorization_ref: reference};
    requireCondition(grant.principal === principal && grant.owner === owner && grant.request_key === request_key &&
      grant.intent_digest === intentDigest(request), 'TASK_ACCESS_DENIED');
    return {request, grant, resource, existing: true};
  }
  original(identity) {return this.restore(identity).request;}
  control(admission, operation, task_id, extra = {}) {
    const {request} = admission;
    return this.machine({protocol_version: '2.0', app: request.app, command: request.command,
      authorization_ref: request.authorization_ref, operation,
      ...(operation === 'lookup' ? {request_key: request.request_key} : {task_id}), ...extra});
  }
  async invoke(admission) {
    try {
      if (admission.existing) {
        const known = await this.control(admission, 'lookup');
        if (known.kind !== 'lookup') return known;
        throw new RuntimeError('ADMISSION_UNRESOLVED');
      }
      return await this.machine(admission.request);
    }
    catch (error) {
      if (!['CONTROL_TIMEOUT', 'BACKEND_UNAVAILABLE', 'BACKEND_EXECUTION_FAILED', 'BACKEND_TIMEOUT', 'BACKEND_PROTOCOL_INVALID'].includes(error.code)) throw error;
      // A lost control response is not permission to submit a new operation.
      const original = await this.control(admission, 'lookup');
      if (original.kind === 'lookup') throw new RuntimeError('ADMISSION_UNRESOLVED');
      return original;
    }
  }
  async wait(admission, response, {signal, interval = 250} = {}) {
    while (response.kind === 'task' && ['pending', 'running'].includes(response.task.status)) {
      if (signal?.aborted) {
        await this.control(admission, 'cancel', response.task.id);
        return this.control(admission, 'status', response.task.id);
      }
      await delay(interval);
      response = await this.control(admission, 'status', response.task.id);
    }
    return response;
  }
  refresh(admission, task_id, operation) {
    requireCondition(['renew', 'reconcile', 'resume'].includes(operation), 'CAPABILITY_NOT_SUPPORTED');
    if (operation === 'renew') requireCondition(admission.grant.max_deadline_ms === null, 'CAPABILITY_NOT_SUPPORTED');
    const grant = {...admission.grant, task_id, revision: admission.grant.revision + 1, execution_expires_ms: Date.now() + 300000};
    requireCondition(grant.execution_expires_ms < grant.access_expires_ms, 'AUTHORIZATION_EXPIRED');
    const reference = this.authorization.issue(grant, admission.resource);
    const filename = path.join(this.index, admission.request.authorization_ref + '.next');
    const temporary = filename + '.' + reference;
    fs.writeFileSync(temporary, JSON.stringify({reference}), {flag: 'wx', mode: 0o600});
    const fd = fs.openSync(temporary, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    try {fs.linkSync(temporary, filename);} catch (error) {if (error.code !== 'EEXIST') throw error;}
    finally {fs.unlinkSync(temporary);}
    const directory = fs.openSync(this.index, 'r'); try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
    const winner = decode(privateRead(filename, 2 * 1024 * 1024)).reference, record = this.authorization.record(winner);
    const updated = {...admission, grant: record.grant, request: {...admission.request, authorization_ref: winner}};
    return {admission: updated, acknowledged: this.control(updated, operation, task_id)};
  }
  renew(admission, task_id) {return this.refresh(admission, task_id, 'renew');}
}
