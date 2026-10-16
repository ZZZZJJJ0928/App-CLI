import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {digest} from '../src/protocol.mjs';

const input = {type: 'object', properties: {wait_ms: {type: 'integer', minimum: 0, maximum: 10000}}, additionalProperties: false};
export const manifest = {schema_version: '1.0', id: 'local-fixture', name: 'Local fixture', version: '1.0.0', platforms: ['linux'],
  adapter: {kind: 'runtime', name: 'Self-owned lifecycle fixture'}, commands: [
    {name: 'increment', description: 'Increment a self-owned counter.', side_effect: 'local_mutation', input_schema: input,
      output_schema: {type: 'object', properties: {value: {type: 'integer'}}, required: ['value'], additionalProperties: false}},
    {name: 'watch', description: 'Observe a self-owned periodic fixture.', side_effect: 'read_only', input_schema: input,
      output_schema: {type: 'object'}},
    {name: 'send', description: 'Deliver a self-owned message once.', side_effect: 'remote_mutation', input_schema: input,
      output_schema: {type: 'object', properties: {sent: {type: 'integer'}}, required: ['sent'], additionalProperties: false}},
  ]};
export const binding = {version: '1.0', manifest, manifest_digest: digest(manifest), commands: {
  increment: {handler: 'increment', resource: 'counter'}, watch: {handler: 'watch', resource: 'watch', renewable: true},
  send: {handler: 'send', resource: 'outbox'},
}};
// Test-visible fake provider: counts every actual delivery and lets a test
// pause or crash at each step of the dispatch critical section.
export const provider = {deliveries: [], hooks: {}};
export async function assemble({config}) {
  return {bindings: [binding], handlers: {
    increment: {
      async run(args, context) {
        const file = path.join(config.state_directory, context.task_id + '.effect');
        await context.beforeEffect();
        fs.writeFileSync(file, '1', {flag: 'wx', mode: 0o600});
        const fd = fs.openSync(file, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
        await delay(args.wait_ms ?? 0, undefined, {signal: context.signal});
        return {data: {value: 1}};
      },
      async reconcile(args, context) {
        const value = Number(fs.readFileSync(path.join(config.state_directory, context.task_id + '.effect'), 'utf8'));
        return {data: {value}};
      },
    },
    send: {
      async run(args, context) {
        await provider.hooks.beforeReserve?.(context);
        context.reserveDispatch();
        await provider.hooks.beforeRelease?.(context);
        await context.releaseDispatch();
        await provider.hooks.afterRelease?.(context);
        provider.deliveries.push(context.task_id);
        await provider.hooks.afterDelivery?.(context);
        await delay(args.wait_ms ?? 0, undefined, {signal: context.signal});
        return {data: {sent: provider.deliveries.filter(id => id === context.task_id).length}};
      },
      async reconcile(args, context) {
        const sent = provider.deliveries.filter(id => id === context.task_id).length;
        return sent ? {data: {sent}} : {status: 'uncertain', reason: 'SEND_OUTCOME_UNKNOWN'};
      },
    },
    watch: {async run(args, context) {
      for (;;) {context.emit('tick', {}); await delay(args.wait_ms ?? 25, undefined, {signal: context.signal});}
    }},
  }};
}
