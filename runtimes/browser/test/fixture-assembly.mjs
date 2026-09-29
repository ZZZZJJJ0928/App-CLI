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
  ]};
export const binding = {version: '1.0', manifest, manifest_digest: digest(manifest), commands: {
  increment: {handler: 'increment', resource: 'counter'}, watch: {handler: 'watch', resource: 'watch', renewable: true},
}};
export async function assemble({config}) {
  return {bindings: [binding], handlers: {
    increment: {
      async run(args, context) {
        const file = path.join(config.state_directory, context.task_id + '.effect');
        context.beforeEffect();
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
    watch: {async run(args, context) {
      for (;;) {context.emit('tick', {}); await delay(args.wait_ms ?? 25, undefined, {signal: context.signal});}
    }},
  }};
}
