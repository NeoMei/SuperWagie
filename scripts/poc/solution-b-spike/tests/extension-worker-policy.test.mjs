import assert from 'node:assert/strict';
import test from 'node:test';
import { isExactDocumentUrl, validateExtensionManifest } from '../src/extension-worker-policy.mjs';

const validManifest = () => ({
  id: 'task5.fixture.skill',
  type: 'skill',
  version: '1.0.0',
  permissions: ['artifact.read_metadata'],
  network: [],
});

test('extension manifest requires the exact closed permission schema', () => {
  assert.doesNotThrow(() => validateExtensionManifest(validManifest(), '1.0.0'));
  for (const manifest of [
    { ...validManifest(), permissions: [] },
    { ...validManifest(), permissions: ['artifact.read_metadata', 'artifact.read_metadata'] },
    { ...validManifest(), network: ['https://example.invalid'] },
    { ...validManifest(), extra: true },
    { ...validManifest(), version: '1.0.1' },
  ]) assert.throws(() => validateExtensionManifest(manifest, '1.0.0'), /INSTALL_MANIFEST_REJECTED/);
  assert.throws(() => validateExtensionManifest(validManifest(), '../1.0.0'), /INSTALL_MANIFEST_REJECTED/);
});

test('extension IPC and network policy accepts only the exact worker document', () => {
  const expected = 'file:///C:/runtime/src/static/extension-worker.html';
  assert.equal(isExactDocumentUrl(`${expected}?extensionId=task5.fixture.skill#ready`, expected), true);
  assert.equal(isExactDocumentUrl(`${expected}.attacker`, expected), false);
  assert.equal(isExactDocumentUrl('https://example.invalid/extension-worker.html', expected), false);
  assert.equal(isExactDocumentUrl('not a url', expected), false);
});
