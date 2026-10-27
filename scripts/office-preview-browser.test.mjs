import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build, loadConfigFromFile } from 'vite';

const requireUI = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const docParser = requireUI.resolve('omni-viewer-core/parsers/doc-binary');
const pptParser = requireUI.resolve('omni-viewer-core/parsers/ppt-binary');
const paragraph = 'Browser Buffer legacy office fixture supports a meaningful paragraph with decoded bytes.';

// One regular CFB stream, with a FAT sector and directory. Both legacy Office
// readers must decode its actual bytes; no Node Buffer enters the fixture.
function compoundFile(streamName, text, isWord) {
  const bytes = new Uint8Array(2048);
  const view = new DataView(bytes.buffer);
  const utf16 = (offset, value) => {
    for (let index = 0; index < value.length; index++) view.setUint16(offset + index * 2, value.charCodeAt(index), true);
  };
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, 1, true);
  view.setInt32(48, 1, true);
  view.setUint32(56, 0, true);
  view.setInt32(60, -2, true);
  view.setInt32(68, -2, true);
  bytes.fill(255, 76, 1024);
  view.setInt32(76, 0, true);
  view.setInt32(512, -3, true);
  view.setInt32(516, -2, true);
  view.setInt32(520, -2, true);
  const entry = (offset, name, type, sector, size) => {
    utf16(offset, `${name}\0`);
    view.setUint16(offset + 64, (name.length + 1) * 2, true);
    view.setUint8(offset + 66, type);
    for (const field of [68, 72, 76]) view.setInt32(offset + field, -1, true);
    view.setInt32(offset + 116, sector, true);
    view.setUint32(offset + 120, size, true);
  };
  entry(1024, 'Root Entry', 5, -2, 0);
  entry(1152, streamName, 2, 2, isWord ? 256 : text.length * 2);
  utf16(1536 + (isWord ? 64 : 0), text);
  return bytes;
}

const fixture = `
import { DocBinaryParser } from ${JSON.stringify(docParser)};
import { parsePptBinaryVscode } from ${JSON.stringify(pptParser)};
const compoundFile = ${compoundFile.toString()};
export async function decode() {
  const text = ${JSON.stringify(paragraph)};
  const html = await DocBinaryParser.parseBytes(compoundFile('WordDocument', text, true));
  const ppt = await parsePptBinaryVscode(compoundFile('PowerPoint Document', text, false));
  return { html, ppt: ppt.result, globalBuffer: typeof globalThis.Buffer };
}
`;

for (const surface of ['web', 'vscode']) {
  test(`${surface} browser build decodes legacy Word and PowerPoint without a global Buffer`, async () => {
    const configFile = fileURLToPath(new URL(`../packages/${surface}/vite.config.ts`, import.meta.url));
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, configFile);
    assert.ok(loaded, 'Load the actual surface build configuration');
    const entry = fileURLToPath(new URL('./office-preview-fixture.mjs', import.meta.url));
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      resolve: loaded.config.resolve,
      define: loaded.config.define,
      plugins: [{ name: 'office-preview-fixture', resolveId: id => id === entry ? entry : undefined, load: id => id === entry ? fixture : undefined }],
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'OfficePreviewFixture' } },
    });
    const [bundle] = Array.isArray(result) ? result : [result];
    const script = bundle.output.find(output => output.type === 'chunk' && output.isEntry);
    assert.ok(script, 'Produce a browser entry bundle');
    const decoded = await runInNewContext(`${script.code}\nOfficePreviewFixture.decode()`, { TextDecoder, TextEncoder });
    assert.equal(decoded.globalBuffer, 'undefined');
    assert.ok(decoded.html.includes(`<p>${paragraph}</p>`));
    assert.equal(decoded.ppt.status, 'ok');
    assert.equal(decoded.ppt.document.totalSlides, 1);
    assert.equal(decoded.ppt.document.slides[0].elements[0].paragraphs[0].text, paragraph);
  });
}
