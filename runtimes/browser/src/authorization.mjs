import fs from 'node:fs';
import path from 'node:path';
import {createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {decode, digest, encode, requireCondition} from './protocol.mjs';

export function privateDirectory(directory) {
  requireCondition(path.isAbsolute(directory), 'CONFIGURATION_INVALID');
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(directory);
  requireCondition(stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'CONFIGURATION_INVALID');
}
export function privateRead(file, maximum = 65536) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    requireCondition(stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size <= maximum, 'AUTHORIZATION_INVALID');
    const bytes = Buffer.alloc(maximum + 1);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    requireCondition(size <= maximum, 'AUTHORIZATION_INVALID');
    return bytes.subarray(0, size);
  } finally { fs.closeSync(fd); }
}
export class SignedFileAuthorization {
  constructor(directory, keyFile) {
    privateDirectory(directory); this.directory = directory; this.key = privateRead(keyFile, 32);
    requireCondition(this.key.length === 32, 'CONFIGURATION_INVALID');
  }
  mac(payload) { return createHmac('sha256', this.key).update(digest(payload)).digest('hex'); }
  record(reference) {
    requireCondition(typeof reference === 'string' && /^[0-9a-f-]{36}$/u.test(reference), 'AUTHORIZATION_INVALID');
    const record = decode(privateRead(path.join(this.directory, reference + '.json')), 65536);
    requireCondition(Object.keys(record).sort().join() === 'grant,mac,resource' && /^[0-9a-f]{64}$/u.test(record.mac), 'AUTHORIZATION_INVALID');
    requireCondition(timingSafeEqual(Buffer.from(record.mac), Buffer.from(this.mac({grant: record.grant, resource: record.resource}))), 'AUTHORIZATION_INVALID');
    return record;
  }
  issue(grant, resource) {
    const payload = {grant, resource}, reference = randomUUID();
    const file = path.join(this.directory, reference + '.json'), temporary = file + '.tmp';
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, encode({...payload, mac: this.mac(payload)}, 65536)); fs.fsyncSync(fd);
      fs.linkSync(temporary, file);
      const dir = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { fs.closeSync(fd); fs.unlinkSync(temporary); }
    return reference;
  }
}
