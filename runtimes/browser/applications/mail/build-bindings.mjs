import fs from 'node:fs/promises';
import {ProviderScriptRegistry, providerScriptContract} from './runtime/provider-scripts.mjs';
import {outputSchema} from './output-schema.mjs';
import {inputSchema} from './input-schema.mjs';
import {digest} from '../../src/protocol.mjs';
import {installOutlookEarlyBridge} from './userscripts/lib/outlook-early-bridge.mjs';

const registry = new ProviderScriptRegistry(); await registry.prepare();
const root = new URL('../../', import.meta.url), check = process.argv.includes('--check');
async function write(relative, value) {
  const target = new URL(relative, root), rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  if (check) {if (await fs.readFile(target, 'utf8') !== rendered) throw new Error(`Stale generated artifact: ${relative}`);}
  else await fs.writeFile(target, rendered);
}
await fs.mkdir(new URL('bindings/', root), {recursive: true});
await write('assets/mail/outlook-before-navigation.js', `(${installOutlookEarlyBridge.toString()})();\n`);
for (const provider of ['gmail', 'outlook', 'qq_mail']) {
  const entries = [...registry.entries.values()].filter(entry => entry.provider === provider);
  const manifest = {schema_version: '1.0', id: `mail-${provider.replace('_', '-')}`, name: `${provider} mail`, version: '0.3.0',
    platforms: ['linux'], adapter: {kind: 'runtime', name: 'BrowserHostPort mail application'},
    commands: entries.map(entry => {
      const name = entry.operation === 'observe' ? 'watch' : entry.operation;
      return {name, description: `Run ${name} in the explicitly authorized ${provider} account.`,
        side_effect: ['send', 'mark_read'].includes(name) ? 'remote_mutation' : ['read', 'capture', 'collect_page'].includes(name) ? 'local_mutation' : 'read_only',
        input_schema: inputSchema(provider, name),
        output_schema: outputSchema(provider, name)};
    })};
  const commands = Object.fromEntries(entries.map(entry => {
    const name = entry.operation === 'observe' ? 'watch' : entry.operation;
    const read = ['read', 'discover', 'capture', 'enumerate_thread', 'mark_read', 'collect_page', 'watch'].includes(name);
    const shared = ['collect_page', 'watch'].includes(name);
    // The persistent watch has an independent execution lane. Its shared
    // Host family serializes initial page preparation with Reader work.
    return [name, {handler: `${provider}.${name}`, resource: name === 'watch' ? `${provider}.watch` : provider,
      ...(name === 'watch' ? {renewable: true} : {}), timeout_ms: entry.timeoutMS, script_id: entry.scriptID,
      revision: entry.revision, ...(name === 'send' ? {reconcile_requires_host: false} : {}), source_checksum: entry.sourceChecksum,
      host: {family: shared ? `${provider}.inbound` : name, activity: shared ? name === 'watch' ? 'watch' : 'read' : 'exclusive',
        invalidate_on_failure: name === 'collect_page', reuse_idle_ms: shared ? 1800000 : 0,
        methods: ['currentURL', 'count', 'attribute', 'value', 'text', 'lines', 'readMany', 'visible', 'enabled', 'evaluate',
          'click', 'runReadCode', 'download', 'fill', 'focus', 'press', 'waitFor', 'waitMilliseconds', 'navigate',
          'prepareBackgroundPage', 'inspect', 'act', 'probeReads', 'setSecrets', 'hookActivate', 'hookEvents'],
        page: {secretReadback: name === 'send', trustedDownloadSelectors: ['#sparkclaw-mail-original'], origins: entry.origins, downloadOrigins: entry.downloadOrigins ?? [], loginURL: entry.loginURL,
          timeoutMS: name === 'watch' ? 300000 : entry.timeoutMS, backgroundBeforeNavigation: read,
          codeEnabled: name !== 'probe', readOnlyCode: ['read', 'discover', 'capture', 'collect_page', 'watch'].includes(name),
          downloadEnabled: ['read', 'capture', 'collect_page'].includes(name),
          awaitedRead: ['gmail', 'qq_mail'].includes(provider) && ['read', 'discover', 'capture', 'collect_page', 'watch'].includes(name),
          effectSelectors: [entry.effectSelector, ...entry.effectSelectors ?? []].filter(Boolean),
          deniedURLs: provider === 'outlook' ? [{origin: 'https://www.microsoft.com',
            path: '^/[a-z]{2}-[a-z]{2}/microsoft-365/outlook/email-and-calendar-software-microsoft-outlook/?$', query: {deeplink: '/mail/'}}] : [],
          beforeNavigationAssets: read && provider === 'outlook' ? ['assets/mail/outlook-before-navigation.js'] : [],
          ...(shared ? {hook: {module: 'applications/mail/runtime/mail-observer-runtime.cjs', provider,
            origins: entry.origins.filter(origin => !/login|accounts|www\.microsoft/u.test(origin))}} : {})}}}];
  }));
  await write(`bindings/${manifest.id}.json`, {version: '1.0', application: {group: 'mail', provider}, manifest, manifest_digest: digest(manifest), commands});
}
const projection = providerScriptContract();
for (const entry of projection.scripts) {
  entry.app = `mail-${entry.provider.replace('_', '-')}`;
  entry.command = entry.operation === 'observe' ? 'watch' : entry.operation;
}
await write('bindings/provider-scripts.json', projection);
