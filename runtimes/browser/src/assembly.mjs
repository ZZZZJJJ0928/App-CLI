import {verifyRelease} from './release.mjs';
import fs from 'node:fs/promises';
import {mailHandlers} from '../applications/mail/handlers.mjs';
import {BrowserHostClient} from './host-port.mjs';
import {hostTransport} from './http-transport.mjs';
import {digest, requireCondition} from './protocol.mjs';

export async function assemble({config, authorization}) {
  verifyRelease(config);
  const bindings = await Promise.all(config.bindings.map(async installed => {
    const binding = JSON.parse(await fs.readFile(installed.path, 'utf8'));
    requireCondition(digest(binding) === installed.digest, 'RELEASE_MISMATCH'); return binding;
  }));
  return {bindings, handlers: await mailHandlers(), host: new BrowserHostClient({authorization, bindings, releaseDigest: config.release_digest,
    transport: request => hostTransport(config.browser_host_socket, request)})};
}
