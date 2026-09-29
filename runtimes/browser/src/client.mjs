#!/usr/bin/env node
import {decode, encode, REQUEST_LIMIT} from './protocol.mjs';
import {exchange} from './socket.mjs';

try {
  if (process.argv.length !== 3) throw new Error('configuration');
  let size = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length; if (size > REQUEST_LIMIT) throw new Error('limit'); chunks.push(chunk);
  }
  const response = await exchange(process.argv[2], decode(Buffer.concat(chunks)));
  process.stdout.write(encode(response));
} catch { process.exitCode = 1; }
