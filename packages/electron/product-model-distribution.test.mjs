import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadPackagedProductModelOrigin, stageProductModelOrigin } from './product-model-distribution.mjs';

function fixture(t) {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'product-model-distribution-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  return resourcesPath;
}

test('ships only the HTTPS origin and reads it only in a packaged app', (t) => {
  const resourcesPath = fixture(t);
  stageProductModelOrigin(resourcesPath, 'https://product-proxy.example/');
  assert.equal(loadPackagedProductModelOrigin(true, resourcesPath), 'https://product-proxy.example');
  assert.equal(loadPackagedProductModelOrigin(false, resourcesPath), undefined);
  stageProductModelOrigin(resourcesPath, '');
  assert.equal(loadPackagedProductModelOrigin(true, resourcesPath), undefined);
});

test('rejects unsafe build inputs and malformed installed metadata', (t) => {
  const resourcesPath = fixture(t);
  for (const value of ['http://127.0.0.1', 'https://name:secret@proxy.example', 'https://proxy.example/submit', 'https://proxy.example/?next=1', 'https://proxy.example/#part']) {
    assert.throws(() => stageProductModelOrigin(resourcesPath, value), /product_model_origin_invalid/);
  }
  fs.writeFileSync(path.join(resourcesPath, 'product-model-origin.json'), '{"origin":"https://proxy.example","unexpected":1}');
  assert.throws(() => loadPackagedProductModelOrigin(true, resourcesPath), /product_model_origin_invalid/);
});
