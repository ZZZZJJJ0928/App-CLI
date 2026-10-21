import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {ProductClient} from '../src/product-client.mjs';

function fixture(t, count, sealed = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-cli-maintenance-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const product = Object.create(ProductClient.prototype);
  product.index = root; product.config = {grants_directory: root, owner_id: 'fixture-owner'};
  product.epochState = {generation: 1, sealed_through: sealed};
  product.authorization = {remove() {assert.fail('no grant slot is eligible');}};
  for (let index = 0; index < count; index++) fs.writeFileSync(path.join(root, `${index}.head.json`), JSON.stringify({
    request: {request_key: `op3.1.1.${index.toString(16).padStart(32, '0')}`},
    current: '00000000-0000-0000-0000-000000000000', previous: null, candidate: null,
  }), {mode: 0o600});
  return product;
}

test('maintenance yields for live heads even when the removal limit is never reached', async t => {
  const product = fixture(t, 160);
  let turns = 0, active = true;
  const tick = () => {if (active) {turns++; setImmediate(tick);}};
  setImmediate(tick);
  try {
    const first = product.prune({limit: 1}), second = product.prune({limit: 1});
    assert.equal(first, second, 'overlapping maintenance joins the same scan');
    assert.equal(await first, 0);
    assert.ok(turns >= 5, `event loop turns during scan: ${turns}`);
    assert.equal(fs.readdirSync(product.index).length, 160, 'unsealed heads remain');
  } finally {active = false;}
});

test('streamed maintenance still caps reclamation and closes the directory between scans', async t => {
  const product = fixture(t, 45, 1);
  assert.equal(await product.prune({limit: 10}), 10);
  assert.equal(fs.readdirSync(product.index).length, 35);
  assert.equal(await product.prune({limit: 10}), 10);
  assert.equal(fs.readdirSync(product.index).length, 25);
  assert.equal(await product.prune(), 25);
  assert.equal(fs.readdirSync(product.index).length, 0);
});
