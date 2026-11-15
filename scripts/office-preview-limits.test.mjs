import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const requireUI = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const { Window } = requireUI('happy-dom');
const JSZip = requireUI('jszip');
const { mountWordViewer } = await import(requireUI.resolve('omni-viewer-core/viewers/word'));
const { loadWordViewerDeps } = await import(requireUI.resolve('omni-viewer-core/viewers/word/self-loading'));
const dependencies = await loadWordViewerDeps({ embeddedSheets: false });
const context = {
  assets: { resolveAssetUrl: async path => path },
  i18n: { t: key => key },
  logger: { log() {} },
};
const paragraph = 'The document survived the Word input-size boundary.';
const window = new Window();
const savedGlobals = new Map();

before(() => {
  const timers = ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'];
  for (const name of ['window', 'document', 'DOMParser', 'XMLSerializer', 'Node', 'HTMLElement', ...timers]) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value = timers.includes(name) ? window[name].bind(window) : window[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(async () => {
  await window.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

async function docx(paddingBytes = 0) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="bin" ContentType="application/octet-stream"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.file('word/document.xml', `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>
        <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
      </w:body>
    </w:document>`);
  // A stored package part makes the actual ZIP input exceed 50 MiB without
  // multiplying document pages or exercising a compression bomb.
  if (paddingBytes) zip.file('customXml/payload.bin', new Uint8Array(paddingBytes));
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

async function inspectMount(data, limits, inspect) {
  const container = document.createElement('div');
  document.body.append(container);
  const handle = await mountWordViewer(
    { fileName: 'input.docx', data }, container, context, dependencies,
    { styleIsolation: 'scoped', limits },
  );
  try { inspect(handle); }
  finally { handle.dispose(); container.remove(); }
}

function assertFailed(handle, code) {
  assert.equal(handle.status.state, 'failed', handle.status.error?.message);
  assert.equal(handle.status.failure.code, code);
  assert.equal(handle.contentElement.querySelector('.docx-wrapper'), null);
}

function assertRendered(handle) {
  assert.equal(handle.status.state, 'ready', handle.status.error?.message);
  assert.equal(handle.status.renderer, 'core');
  assert.ok(handle.contentElement.textContent.includes(paragraph));
  assert.equal(handle.contentElement.querySelectorAll('.docx-wrapper > section').length, 1);
}

test('ordinary DOCX still renders through the actual self-loaded parser and renderer', async () => {
  await inspectMount(await docx(), undefined, assertRendered);
});

test('only explicit Infinity permits a valid DOCX above the default 50 MiB input bound', async t => {
  const data = await docx(50 * 1024 * 1024 + 1);
  assert.ok(data.byteLength > 50 * 1024 * 1024);
  for (const [name, limits] of [
    ['default', undefined],
    ['larger finite value remains clamped', { maxInputBytes: 100 * 1024 * 1024 }],
    ['NaN keeps the default', { maxInputBytes: NaN }],
    ['negative Infinity keeps the default', { maxInputBytes: -Infinity }],
  ]) {
    await t.test(name, () => inspectMount(data, limits, handle => assertFailed(handle, 'limit-exceeded')));
  }
  await t.test('Infinity renders the actual package', () => inspectMount(data, { maxInputBytes: Infinity }, assertRendered));
});

test('a finite host limit still rejects input above it and accepts the exact byte count', async () => {
  const data = await docx();
  await inspectMount(data, { maxInputBytes: data.byteLength - 1 }, handle => assertFailed(handle, 'limit-exceeded'));
  await inspectMount(data, { maxInputBytes: data.byteLength }, assertRendered);
});

test('input opt-out retains invalid-format, encryption and malformed-ZIP failures', async t => {
  const encrypted = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.from('EncryptedPackage', 'utf16le'),
  ]);
  for (const [name, data, code] of [
    ['non-ZIP', new Uint8Array([1, 2, 3, 4]), 'invalid-format'],
    ['encrypted OOXML', encrypted, 'password-required'],
    ['truncated ZIP', new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Uint8Array(32)]), 'decompression-limit'],
  ]) {
    await t.test(name, () => inspectMount(data, { maxInputBytes: Infinity }, handle => assertFailed(handle, code)));
  }
});

test('input opt-out retains the default decompression guard even when its limit receives Infinity', async () => {
  const data = await docx();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const centralDirectory = view.getUint32(data.byteLength - 22 + 16, true);
  assert.equal(view.getUint32(centralDirectory, true), 0x02014b50);
  view.setUint32(centralDirectory + 24, 1024 * 1024 * 1024 + 1, true);
  for (const limits of [{ maxInputBytes: Infinity }, { maxInputBytes: Infinity, maxDecompressedBytes: Infinity }]) {
    await inspectMount(data, limits, handle => assertFailed(handle, 'decompression-limit'));
  }
});

test('input opt-out retains the separately tightened page limit', async () => {
  await inspectMount(await docx(), { maxInputBytes: Infinity, maxPages: 0 }, handle => {
    assert.equal(handle.status.state, 'partial', handle.status.error?.message);
    assert.equal(handle.contentElement.querySelectorAll('.docx-wrapper > section').length, 0);
    assert.ok(handle.status.diagnostics.some(item => item.messageKey === 'diag.word.page-limit'));
  });
});
