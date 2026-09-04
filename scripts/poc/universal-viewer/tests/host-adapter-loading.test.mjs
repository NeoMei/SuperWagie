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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('host adapter snapshots validated bytes before deferred chunk loading and rechecks cancellation', async () => {
  const loading = deferred();
  let observedHeader;
  const adapter = createViewerHostAdapter({
    trusted_context: TRUSTED_CONTEXT,
    now: () => Date.parse('2026-09-04T00:00:00.000Z'),
    load_base_core: async () => loading.promise,
    load_office_core: async () => ({}),
  });
  const originalBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const request = input(originalBytes);
  const opened = adapter.open(request);
  originalBytes.fill(0);
  request.bytes = new Uint8Array(4_097);
  request.handle.declared_byte_length = 4_097;
  request.handle.size_limit_bytes = 4_097;
  request.handle.range_limit_bytes = 4_097;
  loading.resolve({
    sniffContainer(header) {
      observedHeader = [...header];
      return null;
    },
  });
  const result = await opened;
  assert.deepEqual(observedHeader, [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(result.metrics.input_bytes, 4);

  const cancellationLoad = deferred();
  const cancellationAdapter = createViewerHostAdapter({
    trusted_context: TRUSTED_CONTEXT,
    now: () => Date.parse('2026-09-04T00:00:00.000Z'),
    load_base_core: async () => cancellationLoad.promise,
    load_office_core: async () => ({}),
  });
  const controller = new AbortController();
  const cancellation = cancellationAdapter.open({ ...input(new Uint8Array([1])), signal: controller.signal });
  controller.abort();
  cancellationLoad.resolve({ sniffContainer: () => null });
  assert.equal((await cancellation).document_model.state, 'cancelled');
});

test('chunk load failures are sanitized, shared by concurrent callers, and retryable', async () => {
  let baseAttempts = 0;
  let firstFailure;
  const adapter = createViewerHostAdapter({
    trusted_context: TRUSTED_CONTEXT,
    now: () => Date.parse('2026-09-04T00:00:00.000Z'),
    load_base_core: async () => {
      baseAttempts += 1;
      if (baseAttempts === 1) {
        firstFailure ??= deferred();
        return firstFailure.promise;
      }
      return { sniffContainer: () => null };
    },
    load_office_core: async () => ({}),
  });
  const first = adapter.open(input(new Uint8Array([1])));
  const concurrent = adapter.open(input(new Uint8Array([1])));
  firstFailure.reject(new Error('/Users/private/worktree/dist/viewer-base.mjs is missing'));
  for (const result of await Promise.all([first, concurrent])) {
    assert.equal(result.document_model.state, 'corrupt');
    assert.deepEqual(result.diagnostics.map(({ code }) => code), ['VIEWER_CHUNK_LOAD_FAILED']);
    assert.doesNotMatch(JSON.stringify(result), /Users\/private|worktree|viewer-base\.mjs/u);
  }
  assert.equal(baseAttempts, 1);

  const retried = await adapter.open(input(new Uint8Array([1])));
  assert.equal(baseAttempts, 2);
  assert.equal(retried.document_model.state, 'corrupt');
  assert.deepEqual(retried.diagnostics.map(({ code }) => code), ['VIEWER_CONTAINER_UNRECOGNIZED']);
});
