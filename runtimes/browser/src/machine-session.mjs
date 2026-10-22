import {spawn} from 'node:child_process';
import {decode, encode, PROTOCOL_VERSION, RESPONSE_LIMIT, RuntimeError} from './protocol.mjs';

const REQUEST_LIMIT = 2 * 1024 * 1024;

// Resident `python -m app_cli --machine --session` processes. Each process has at
// most one request in flight, so Registry.control keeps its one-shot semantics;
// only process startup and release verification are amortized. A session that
// misbehaves is killed and replaced; callers see the same transport errors as
// a failed one-shot process and recover through lookup as before.
export class MachineSessionPool {
  constructor({python, env, size = 4, timeoutMs = 25000, idleMs = 30000, maxRequests = 1000, maxAgeMs = 600000,
    spawnProcess = spawn, now = Date.now} = {}) {
    Object.assign(this, {python, env, size, timeoutMs, idleMs, maxRequests, maxAgeMs, spawnProcess, now});
    this.idle = []; this.busy = new Set(); this.waiting = []; this.unsupported = false; this.closed = false;
  }

  // Resolves with the decoded response, or with null when sessions are not
  // supported by the installed Python entry (the caller then uses one-shot).
  async exchange(request) {
    if (this.unsupported || this.closed) return null;
    const payload = encode(request, REQUEST_LIMIT);
    const session = await this.#acquire();
    if (!session) return null;
    try {return await session.send(payload, this.timeoutMs);}
    finally {this.#release(session);}
  }

  async #acquire() {
    for (;;) {
      if (this.unsupported || this.closed) return null;
      const session = this.idle.pop();
      if (session) {
        if (session.alive && !this.#expired(session)) {session.idleSince = undefined; session.ref(); this.busy.add(session); return session;}
        session.stop(); continue;
      }
      if (this.busy.size < this.size) {
        const fresh = this.#start();
        this.busy.add(fresh);
        if (await fresh.ready) return fresh;
        this.busy.delete(fresh);
        return null;
      }
      await new Promise(resolve => this.waiting.push(resolve));
    }
  }

  #release(session) {
    this.busy.delete(session);
    if (!session.alive || this.closed || this.#expired(session)) session.stop();
    else {session.unref(); this.idle.push(session); session.idleSince = this.now();}
    this.#sweep();
    this.waiting.shift()?.();
  }

  #expired(session) {
    return session.requests >= this.maxRequests || this.now() - session.started >= this.maxAgeMs ||
      session.idleSince !== undefined && this.now() - session.idleSince >= this.idleMs;
  }

  #sweep() {
    clearTimeout(this.sweepTimer);
    if (!this.idle.length) return;
    this.sweepTimer = setTimeout(() => {
      this.idle = this.idle.filter(session => {
        if (session.alive && !this.#expired(session)) return true;
        session.stop(); return false;
      });
      this.#sweep();
    }, this.idleMs);
    this.sweepTimer.unref?.();
  }

  #start() {
    const child = this.spawnProcess(this.python, ['-m', 'app_cli', '--machine', '--session'], {shell: false,
      env: this.env, stdio: ['pipe', 'pipe', 'ignore'], detached: true});
    const session = {child, alive: true, requests: 0, started: this.now(), pending: null, buffer: Buffer.alloc(0)};
    const fail = code => {
      session.alive = false;
      const pending = session.pending; session.pending = null;
      pending?.reject(new RuntimeError(code));
    };
    session.stop = () => {
      if (!session.alive && session.stopped) return;
      session.stopped = true; session.alive = false;
      try {process.kill(-child.pid, 'SIGKILL');} catch {}
    };
    session.ref = () => {child.ref?.(); child.stdout?.ref?.(); child.stdin?.ref?.();};
    session.unref = () => {child.unref?.(); child.stdout?.unref?.(); child.stdin?.unref?.();};
    let greet;
    session.ready = new Promise(resolve => {greet = resolve;});
    const helloTimer = setTimeout(() => {greet(false); session.stop();}, this.timeoutMs);
    const line = raw => {
      let value;
      try {value = decode(raw, RESPONSE_LIMIT);} catch {fail('BACKEND_PROTOCOL_INVALID'); session.stop(); return;}
      if (!session.greeted) {
        clearTimeout(helloTimer);
        if (value?.kind === 'session' && value.protocol_version === PROTOCOL_VERSION && value.session_version === 1) {
          session.greeted = true; greet(true);
        } else {
          // An older entry rejects --session; never treat its reply as an answer.
          this.unsupported = true; greet(false); session.stop();
        }
        return;
      }
      const pending = session.pending; session.pending = null;
      if (!pending) {session.stop(); return;}
      pending.resolve(value);
    };
    child.on('error', () => {clearTimeout(helloTimer); greet(false); fail('BACKEND_UNAVAILABLE');});
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      session.buffer = Buffer.concat([session.buffer, chunk]);
      let newline;
      while ((newline = session.buffer.indexOf(10)) >= 0) {
        const raw = session.buffer.subarray(0, newline); session.buffer = session.buffer.subarray(newline + 1);
        line(raw);
      }
      if (session.buffer.length > RESPONSE_LIMIT) {fail('OUTPUT_VALIDATION_FAILED'); session.stop();}
    });
    child.on('close', () => {clearTimeout(helloTimer); greet(false); fail('BACKEND_UNAVAILABLE'); session.alive = false;});
    session.send = (payload, timeoutMs) => new Promise((resolve, reject) => {
      if (!session.alive) {reject(new RuntimeError('BACKEND_UNAVAILABLE')); return;}
      session.requests++;
      const timer = setTimeout(() => {
        // The request may have been processed; the caller recovers by lookup.
        if (session.pending) {session.pending = null; reject(new RuntimeError('CONTROL_TIMEOUT'));}
        session.stop();
      }, timeoutMs);
      session.pending = {resolve: value => {clearTimeout(timer); resolve(value);}, reject: error => {clearTimeout(timer); reject(error);}};
      child.stdin.write(Buffer.concat([payload, Buffer.from('\n')]));
    });
    return session;
  }

  close() {
    this.closed = true; clearTimeout(this.sweepTimer);
    for (const session of [...this.idle, ...this.busy]) session.stop();
    this.idle = [];
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}
