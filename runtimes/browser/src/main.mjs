#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {SignedFileAuthorization, privateRead, privateDirectory} from './authorization.mjs';
import {decode, requireCondition} from './protocol.mjs';
import {Ledger} from './ledger.mjs';
import {Executor} from './executor.mjs';
import {serve} from './socket.mjs';

process.umask(0o077);
try {
  requireCondition(process.argv.length === 4, 'CONFIGURATION_INVALID');
  const config = decode(privateRead(process.argv[2]));
  privateDirectory(config.state_directory);
  const lock = fs.fstatSync(Number(process.argv[3]));
  const expected = fs.lstatSync(path.join(config.state_directory, 'executor.lock'));
  requireCondition(lock.isFile() && lock.ino === expected.ino && lock.dev === expected.dev && lock.uid === process.getuid(), 'EXECUTOR_LOCK_REQUIRED');
  const authorization = new SignedFileAuthorization(config.grants_directory, config.issuer_key_file);
  const ledger = new Ledger(config.state_directory);
  // Installation-owned assembly module, never selected by command arguments.
  requireCondition(path.isAbsolute(config.assembly_module), 'CONFIGURATION_INVALID');
  const assembly = await import(pathToFileURL(config.assembly_module));
  const {bindings, handlers, host} = await assembly.assemble({config, authorization, epoch: ledger.epoch});
  await host?.connect?.(ledger.epoch);
  const executor = new Executor({ledger, authorization, bindings, handlers, host});
  requireCondition(path.dirname(config.socket) === config.state_directory, 'CONFIGURATION_INVALID');
  if (fs.existsSync(config.socket)) {
    requireCondition(fs.lstatSync(config.socket).isSocket(), 'CONFIGURATION_INVALID'); fs.unlinkSync(config.socket);
  }
  const server = await serve(config.socket, request => executor.control(request));
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    // A stuck backend cannot prevent service shutdown indefinitely. Its ledger
    // remains active/uncertain for the next epoch; host leases independently expire.
    const watchdog = setTimeout(() => process.exit(1), 30000); watchdog.unref();
    try {await server.close(); await executor.close(); await host?.close?.(); ledger.close();}
    finally {clearTimeout(watchdog); process.exit(0);}
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} catch (error) {
  process.stderr.write(`${/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code : 'EXECUTOR_START_FAILED'}\n`);
  process.exitCode = 1;
}
