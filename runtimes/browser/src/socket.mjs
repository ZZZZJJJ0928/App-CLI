import net from 'node:net';
import fs from 'node:fs';
import {decode, encode, envelope, REQUEST_LIMIT, RESPONSE_LIMIT, RuntimeError, validateResponse} from './protocol.mjs';

// EOF-delimited, one message per connection. No transport-level retry.
export function exchange(socketPath, request, {timeout = 15000, requestLimit = REQUEST_LIMIT, responseLimit = RESPONSE_LIMIT} = {}) {
  const payload = encode(request, requestLimit);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => socket.end(payload));
    const chunks = []; let size = 0, done = false;
    const finish = (error, value) => {
      if (done) return; done = true; socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(timeout, () => finish(new RuntimeError('CONTROL_TIMEOUT')));
    socket.on('error', () => finish(new RuntimeError('BACKEND_UNAVAILABLE')));
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > responseLimit) finish(new RuntimeError('OUTPUT_VALIDATION_FAILED')); else chunks.push(chunk);
    });
    socket.on('end', () => {
      try {finish(null, decode(Buffer.concat(chunks), responseLimit));} catch {finish(new RuntimeError('BACKEND_PROTOCOL_INVALID'));}
    });
  });
}

export async function serve(socketPath, control, {timeout = 15000} = {}) {
  const connections = new Set();
  const server = net.createServer({allowHalfOpen: true}, socket => {
    connections.add(socket); socket.once('close', () => connections.delete(socket));
    socket.on('error', () => {}); socket.setTimeout(timeout, () => socket.destroy());
    const chunks = []; let size = 0;
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > REQUEST_LIMIT) socket.destroy(); else chunks.push(chunk);
    });
    socket.on('end', async () => {
      let request, response;
      try {
        request = decode(Buffer.concat(chunks)); response = await control(request);
        if (!validateResponse(response)) throw new RuntimeError('OUTPUT_VALIDATION_FAILED');
        socket.end(encode(response));
      } catch (error) {
        const code = /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code : 'BACKEND_EXECUTION_FAILED';
        response = {protocol_version: '2.0', kind: 'error', error: {code}};
        if (request && typeof request === 'object') response = envelope(request, response);
        try {socket.end(encode(response));} catch {socket.destroy();}
      }
    });
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(socketPath, resolve);});
  fs.chmodSync(socketPath, 0o600);
  return {async close() {
    for (const socket of connections) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }};
}
