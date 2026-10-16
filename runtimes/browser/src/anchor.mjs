import http from 'node:http';
import https from 'node:https';
import {privateRead} from './authorization.mjs';
import {decode, encode, requireCondition, RuntimeError} from './protocol.mjs';

// Independent progress anchor for dispatch release. Only the release of an
// external dispatch advances it; admission, ACK, GC and queries never wait on
// it. `read` is used at startup and after any CAS failure to detect rollback.
export const RING = 256;

function validState(state) {
  return state && Number.isSafeInteger(state.generation) && state.generation > 0 &&
    Number.isSafeInteger(state.seq) && state.seq >= 0 && /^[0-9a-f]{64}$/u.test(state.digest) &&
    Array.isArray(state.ring) && state.ring.length <= RING && state.ring.every(entry =>
      Number.isSafeInteger(entry.seq) && entry.seq > 0 && entry.seq <= state.seq && typeof entry.operation_id === 'string' &&
      entry.operation_id.length <= 128 && Number.isSafeInteger(entry.attempt) && entry.attempt > 0) &&
    Number.isSafeInteger(state.time_ms) && state.time_ms > 0;
}

// Profile C: no independent anchor. Releases are confirmed locally only.
export class NoAnchor {
  get kind() {return 'none';}
  async read() {return null;}
  async advance() {return null;}
  async reseed() {return null;}
}

// Deterministic in-process anchor for tests and fault injection.
export class MemoryAnchor {
  constructor({clock = Date.now} = {}) {
    this.clock = clock; this.state = null; this.unavailable = false; this.loseResponse = false; this.calls = [];
  }
  get kind() {return 'memory';}
  check() {if (this.unavailable) throw new RuntimeError('ANCHOR_UNAVAILABLE');}
  async read() {this.check(); return this.state && structuredClone({...this.state, time_ms: this.clock()});}
  async advance({generation, previous_seq, next_seq, digest, operation_id, attempt}) {
    this.check(); this.calls.push({previous_seq, next_seq, digest});
    const state = this.state ?? {generation, seq: 0, digest: '0'.repeat(64), ring: []};
    if (state.seq === next_seq && state.digest === digest && state.generation === generation) return {seq: state.seq, digest};
    if (state.generation !== generation || state.seq !== previous_seq || next_seq !== previous_seq + 1) throw new RuntimeError('ANCHOR_CONFLICT');
    this.state = {generation, seq: next_seq, digest, ring: [...state.ring, {seq: next_seq, operation_id, attempt}].slice(-RING)};
    if (this.loseResponse) {this.loseResponse = false; throw new RuntimeError('ANCHOR_UNAVAILABLE');}
    return {seq: next_seq, digest};
  }
  async reseed({generation, seq, digest}) {
    this.check();
    requireCondition(!this.state || generation > this.state.generation, 'ANCHOR_CONFLICT');
    this.state = {generation, seq, digest, ring: []};
    return {seq, digest};
  }
}

// Remote anchor service: JSON over HTTP(S) or a Unix socket, bearer-token
// authenticated. The service owns persistence outside this state directory.
export class HttpAnchor {
  constructor({url, socket, owner, token_file, timeout_ms = 5000}) {
    requireCondition(typeof owner === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(owner) &&
      (typeof url === 'string' || typeof socket === 'string'), 'CONFIGURATION_INVALID');
    this.url = new URL(url ?? 'http://anchor.local/'); this.socket = socket; this.owner = owner;
    this.token = privateRead(token_file, 4096).toString().trim(); this.timeout = timeout_ms;
    requireCondition(this.token.length >= 32, 'CONFIGURATION_INVALID');
  }
  get kind() {return 'http';}
  call(action, body) {
    const payload = encode({owner: this.owner, ...body}, 64 * 1024);
    const target = new URL(`v1/anchors/${action}`, this.url.href.endsWith('/') ? this.url : new URL(this.url.href + '/'));
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(target, {method: 'POST', ...(this.socket ? {socketPath: this.socket} : {}),
        headers: {'content-type': 'application/json', authorization: `Bearer ${this.token}`, 'content-length': payload.length}},
      response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => {size += chunk.length; if (size > 256 * 1024) request.destroy(); else chunks.push(chunk);});
        response.on('end', () => {
          try {
            const value = decode(Buffer.concat(chunks), 256 * 1024);
            if (response.statusCode === 409) return reject(new RuntimeError('ANCHOR_CONFLICT'));
            if (response.statusCode !== 200) return reject(new RuntimeError('ANCHOR_UNAVAILABLE'));
            resolve(value);
          } catch {reject(new RuntimeError('ANCHOR_UNAVAILABLE'));}
        });
      });
      request.setTimeout(this.timeout, () => request.destroy());
      request.on('error', () => reject(new RuntimeError('ANCHOR_UNAVAILABLE')));
      request.end(payload);
    });
  }
  async read() {
    const value = await this.call('read', {});
    if (value.state === null) return null;
    requireCondition(validState(value.state), 'ANCHOR_UNAVAILABLE');
    return value.state;
  }
  async advance(body) {
    const value = await this.call('advance', body);
    requireCondition(value.seq === body.next_seq && value.digest === body.digest, 'ANCHOR_CONFLICT');
    return value;
  }
  async reseed(body) {return this.call('reseed', body);}
}

export function createAnchor(config) {
  const anchor = config?.anchor;
  if (!anchor || anchor.kind === 'none') return new NoAnchor();
  requireCondition(anchor.kind === 'http', 'CONFIGURATION_INVALID');
  return new HttpAnchor({...anchor, owner: anchor.owner ?? config.owner_id});
}
