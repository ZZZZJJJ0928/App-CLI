import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decode, requireCondition} from './protocol.mjs';

export function verifyRelease(config) {
  // Explicit fixture assemblies may omit a release. The production mail
  // assembly and consumer always require the installed, pinned manifest.
  const root = fs.realpathSync(config.runtime_directory);
  const bytes = fs.readFileSync(path.join(root, 'release.json'));
  const sha = value => createHash('sha256').update(value).digest('hex');
  requireCondition(sha(bytes) === config.release_digest, 'RELEASE_MISMATCH');
  const release = decode(bytes);
  requireCondition(release.schema_version === 1 && release.id === config.release_id &&
    release.runtime_protocol === '2.0' && release.host_protocol === '1.0', 'RELEASE_MISMATCH');
  for (const [relative, hash] of Object.entries(release.files)) {
    const file = path.resolve(root, relative);
    requireCondition(file.startsWith(root + path.sep) && fs.realpathSync(file) === file &&
      sha(fs.readFileSync(file)) === hash, 'RELEASE_MISMATCH');
  }
  for (const binding of config.bindings) {
    const relative = path.relative(root, binding.path);
    requireCondition(relative.startsWith('bindings/') && release.files[relative], 'RELEASE_MISMATCH');
  }
  return release;
}
