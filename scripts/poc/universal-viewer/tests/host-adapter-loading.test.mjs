import assert from 'node:assert/strict';
import test from 'node:test';

import { createViewerHostAdapter } from '../host-adapter.mjs';

const TRUSTED_CONTEXT = Object.freeze({
  audience: Object.freeze({ kind: 'worker', id: 'viewer-worker-test' }),
  operation: 'read',
  expected_revision: 'revision-test',
});

function input(bytes, overrides = {}) {
  return {
    bytes,
    descriptor_id: 'viewer.office.docx',
    handle: {
      verification_state: 'verified_by_test_core',
      resource_type: 'viewer_input',
      audience: { kind: 'worker', id: 'viewer-worker-test' },
      allowed_operations: ['read', 'range_read'],
      resource_revision: 'revision-test',
      expires_at: '2030-01-01T00:00:00.000Z',
      declared_byte_length: bytes.byteLength,
      size_limit_bytes: bytes.byteLength,
      range_limit_bytes: Math.max(1, bytes.byteLength),
      ...overrides,
    },
  };
}

test('host adapter validates and handles pre-parse exits without eagerly loading generated bundles', async () => {
  const adapter = createViewerHostAdapter({
    trusted_context: TRUSTED_CONTEXT,
    now: () => Date.parse('2026-09-04T00:00:00.000Z'),
  });

  const invalid = input(new Uint8Array([1]), { verification_state: 'caller_claimed' });
  await assert.rejects(adapter.open(invalid), (error) => error.code === 'VIEWER_HANDLE_NOT_PREVERIFIED');

  const controller = new AbortController();
  controller.abort();
  const cancelled = await adapter.open({ ...input(new Uint8Array([1])), signal: controller.signal });
  assert.equal(cancelled.document_model.state, 'cancelled');

  const oversizedBytes = new Uint8Array(4_097);
  const oversized = await adapter.open({
    ...input(oversizedBytes),
    limits: { max_input_bytes: 4_096 },
  });
  assert.equal(oversized.document_model.state, 'too_large');
  assert.ok(oversized.diagnostics.some(({ code }) => code === 'VIEWER_LIMIT_INPUT_BYTES'));
});
