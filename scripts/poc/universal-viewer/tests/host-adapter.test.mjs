import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import JSZip from 'jszip';
import { JSDOM } from 'jsdom';

import { createViewerHostAdapter } from '../host-adapter.mjs';
import { generateDocxFixture, generatePptxFixture } from '../office-closure-smoke.mjs';

const HERE = path.resolve(import.meta.dirname, '..');
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'handle-input.json'), 'utf8'));
const FORBIDDEN_SURFACE = ['save', 'write', 'pickFile', 'share', 'fetch', 'spawn', 'openExternal', 'path'];

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://viewer.invalid/',
    pretendToBeVisual: true
  });
  const names = [
    'window', 'document', 'navigator', 'Node', 'Text', 'Element', 'HTMLElement', 'HTMLCanvasElement',
    'SVGElement', 'ShadowRoot', 'Document', 'DocumentFragment', 'DOMParser', 'XMLSerializer',
    'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'
  ];
  for (const name of names) {
    const value = name === 'window' ? dom.window : dom.window[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
  // docx-preview schedules DOM work after its render promise settles. This
  // test file runs in an isolated Node test process, so keep the synthetic DOM
  // alive until process exit while the adapter still removes its own container.
  return () => undefined;
}

function clone(value) {
  return structuredClone(value);
}

function validHandle(bytes) {
  const handle = clone(FIXTURE.handle);
  handle.declared_byte_length = bytes.byteLength;
  return handle;
}

function createAdapter(options = {}) {
  return createViewerHostAdapter({
    trusted_context: clone(FIXTURE.trusted_context),
    now: () => Date.parse(FIXTURE.trusted_context.now),
    ...options
  });
}

function snapshot(bytes) {
  return Buffer.from(bytes).toString('hex');
}

async function zipWith(entries) {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) zip.file(name, value, { createFolders: false });
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

test('opens representative DOCX and PPTX bytes through verified audience-bound handles', async () => {
  const restore = installDom();
  try {
    const adapter = createAdapter();
    for (const property of FORBIDDEN_SURFACE) assert.equal(property in adapter, false, property);
    assert.deepEqual(
      Object.keys(adapter).sort(),
      ['createEphemeralAssetUrl', 'isCancelled', 'open', 'readAll', 'readRange', 'reportDiagnostic', 'revokeEphemeralAssetUrl'].sort()
    );

    const docx = await generateDocxFixture();
    const pptx = await generatePptxFixture();
    const docxBefore = snapshot(docx);
    const pptxBefore = snapshot(pptx);
    const docxResult = await adapter.open({
      handle: validHandle(docx), bytes: docx, descriptor_id: 'viewer.office.docx'
    });
    const pptxResult = await adapter.open({
      handle: validHandle(pptx), bytes: pptx, descriptor_id: 'viewer.office.pptx'
    });

    assert.equal(docxResult.detected.format, 'docx');
    assert.equal(docxResult.document_model.state, 'ready');
    assert.match(docxResult.document_model.text.join(' '), /Universal Viewer DOCX Smoke/);
    assert.equal(pptxResult.detected.format, 'pptx');
    assert.equal(pptxResult.document_model.state, 'ready');
    assert.equal(pptxResult.document_model.slides.length, 1);
    assert.match(pptxResult.document_model.slides[0].text.join(' '), /Universal Viewer PPTX Smoke/);
    assert.equal(snapshot(docx), docxBefore);
    assert.equal(snapshot(pptx), pptxBefore);
  } finally {
    restore();
  }
});

test('rejects unverified, wrong-audience, wrong-operation, wrong-revision, expired, and wrong-size handles before parser dispatch', async () => {
  const bytes = await generatePptxFixture();
  const mutations = [
    ['unverified', (handle) => { handle.verification_state = 'caller_claimed'; }, 'VIEWER_HANDLE_NOT_PREVERIFIED'],
    ['audience', (handle) => { handle.audience.id = 'another-worker'; }, 'VIEWER_HANDLE_AUDIENCE_MISMATCH'],
    ['operation', (handle) => { handle.allowed_operations = ['inspect']; }, 'VIEWER_HANDLE_OPERATION_DENIED'],
    ['write capability', (handle) => { handle.allowed_operations.push('write_staging'); }, 'VIEWER_HANDLE_OPERATION_DENIED'],
    ['revision', (handle) => { handle.resource_revision = 'revision-other'; }, 'VIEWER_HANDLE_REVISION_MISMATCH'],
    ['expiry', (handle) => { handle.expires_at = '2026-09-04T11:59:59.000Z'; }, 'VIEWER_HANDLE_EXPIRED'],
    ['size', (handle) => { handle.declared_byte_length += 1; }, 'VIEWER_HANDLE_SIZE_MISMATCH']
  ];

  for (const [name, mutate, code] of mutations) {
    const handle = validHandle(bytes);
    mutate(handle);
    const adapter = createAdapter();
    await assert.rejects(
      adapter.open({ handle, bytes, descriptor_id: 'viewer.office.pptx' }),
      (error) => error.code === code && error.parser_dispatches === 0,
      name
    );
  }
});

test('keeps input bytes unchanged after cancellation, parser failure, and limit rejection', async () => {
  const malformedPptx = await zipWith({
    '[Content_Types].xml': '<Types/>',
    'ppt/broken.xml': '<broken>'
  });
  const malformedBefore = snapshot(malformedPptx);
  const parserFailure = await createAdapter().open({
    handle: validHandle(malformedPptx),
    bytes: malformedPptx,
    descriptor_id: 'viewer.office.pptx'
  });
  assert.equal(parserFailure.document_model.state, 'corrupt');
  assert.equal(snapshot(malformedPptx), malformedBefore);

  const pptx = await generatePptxFixture();
  const pptxBefore = snapshot(pptx);
  const cancelled = await createAdapter().open({
    handle: validHandle(pptx),
    bytes: pptx,
    descriptor_id: 'viewer.office.pptx',
    signal: { aborted: true }
  });
  assert.equal(cancelled.document_model.state, 'cancelled');
  assert.equal(snapshot(pptx), pptxBefore);

  const tooLarge = await createAdapter().open({
    handle: validHandle(pptx),
    bytes: pptx,
    descriptor_id: 'viewer.office.pptx',
    limits: { max_input_bytes: pptx.byteLength - 1 }
  });
  assert.equal(tooLarge.document_model.state, 'too_large');
  assert.equal(tooLarge.metrics.parser_dispatches, 0);
  assert.equal(snapshot(pptx), pptxBefore);
});

test('marks an unknown OOXML relationship partial with a scoped diagnostic', async () => {
  const zip = await JSZip.loadAsync(await generatePptxFixture());
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdUnknown" Type="https://example.invalid/relationships/unknown-widget" Target="../widgets/widget1.xml"/></Relationships>'
  );
  zip.file('ppt/widgets/widget1.xml', '<widget/>');
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const result = await createAdapter().open({
    handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.pptx'
  });

  assert.equal(result.document_model.state, 'partial');
  assert.ok(result.diagnostics.some((diagnostic) =>
    diagnostic.code === 'VIEWER_OOXML_RELATIONSHIP_UNKNOWN'
      && diagnostic.forces_partial === true
      && diagnostic.scope?.element_id === 'relationship-rIdUnknown'
  ));
});

