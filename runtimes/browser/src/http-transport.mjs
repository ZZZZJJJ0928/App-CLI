import http from 'node:http';
import {decode, encode, REQUEST_LIMIT, RESPONSE_LIMIT, RuntimeError} from './protocol.mjs';

export function hostTransport(socket, request, {timeout = 75000} = {}) {
  const payload = encode(request, REQUEST_LIMIT);
  return new Promise((resolve, reject) => {
    const call = http.request({socketPath: socket, path: '/v1/application-host', method: 'POST',
      headers: {'Content-Type': 'application/json', 'Content-Length': payload.length}}, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {size += chunk.length; if (size > RESPONSE_LIMIT) call.destroy(new RuntimeError('HOST_OUTPUT_OVERFLOW')); else chunks.push(chunk);});
      response.on('error', reject);
      response.on('end', () => {
        try {
          const value = decode(Buffer.concat(chunks), RESPONSE_LIMIT);
          if (response.statusCode !== 200 || value.error) throw Object.assign(new RuntimeError(value.error?.code ?? 'HOST_UNAVAILABLE'), value.error?.diagnostic === 'process_exit_context_destroyed' ? {diagnosticReason: value.error.diagnostic} : {});
          resolve(value);
        } catch (error) {reject(error);}
      });
    });
    call.setTimeout(timeout, () => call.destroy(new RuntimeError('HOST_TIMEOUT')));
    call.once('error', reject); call.end(payload);
  });
}
