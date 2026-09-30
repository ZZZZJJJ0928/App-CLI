import {randomUUID, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {privateRead} from './authorization.mjs';
import {compileSchema, decode, digest, requireCondition, RuntimeError} from './protocol.mjs';

const validateHost = compileSchema(JSON.parse(fs.readFileSync(new URL('../schemas/browser-host-v1.schema.json', import.meta.url))));

export const HOST_VERSION = '1.0';
export const LEASE_MS = 30000;
export const HEARTBEAT_MS = 10000;
const ACTIONS = new Set(['hello', 'acquire', 'call', 'heartbeat', 'release']);
export function signHostRequest(authorization, request) {return {...request, mac: authorization.mac(request)};}

// Shared protocol implementation. The embedding host owns driver/resources;
// application code owns no browser process and cannot enumerate user pages.
export class BrowserHostPort {
  constructor({authorization, bindings, driver, stateDirectory, releaseDigest, clock = Date.now, monotonic}) {
    this.releaseDigest = releaseDigest;
    this.authorization = authorization; this.driver = driver; this.clock = clock;
    this.monotonic = monotonic ?? (clock === Date.now ? () => performance.now() : clock);
    this.bindings = new Map(bindings.map(binding => [digest(binding), binding]));
    this.generation = randomUUID(); this.leases = new Map(); this.released = new Map(); this.resources = new Map(); this.changing = null;
    this.epochFile = path.join(stateDirectory, 'host-epoch.json');
    this.epoch = fs.existsSync(this.epochFile) ? JSON.parse(fs.readFileSync(this.epochFile)).epoch : 0;
    requireCondition(Number.isSafeInteger(this.epoch) && this.epoch >= 0, 'CONFIGURATION_INVALID');
    this.closed = false;
    this.timer = setInterval(() => {void this.expire().catch(() => {});}, 1000); this.timer.unref();
  }
  verify(request) {
    const {mac, ...payload} = request;
    requireCondition(typeof mac === 'string' && /^[0-9a-f]{64}$/u.test(mac) &&
      timingSafeEqual(Buffer.from(mac), Buffer.from(this.authorization.mac(payload))), 'HOST_AUTHORIZATION_DENIED');
    requireCondition(validateHost(request), 'HOST_PROTOCOL_INVALID');
    requireCondition(request.protocol_version === HOST_VERSION && ACTIONS.has(request.operation) &&
      Number.isSafeInteger(request.epoch) && request.epoch > 0, 'HOST_PROTOCOL_INVALID');
  }
  async control(request) {
    this.verify(request); requireCondition(!this.closed, 'HOST_STOPPING');
    if (request.operation === 'hello') return this.hello(request);
    requireCondition(!this.changing && request.epoch === this.epoch && request.generation === this.generation, 'HOST_STALE');
    const record = this.authorization.record(request.authorization_ref), {grant, resource} = record;
    requireCondition(grant.access_expires_ms > this.clock() && resource.binding_digest &&
      (!grant.task_id || grant.task_id === request.task_id), 'AUTHORIZATION_DENIED');
    const binding = this.bindings.get(resource.binding_digest);
    requireCondition(binding && binding.manifest.id === grant.app, 'RELEASE_MISMATCH');
    const spec = binding.commands[grant.command];
    requireCondition(spec?.host, 'HOST_CAPABILITY_DENIED');
    if (request.operation === 'acquire') {
      requireCondition(grant.execution_expires_ms > this.clock(), 'AUTHORIZATION_DENIED');
      return this.acquire(request, record, spec);
    }
    const lease = this.leases.get(request.lease_id) ?? (request.operation === 'release' ? this.released.get(request.lease_id) : null);
    requireCondition(lease && lease.epoch === request.epoch && lease.task === request.task_id &&
      lease.intent === grant.intent_digest && lease.principal === grant.principal && lease.owner === grant.owner &&
      lease.resourceDigest === digest(resource), 'HOST_LEASE_INVALID');
    if (request.operation === 'release') {
      if (!this.released.has(lease.id)) await this.drop(lease, {park: request.park === true && spec.host.reuse_idle_ms > 0, invalidate: request.invalidate === true && spec.host.invalidate_on_failure === true});
      return {released: true};
    }
    requireCondition(!lease.retired && this.live(lease) && grant.execution_expires_ms > this.clock(), 'HOST_LEASE_EXPIRED');
    if (request.operation === 'heartbeat') {
      requireCondition(grant.revision >= lease.revision && (grant.revision > lease.revision || request.authorization_ref === lease.reference), 'AUTHORIZATION_STALE');
      lease.reference = request.authorization_ref; lease.revision = grant.revision;
      lease.expires = Math.min(this.clock() + LEASE_MS, grant.execution_expires_ms);
      lease.monotonicDeadline = this.monotonic() + Math.max(0, lease.expires - this.clock());
      await this.driver.updateLease(lease.slot.handle, this.stamp(lease.slot));
      return {expires_ms: lease.expires};
    }
    requireCondition(Array.isArray(request.arguments) && spec.host.methods.includes(request.method), 'HOST_CAPABILITY_DENIED');
    return this.queue(lease.slot, async () => {
      // Validate again after any older queued page operation has finished.
      requireCondition(!lease.retired && !this.changing && this.epoch === lease.epoch && this.live(lease), 'HOST_LEASE_EXPIRED');
      const result = await this.driver.call(lease.slot.handle, request.method, request.arguments, {
        signal: lease.abort.signal, activity: lease.id, expires: lease.expires, grant, resource, spec,
      });
      requireCondition(!lease.retired && this.epoch === lease.epoch && this.live(lease), 'HOST_LEASE_EXPIRED');
      return this.driver.serializeResult ? this.driver.serializeResult(lease.slot.handle, result) : {result: result ?? null};
    });
  }
  async hello(request) {
    requireCondition(!this.releaseDigest || request.release_digest === this.releaseDigest, 'RELEASE_MISMATCH');
    requireCondition(request.epoch >= this.epoch && Array.isArray(request.bindings) &&
      request.bindings.every(value => this.bindings.has(value)), 'RELEASE_MISMATCH');
    if (this.changing) await this.changing;
    requireCondition(request.epoch >= this.epoch, 'HOST_STALE');
    if (request.epoch > this.epoch) {
      this.epoch = request.epoch;
      const tmp = this.epochFile + '.tmp';
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {fs.writeFileSync(fd, JSON.stringify({epoch: this.epoch})); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      fs.renameSync(tmp, this.epochFile);
      const dirfd = fs.openSync(path.dirname(this.epochFile), 'r'); try {fs.fsyncSync(dirfd);} finally {fs.closeSync(dirfd);}
      this.changing = (async () => {
        for (const lease of this.leases.values()) {lease.retired = true; lease.abort.abort();}
        for (const slot of this.resources.values()) await this.dispose(slot);
        this.leases.clear();
      })();
      try {await this.changing;} finally {this.changing = null;}
    }
    for (const slot of this.resources.values()) if (slot.fenced) await this.dispose(slot);
    return {protocol_version: HOST_VERSION, ...(this.releaseDigest ? {release_digest: this.releaseDigest} : {}), generation: this.generation, epoch: this.epoch, lease_ms: LEASE_MS, heartbeat_ms: HEARTBEAT_MS};
  }
  live(lease) {return lease.expires > this.clock() && lease.monotonicDeadline > this.monotonic();}
  queue(slot, fn) {
    const result = (slot.queue ?? Promise.resolve()).catch(() => {}).then(fn);
    slot.queue = result; return result;
  }
  stamp(slot) {
    return {generation: this.generation, epoch: this.epoch, activities: [...slot.leases]
      .map(id => this.leases.get(id)).filter(lease => lease && !lease.retired)
      .map(lease => ({id: lease.id, kind: lease.kind, expires_ms: lease.expires})), idle_until_ms: slot.idleUntil ?? 0};
  }
  async acquire(request, {grant, resource}, spec) {
    requireCondition(typeof request.task_id === 'string' && /^[A-Za-z0-9-]{1,128}$/u.test(request.task_id), 'HOST_PROTOCOL_INVALID');
    const key = digest({owner: grant.owner, principal: grant.principal, profile: resource.profile_id,
      credentials: resource.credential_generation, pool: resource.pool_key ?? request.task_id,
      app: grant.app, family: spec.host.family ?? grant.command});
    let slot = this.resources.get(key);
    const reused = Boolean(slot);
    if (slot) {
      // A Reader and watcher may arrive together for the same signed pool.
      // Join creation before checking activity conflicts; never create a
      // second page or grant access to a retiring resource.
      if (slot.creating) await slot.creation;
      requireCondition(!slot.fenced && !slot.disposing && !slot.retiring, 'HOST_RESOURCE_BUSY');
    }
    else {
      slot = {key, leases: new Set(), handle: null, creating: true, epoch: this.epoch,
        idleMS: Math.min(spec.host.reuse_idle_ms ?? 0, 1800000)};
      this.resources.set(key, slot);
      slot.creation = this.driver.create({task: request.task_id, epoch: this.epoch, generation: this.generation, spec, grant, resource});
      try {slot.handle = await slot.creation;}
      catch (error) {
        slot.handle = error.resourceHandle ?? null; slot.fenced = true;
        // A driver supplies resourceHandle when cleanup cannot be proved.
        // A rejected reservation that created no resource may be retried.
        if (!slot.handle) this.resources.delete(key);
        throw error;
      }
      finally {slot.creating = false;}
      if (this.changing || request.epoch !== this.epoch || this.closed || grant.execution_expires_ms <= this.clock()) {
        await this.dispose(slot); throw new RuntimeError('HOST_STALE');
      }
    }
    requireCondition(!this.changing && request.epoch === this.epoch && !this.closed &&
      this.resources.get(key) === slot && grant.execution_expires_ms > this.clock(), 'HOST_STALE');
    const kind = spec.host.activity ?? 'exclusive';
    slot.idleUntil = 0; slot.idleDeadline = 0;
    requireCondition([...slot.leases].every(id => {
      const other = this.leases.get(id);
      return !other || other.retired || (kind !== 'exclusive' && other.kind !== 'exclusive' && other.kind !== kind);
    }), 'HOST_RESOURCE_BUSY');
    const lease = {id: randomUUID(), task: request.task_id, epoch: this.epoch, slot, kind, owner: grant.owner,
      principal: grant.principal, intent: grant.intent_digest, resourceDigest: digest(resource), reference: request.authorization_ref,
      revision: grant.revision, expires: Math.min(this.clock() + LEASE_MS, grant.execution_expires_ms), abort: new AbortController()};
    lease.monotonicDeadline = this.monotonic() + Math.max(0, lease.expires - this.clock());
    this.leases.set(lease.id, lease); slot.leases.add(lease.id);
    try {
      await this.driver.beginActivity?.(slot.handle, {id: lease.id, kind, spec, grant, resource, task: request.task_id, signal: lease.abort.signal});
      await this.driver.updateLease(slot.handle, this.stamp(slot));
    }
    catch (error) {await this.drop(lease); throw error;}
    return {lease_id: lease.id, generation: this.generation, expires_ms: lease.expires, reused};
  }
  async drop(lease, {park = false, invalidate = false} = {}) {
    if (lease.dropping) return lease.dropping;
    lease.retired = true; lease.abort.abort();
    lease.slot.retiring = (lease.slot.retiring ?? 0) + 1;
    lease.dropping = (async () => {
      try {
        // Finish an aborted action before releasing its scheduler reservation.
        // Keep the last stamp until close: publishing an empty lease first
        // would race the daemon watchdog against explicit page cleanup.
        await lease.slot.queue?.catch(() => {});
        if (invalidate) {
          await this.dispose(lease.slot);
        } else {
          lease.slot.leases.delete(lease.id);
          if (park && !lease.slot.leases.size && lease.slot.idleMS) {
            lease.slot.idleUntil = this.clock() + lease.slot.idleMS;
            lease.slot.idleDeadline = this.monotonic() + lease.slot.idleMS;
          }
          if (!lease.slot.leases.size && !lease.slot.idleUntil) await this.dispose(lease.slot);
          else {
            await this.driver.updateLease(lease.slot.handle, this.stamp(lease.slot));
            await this.driver.revokeActivity?.(lease.slot.handle, lease.id, lease.kind);
          }
        }
        this.leases.delete(lease.id);
        this.released.set(lease.id, lease);
        while (this.released.size > 1024) this.released.delete(this.released.keys().next().value);
      } catch (error) {lease.slot.fenced = true; lease.dropping = null; throw error;}
      finally {lease.slot.retiring--;}
    })();
    return lease.dropping;
  }
  async dispose(slot) {
    if (slot.disposing) return slot.disposing;
    slot.fenced = true;
    for (const id of slot.leases) {const lease = this.leases.get(id); if (lease) {lease.retired = true; lease.abort.abort();}}
    slot.disposing = (async () => {
      try {
        if (slot.creation) {try {slot.handle = await slot.creation;} catch { /* Driver retained a partial cleanup handle above. */ }}
        await slot.queue?.catch(() => {});
        await this.driver.close(slot.handle);
        for (const id of slot.leases) this.leases.delete(id);
        if (this.resources.get(slot.key) === slot) this.resources.delete(slot.key);
      } finally {slot.disposing = null;}
    })();
    return slot.disposing;
  }
  async expire() {
    const outcomes = await Promise.allSettled([...this.leases.values()].filter(lease => !this.live(lease)).map(lease => this.drop(lease)));
    outcomes.push(...await Promise.allSettled([...this.resources.values()].filter(slot => slot.idleUntil && (slot.idleUntil <= this.clock() || slot.idleDeadline <= this.monotonic())).map(slot => this.dispose(slot))));
    if (outcomes.some(result => result.status === 'rejected')) throw new RuntimeError('HOST_CLEANUP_FAILED');
  }
  async drainIdle() {
    for (const slot of this.resources.values()) {
      // A live watcher owns a bounded lease even when no Reader reservation
      // is held. Foreground work must not treat that page as idle and retire
      // its subscription. Only parked resources without activities are idle.
      if (!slot.creating && !slot.leases.size) await this.dispose(slot);
    }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await Promise.all([...this.resources.values()].map(slot => this.dispose(slot)));
  }
}

export class BrowserHostClient {
  constructor({authorization, bindings, transport, releaseDigest}) {this.releaseDigest = releaseDigest; this.authorization = authorization; this.bindings = bindings; this.transport = transport;}
  async send(value) {
    return this.transport(signHostRequest(this.authorization, {protocol_version: HOST_VERSION, epoch: this.epoch,
      ...(this.generation ? {generation: this.generation} : {}), ...value}));
  }
  async connect(epoch) {
    this.epoch = epoch;
    const result = await this.send({operation: 'hello', bindings: this.bindings.map(digest), ...(this.releaseDigest ? {release_digest: this.releaseDigest} : {})});
    requireCondition((!this.releaseDigest || result.release_digest === this.releaseDigest) && result.protocol_version === HOST_VERSION && result.epoch === epoch && typeof result.generation === 'string', 'HOST_PROTOCOL_INVALID');
    this.generation = result.generation;
  }
  async acquire(context) {
    const identity = () => ({authorization_ref: context.authorization(), task_id: context.task_id});
    let value;
    try {value = await this.send({operation: 'acquire', ...identity()});}
    catch (error) {
      if (error.code !== 'HOST_STALE') throw error;
      // Resource admission has not happened, so a fresh Host handshake is
      // safe here. Calls already dispatched to an old lease are never retried.
      await this.connect(this.epoch); value = await this.send({operation: 'acquire', ...identity()});
    }
    let closed = false, failure = null, heartbeatRunning = false;
    const send = (operation, fields = {}) => this.send({operation, lease_id: value.lease_id, ...identity(), ...fields});
    const timer = setInterval(async () => {
      if (closed || heartbeatRunning) return;
      heartbeatRunning = true;
      try {await send('heartbeat');} catch (error) {failure = error;} finally {heartbeatRunning = false;}
    }, HEARTBEAT_MS); timer.unref();
    return {reused: value.reused, lease_id: value.lease_id,
      call: async (method, ...args) => {
        context.check(); if (failure) throw failure;
        requireCondition(!closed, 'HOST_LEASE_EXPIRED');
        const response = await send('call', {method, arguments: args});
        if (!response.artifact) return response.result;
        const artifact = response.artifact;
        const root = context.resource.host_runtime_root;
        requireCondition(typeof root === 'string' && path.isAbsolute(root) && typeof artifact.path === 'string' &&
          path.resolve(artifact.path).startsWith(path.resolve(root) + path.sep) && Number.isSafeInteger(artifact.bytes) &&
          artifact.bytes > 0 && artifact.bytes <= 16 * 1024 * 1024, 'HOST_ARTIFACT_INVALID');
        const actual = fs.realpathSync(artifact.path);
        requireCondition(actual === artifact.path && actual.startsWith(fs.realpathSync(root) + path.sep), 'HOST_ARTIFACT_INVALID');
        const bytes = privateRead(actual, 16 * 1024 * 1024);
        requireCondition(bytes.length === artifact.bytes && createHash('sha256').update(bytes).digest('hex') === artifact.sha256, 'HOST_ARTIFACT_INVALID');
        const result = decode(bytes, 16 * 1024 * 1024); fs.unlinkSync(actual); return result;
      },
      release: async ({park = false, invalidate = false} = {}) => {if (closed) return; clearInterval(timer); await send('release', {park, invalidate}); closed = true;},
    };
  }
}