test('does not dispatch an Office parser for an unrecognized or ambiguous ZIP container', async () => {
  const bytes = await zipWith({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': '<document/>',
    'ppt/presentation.xml': '<presentation/>'
  });
  const result = await createAdapter().open({
    handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.docx'
  });

  assert.equal(result.document_model.state, 'corrupt');
  assert.equal(result.metrics.parser_dispatches, 0);
  assert.ok(result.diagnostics.some((item) => item.code === 'VIEWER_CONTAINER_AMBIGUOUS'));
});

test('revokes every ephemeral asset URL when cancellation happens after inventory', async () => {
  const zip = await JSZip.loadAsync(await generateDocxFixture());
  zip.file('word/media/image1.png', new Uint8Array([137, 80, 78, 71]));
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  let cancelled = false;
  const signal = {
    get aborted() {
      return cancelled;
    }
  };
  const adapter = createAdapter({
    create_asset_url: () => {
      cancelled = true;
      return 'blob:test-cancelled-asset';
    }
  });
  const result = await adapter.open({
    handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.docx', signal
  });

  assert.equal(result.document_model.state, 'cancelled');
  assert.ok(result.metrics.ephemeral_asset_urls_created > 0);
  assert.equal(result.metrics.ephemeral_asset_urls_revoked, result.metrics.ephemeral_asset_urls_created);
});

test('truncates diagnostic, text, and model arrays with a visible limit diagnostic', async () => {
  const zip = await JSZip.loadAsync(await generateDocxFixture());
  zip.file(
    'word/_rels/document.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + Array.from({ length: 6 }, (_, index) => `<Relationship Id="rIdUnknown${index}" Type="https://example.invalid/relationships/unknown-${index}" Target="unknown-${index}.xml"/>`).join('')
      + '</Relationships>'
  );
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + ['one', 'two', 'three'].map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')
      + '</w:body></w:document>'
  );
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const restore = installDom();
  try {
    const result = await createAdapter().open({
      handle: validHandle(bytes),
      bytes,
      descriptor_id: 'viewer.office.docx',
      limits: { max_diagnostics: 3, max_text_items: 1, max_model_items: 1 }
    });

    assert.ok(result.diagnostics.length <= 3);
    assert.ok(result.document_model.text.length <= 1);
    assert.ok(result.document_model.blocks.length <= 1);
    assert.ok(result.diagnostics.some((item) => item.code === 'VIEWER_OUTPUT_TRUNCATED'));
    assert.equal(result.metrics.output_truncated, true);
  } finally {
    restore();
  }
});
