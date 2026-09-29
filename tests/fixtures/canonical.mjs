// Independent JavaScript conformance fixture, not an execution service.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

function canonical(value, depth = 0) {
  if (depth > 64) throw new Error('depth');
  let tag, payload;
  if (value === null) [tag, payload] = ['n', Buffer.alloc(0)];
  else if (typeof value === 'boolean') [tag, payload] = ['b', Buffer.from(value ? '1' : '0')];
  else if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error('number');
    tag = 'd'; payload = Buffer.alloc(8); payload.writeDoubleBE(value === 0 ? 0 : value);
  } else if (typeof value === 'string') {
    for (let index = 0; index < value.length; index++) {
      const point = value.codePointAt(index);
      if (point > 0xffff) index++;
      else if (point >= 0xd800 && point <= 0xdfff) throw new Error('surrogate');
    }
    [tag, payload] = ['s', Buffer.from(value, 'utf8')];
  } else if (Array.isArray(value)) {
    [tag, payload] = ['a', Buffer.concat(value.map(item => canonical(item, depth + 1)))];
  } else if (typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    [tag, payload] = ['o', Buffer.concat(keys.flatMap(key => [canonical(key, depth + 1), canonical(value[key], depth + 1)]))];
  } else throw new Error('type');
  return Buffer.concat([Buffer.from(`${tag}${payload.length}:`, 'ascii'), payload]);
}
const values = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(values.map(value => createHash('sha256').update(canonical(value)).digest('hex'))));
