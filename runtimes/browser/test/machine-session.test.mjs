import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash, randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {MachineSessionPool} from '../src/machine-session.mjs';
import {ProductClient} from '../src/product-client.mjs';
import {SignedFileAuthorization} from '../src/authorization.mjs';
import {digest, intentDigest, OPERATIONS} from '../src/protocol.mjs';
import {exchange} from '../src/socket.mjs';
import {binding} from './fixture-assembly.mjs';

const runtime = fileURLToPath(new URL('../', import.meta.url));
const repository = path.resolve(runtime, '../..');
const python = process.env.APP_CLI_TEST_PYTHON ?? path.join(repository, '.venv/bin/python');
const key = name => `op3.1.1.${createHash('sha256').update(name).digest('hex').slice(0, 32)}`;
const hello = {protocol_version: '3.0', kind: 'session', session_version: 1};

// A scripted stand-in for one session process: `answer` maps a request to the
// lines it writes back (or null to stay silent).
function fakeSpawn(answer, {greeting = hello} = {}) {
  const children = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.pid = 1e7 + children.length; child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.killed = false;
    children.push(child);
    let buffer = '';
    child.stdin.on('data', chunk => {
      buffer += chunk;
      for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        const reply = answer(request, child);
        if (reply === 'crash') {child.stdout.end(); child.emit('close', 1); continue;}
        if (reply !== null) child.stdout.write(JSON.stringify(reply) + '\n');
      }
    });
    setImmediate(() => child.stdout.write(JSON.stringify(greeting) + '\n'));
    return child;
  };
  return {children, spawnProcess};
}
const echo = request => ({protocol_version: '3.0', kind: 'ack', operation: request.operation, echo: request.n});

test('a session answers many requests and a pool bounds concurrent processes', async () => {
  const fake = fakeSpawn(echo);
  const pool = new MachineSessionPool({python: '/bin/false', size: 2, spawnProcess: fake.spawnProcess});
  const replies = await Promise.all(Array.from({length: 9}, (_, n) => pool.exchange({operation: 'status', n})));
  assert.deepEqual(replies.map(reply => reply.echo), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(fake.children.length, 2);
  for (let n = 0; n < 5; n++) await pool.exchange({operation: 'status', n});
  assert.equal(fake.children.length, 2);
  pool.close();
});

test('an older entry without sessions disables the pool instead of answering', async () => {
  const fake = fakeSpawn(echo, {greeting: {protocol_version: '3.0', kind: 'error', error: {code: 'INVALID_ARGUMENT', message: 'x'}}});
  const pool = new MachineSessionPool({python: '/bin/false', spawnProcess: fake.spawnProcess});
  assert.equal(await pool.exchange({operation: 'status', n: 1}), null);
  assert.equal(await pool.exchange({operation: 'status', n: 2}), null);
  assert.equal(fake.children.length, 1);
});

test('a silent or crashing session surfaces a transport error and is replaced', async () => {
  let mode = 'silent';
  const fake = fakeSpawn(request => mode === 'silent' ? null : mode === 'crash' ? 'crash' : echo(request));
  const pool = new MachineSessionPool({python: '/bin/false', timeoutMs: 100, spawnProcess: fake.spawnProcess});
  await assert.rejects(pool.exchange({operation: 'invoke', n: 1}), {code: 'CONTROL_TIMEOUT'});
  mode = 'crash';
  await assert.rejects(pool.exchange({operation: 'invoke', n: 2}), {code: 'BACKEND_UNAVAILABLE'});
  mode = 'echo';
  assert.equal((await pool.exchange({operation: 'status', n: 3})).echo, 3);
  assert.equal(fake.children.length, 3);
  pool.close();
});

test('sessions are recycled after their request budget', async () => {
  const fake = fakeSpawn(echo);
  const pool = new MachineSessionPool({python: '/bin/false', maxRequests: 3, spawnProcess: fake.spawnProcess});
  for (let n = 0; n < 7; n++) await pool.exchange({operation: 'status', n});
  assert.equal(fake.children.length, 3);
  pool.close();
});

test('the real Python Registry serves control calls from one resident session', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'app-cli-session-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const config = {state_directory: directory, grants_directory: path.join(directory, 'grants'),
    issuer_key_file: path.join(directory, 'issuer'), node: process.execPath, runtime_directory: runtime,
    assembly_module: fileURLToPath(new URL('./fixture-assembly.mjs', import.meta.url)), socket: path.join(directory, 'executor.sock')};
  const bindingPath = path.join(directory, 'binding.json');
  fs.writeFileSync(bindingPath, JSON.stringify(binding), {mode: 0o600});
  config.bindings = [{path: bindingPath, digest: digest(binding)}];
  fs.writeFileSync(config.issuer_key_file, randomBytes(32), {mode: 0o600});
  const configFile = path.join(directory, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config), {mode: 0o600});
  const service = spawn(python, ['-m', 'app_cli.executor_service', configFile], {cwd: repository, stdio: 'ignore'});
  t.after(async () => {
    if (service.exitCode !== null || service.signalCode !== null) return;
    const stopped = new Promise(resolve => service.once('exit', resolve)); service.kill('SIGTERM'); await stopped;
  });
  const authorization = new SignedFileAuthorization(config.grants_directory, config.issuer_key_file);
  const request = {protocol_version: '3.0', operation: 'prepare', app: 'local-fixture', command: 'increment',
    request_key: key('resident-session'), arguments: {}, deadline_ms: Date.now() + 120000};
  request.authorization_ref = authorization.issue({principal: 'fixture-principal', owner: 'fixture-owner', app: request.app,
    command: request.command, request_key: request.request_key, intent_digest: intentDigest(request), side_effect: 'local_mutation',
    operations: OPERATIONS.filter(operation => operation !== 'epoch'), access_expires_ms: Date.now() + 600000,
    execution_expires_ms: Date.now() + 60000, max_deadline_ms: request.deadline_ms, task_id: null, revision: 1}, {binding_digest: digest(binding)});
  const control = (operation, task) => ({protocol_version: '3.0', app: request.app, command: request.command,
    authorization_ref: request.authorization_ref, operation, task_id: task});
  const lookup = {protocol_version: '3.0', app: request.app, command: request.command,
    authorization_ref: request.authorization_ref, operation: 'lookup', request_key: request.request_key};
  for (let ready = false, stop = Date.now() + 6000; !ready;) {
    try {await exchange(config.socket, lookup); ready = true;}
    catch (error) {if (Date.now() > stop) throw error; await delay(20);}
  }
  let spawned = 0;
  const product = new ProductClient({configFile, python, sessions: {spawnProcess: (...args) => {spawned++; return spawn(...args);}}});
  t.after(() => product.close());
  const prepared = await product.machine(request);
  assert.equal(prepared.task.status, 'prepared');
  await product.machine(control('invoke', prepared.task.id));
  let status;
  const started = performance.now();
  for (let reads = 0; reads < 20; reads++) status = await product.machine(control('status', prepared.task.id));
  t.diagnostic(`20 resident status reads: ${(performance.now() - started).toFixed(1)} ms`);
  assert.ok(['running', 'completed'].includes(status.task.status));
  assert.equal(spawned, 1);
  // A Registry error inside a session is the same RPC error as one-shot.
  await assert.rejects(product.machine({...control('status', 'task-missing')}), error => typeof error.code === 'string');
  assert.equal(spawned, 1);
});
