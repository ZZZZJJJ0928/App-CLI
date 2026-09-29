import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

export const REQUEST_LIMIT = 2 * 1024 * 1024;
export const RESPONSE_LIMIT = 1024 * 1024;
export const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export class RuntimeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function requireCondition(condition, code = 'INPUT_VALIDATION_FAILED') {
  if (!condition) throw new RuntimeError(code);
}

// Deliberately shared encoding contract, independently implemented in Python.
export function canonical(value, depth = 0) {
  requireCondition(depth <= 64);
  let tag, payload;
  if (value === null) [tag, payload] = ['n', Buffer.alloc(0)];
  else if (typeof value === 'boolean') [tag, payload] = ['b', Buffer.from(value ? '1' : '0')];
  else if (typeof value === 'number') {
    requireCondition(Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER);
    tag = 'd'; payload = Buffer.alloc(8); payload.writeDoubleBE(value === 0 ? 0 : value);
  } else if (typeof value === 'string') {
    requireCondition(value.isWellFormed());
    [tag, payload] = ['s', Buffer.from(value)];
  } else if (Array.isArray(value)) {
    [tag, payload] = ['a', Buffer.concat(value.map(item => canonical(item, depth + 1)))];
  } else if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    [tag, payload] = ['o', Buffer.concat(keys.flatMap(key => [canonical(key, depth + 1), canonical(value[key], depth + 1)]))];
  } else throw new RuntimeError('INPUT_VALIDATION_FAILED');
  return Buffer.concat([Buffer.from(`${tag}${payload.length}:`), payload]);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export function intentDigest(request) {
  const value = Object.fromEntries(['app', 'command', 'request_key', 'arguments', 'deadline_ms']
    .filter(key => Object.hasOwn(request, key)).map(key => [key, request[key]]));
  return digest(value);
}

// Reject duplicate keys before JSON.parse, including escaped duplicates.
export function decode(raw, maximum = REQUEST_LIMIT) {
  requireCondition(Buffer.byteLength(raw) <= maximum);
  const source = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(raw));
  let at = 0;
  const space = () => { while (/\s/u.test(source[at] ?? '') && at < source.length) at++; };
  function string() {
    const start = at++;
    while (at < source.length) {
      if (source[at] === '\\') { at += 2; continue; }
      if (source[at++] === '"') return JSON.parse(source.slice(start, at));
    }
    throw new RuntimeError('INPUT_VALIDATION_FAILED');
  }
  function scan(depth) {
    requireCondition(depth <= 64); space();
    const token = source[at];
    if (token === '"') { string(); return; }
    if (token === '{' || token === '[') {
      const object = token === '{', end = object ? '}' : ']'; const keys = new Set();
      at++; space(); if (source[at] === end) { at++; return; }
      for (;;) {
        if (object) {
          space(); requireCondition(source[at] === '"'); const key = string();
          requireCondition(!keys.has(key)); keys.add(key); space(); requireCondition(source[at++] === ':');
        }
        scan(depth + 1); space(); if (source[at] === end) { at++; return; }
        requireCondition(source[at++] === ',');
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(source.slice(at));
    requireCondition(Boolean(match)); at += match[0].length;
  }
  scan(0); space(); requireCondition(at === source.length);
  const value = JSON.parse(source); canonical(value); return value;
}
export function encode(value, maximum = RESPONSE_LIMIT) {
  canonical(value);
  const raw = Buffer.from(JSON.stringify(value));
  requireCondition(raw.length <= maximum, 'OUTPUT_VALIDATION_FAILED'); return raw;
}
const schema = JSON.parse(readFileSync(new URL('../schemas/lifecycle-v2.schema.json', import.meta.url)));
const ajv = new Ajv2020({strict: false, allErrors: false});
ajv.addSchema(schema);
export const validateRequest = ajv.compile({$ref: `${schema.$id}#/$defs/request`});
export const validateResponse = ajv.compile({$ref: `${schema.$id}#/$defs/response`});
export const compileSchema = schema => ajv.compile(schema);
export function envelope(request, value) {
  return {protocol_version: '2.0', operation: request.operation, app: request.app, command: request.command,
    ...(request.request_key ? {request_key: request.request_key} : {}), ...value};
}
