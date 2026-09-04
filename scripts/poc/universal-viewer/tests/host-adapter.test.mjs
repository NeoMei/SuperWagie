import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import JSZip from 'jszip';
import { JSDOM } from 'jsdom';

import * as generatedOfficeCore from '../dist/viewer-office/viewer-office.mjs';
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
    ['size', (handle) => { handle.declared_byte_length += 1; }, 'VIEWER_HANDLE_SIZE_MISMATCH'],
    ['missing range limit', (handle) => { delete handle.range_limit_bytes; }, 'VIEWER_HANDLE_RANGE_LIMIT_INVALID'],
    ['zero range limit', (handle) => { handle.range_limit_bytes = 0; }, 'VIEWER_HANDLE_RANGE_LIMIT_INVALID'],
    ['fractional range limit', (handle) => { handle.range_limit_bytes = 1.5; }, 'VIEWER_HANDLE_RANGE_LIMIT_INVALID'],
    ['unsafe range limit', (handle) => { handle.range_limit_bytes = Number.MAX_SAFE_INTEGER + 1; }, 'VIEWER_HANDLE_RANGE_LIMIT_INVALID']
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

test('forwards AbortSignal and tightened applicable limits into the DOCX Core mount', async () => {
  const restore = installDom();
  const controller = new AbortController();
  let receivedOptions;
  const officeCore = {
    ...generatedOfficeCore,
    async mountBundledWordViewer(input, container, context, options) {
      receivedOptions = options;
      return generatedOfficeCore.mountBundledWordViewer(input, container, context, options);
    }
  };
  try {
    const bytes = await generateDocxFixture();
    const result = await createAdapter({ office_core: officeCore }).open({
      handle: validHandle(bytes),
      bytes,
      descriptor_id: 'viewer.office.docx',
      signal: controller.signal,
      limits: {
        max_input_bytes: 4_096,
        max_total_uncompressed_bytes: 4_096,
        max_entry_uncompressed_bytes: 2_048,
        max_archive_entries: 16,
        max_pages: 1
      }
    });

    assert.equal(result.document_model.state, 'ready');
    assert.equal(receivedOptions.signal, controller.signal);
    assert.deepEqual(receivedOptions.limits, {
      maxInputBytes: 4_096,
      maxDecompressedBytes: 4_096,
      maxPages: 1,
      maxImageBytes: 2_048,
      maxEmbeddedFiles: 16
    });
  } finally {
    restore();
  }
});

test('surfaces the real DOCX AlternateContent chart fallback diagnostic as scoped partial', async () => {
  const restore = installDom();
  try {
    const zip = await JSZip.loadAsync(await generateDocxFixture());
    zip.file(
      'word/document.xml',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        + 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
        + 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" '
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>'
        + '<mc:AlternateContent><mc:Choice Requires="c"><w:drawing><c:chart r:id="rChart1"/></w:drawing></mc:Choice>'
        + '<mc:Fallback><w:p><w:r><w:t>Visible chart fallback</w:t></w:r></w:p></mc:Fallback>'
        + '</mc:AlternateContent></w:body></w:document>'
    );
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
    const result = await createAdapter().open({
      handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.docx'
    });

    assert.equal(result.document_model.state, 'partial');
    assert.match(result.document_model.text.join(' '), /Visible chart fallback/);
    assert.ok(result.diagnostics.some((item) =>
      item.code === 'VIEWER_CHART_FALLBACK_USED'
        && item.forces_partial === true
        && item.scope?.element_id === 'core-word-document.xml'
    ));
  } finally {
    restore();
  }
});

test('bounds Core DOCX diagnostic transfer without iterating an attacker-sized diagnostic array', async () => {
  const restore = installDom();
  let diagnosticReads = 0;
  const coreDiagnostics = new Proxy(new Array(1_000), {
    get(target, property, receiver) {
      if (/^\d+$/.test(String(property))) {
        diagnosticReads += 1;
        if (diagnosticReads > 3) throw new Error('Core diagnostics traversal exceeded limit plus one');
        return { severity: 'warning', code: `core-warning-${property}`, location: `word/${'x'.repeat(10_000)}-${property}.xml` };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const officeCore = {
    ...generatedOfficeCore,
    async mountBundledWordViewer(input, container) {
      const paragraph = document.createElement('p');
      paragraph.textContent = 'bounded diagnostics';
      container.append(paragraph);
      return {
        status: { state: 'partial', format: 'docx', renderer: 'core', diagnostics: coreDiagnostics },
        dispose() {}
      };
    }
  };
  try {
    const bytes = await generateDocxFixture();
    const result = await createAdapter({ office_core: officeCore }).open({
      handle: validHandle(bytes),
      bytes,
      descriptor_id: 'viewer.office.docx',
      limits: { max_diagnostics: 2 }
    });

    assert.equal(result.document_model.state, 'partial');
    assert.ok(diagnosticReads <= 3, diagnosticReads);
    assert.ok(result.diagnostics.some((item) => item.code === 'VIEWER_OUTPUT_TRUNCATED'));
    assert.ok(result.diagnostics.every((item) => item.scope && item.forces_partial === true));
    assert.ok(result.diagnostics.every((item) => item.scope.element_id.length <= 160));
  } finally {
    restore();
  }
});

test('forwards tightened input, archive, decompression, and cooperative deadline limits into the PPTX Core parser', async () => {
  const bytes = await generatePptxFixture();
  const controller = new AbortController();
  let receivedOptions;
  const officeCore = {
    ...generatedOfficeCore,
    async parsePptxVscode(input, options) {
      receivedOptions = options;
      return generatedOfficeCore.parsePptxVscode(input, options);
    }
  };
  const result = await createAdapter({ office_core: officeCore }).open({
    handle: validHandle(bytes),
    bytes,
    descriptor_id: 'viewer.office.pptx',
    signal: controller.signal,
    limits: {
      max_input_bytes: bytes.byteLength,
      max_archive_entries: 16,
      max_total_uncompressed_bytes: 4_096,
      parse_deadline_ms: 123
    }
  });

  assert.equal(result.document_model.state, 'ready');
  assert.equal(receivedOptions.signal, controller.signal);
  assert.deepEqual(receivedOptions.limits, {
    maxInputBytes: bytes.byteLength,
    maxEntries: 16,
    maxDecompressedBytes: 4_096,
    maxParseMillis: 123
  });
});

test('returns cancelled and revokes assets when PPTX parsing aborts by throwing or after resolving', async () => {
  for (const mode of ['throw', 'resolve']) {
    const controller = new AbortController();
    const revoked = [];
    const zip = await JSZip.loadAsync(await generatePptxFixture());
    zip.file('ppt/media/image1.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
    const officeCore = {
      ...generatedOfficeCore,
      async parsePptxVscode(data, options) {
        assert.equal(options.signal, controller.signal);
        const parsed = mode === 'resolve'
          ? await generatedOfficeCore.parsePptxVscode(data, options)
          : null;
        controller.abort();
        if (mode === 'throw') throw new DOMException('cancelled in parser', 'AbortError');
        return parsed;
      }
    };
    const result = await createAdapter({
      office_core: officeCore,
      create_asset_url: () => `blob:parser-${mode}`,
      revoke_asset_url: (url) => revoked.push(url)
    }).open({
      handle: validHandle(bytes),
      bytes,
      descriptor_id: 'viewer.office.pptx',
      signal: controller.signal
    });

    assert.equal(result.document_model.state, 'cancelled', mode);
    assert.equal(result.metrics.parser_dispatches, 1, mode);
    assert.equal(result.metrics.ephemeral_asset_urls_created, 1, mode);
    assert.equal(result.metrics.ephemeral_asset_urls_revoked, 1, mode);
    assert.deepEqual(revoked, [`blob:parser-${mode}`], mode);
  }
});

test('tightened adapter-enforceable archive and XML limits reject before parser dispatch', async () => {
  const bytes = await generatePptxFixture();
  const compressedZip = await JSZip.loadAsync(bytes);
  const compressedBytes = await compressedZip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });
  const cases = [
    ['detection', { max_detection_bytes: 3 }, 'corrupt', bytes],
    ['entry bytes', { max_entry_uncompressed_bytes: 100 }, 'too_large', bytes],
    ['total bytes', { max_total_uncompressed_bytes: 100 }, 'too_large', bytes],
    ['entry count', { max_archive_entries: 2 }, 'too_large', bytes],
    ['archive depth', { max_archive_depth: 2 }, 'too_large', bytes],
    ['compression ratio', { max_compression_ratio: 1 }, 'too_large', compressedBytes],
    ['XML text', { max_xml_text_bytes: 100 }, 'too_large', bytes],
    ['XML nodes', { max_xml_nodes: 2 }, 'too_large', bytes],
    ['XML depth', { max_xml_depth: 1 }, 'too_large', bytes]
  ];
  for (const [name, limits, state, fixtureBytes] of cases) {
    const result = await createAdapter().open({
      handle: validHandle(fixtureBytes), bytes: fixtureBytes, descriptor_id: 'viewer.office.pptx', limits
    });
    assert.equal(result.document_model.state, state, name);
    assert.equal(result.metrics.parser_dispatches, 0, name);
  }
});

test('tightened page, slide, sheet, table, image, and animation limits reject before parser dispatch', async () => {
  const zip = await JSZip.loadAsync(await generateDocxFixture());
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc/><w:tc/></w:tr><w:tr><w:tc/><w:tc/></w:tr></w:tbl>'
      + '</w:body></w:document>'
  );
  zip.file('word/media/large.png', new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 0, 20, 0, 0, 0, 20, 8, 6, 0, 0, 0
  ]));
  zip.file('word/media/animated.gif', new Uint8Array([
    71, 73, 70, 56, 57, 97, 2, 0, 2, 0, 0, 0, 0, 44, 44
  ]));
  zip.file('xl/worksheets/sheet1.xml', '<worksheet/>');
  zip.file('xl/worksheets/sheet2.xml', '<worksheet/>');
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const cases = [
    ['pages', { max_pages: 1 }],
    ['sheets', { max_sheets: 1 }],
    ['table rows', { max_table_rows: 1 }],
    ['table columns', { max_table_columns: 1 }],
    ['table cells', { max_table_cells: 2 }],
    ['image width', { max_image_width_px: 10 }],
    ['image height', { max_image_height_px: 10 }],
    ['image pixels', { max_image_pixels: 100 }],
    ['animation frames', { max_animation_frames: 1 }]
  ];
  for (const [name, limits] of cases) {
    const result = await createAdapter().open({
      handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.docx', limits
    });
    assert.equal(result.document_model.state, 'too_large', name);
    assert.equal(result.metrics.parser_dispatches, 0, name);
  }

  const pptx = await JSZip.loadAsync(await generatePptxFixture());
  pptx.file('ppt/slides/slide2.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>');
  const pptxBytes = await pptx.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const slideLimit = await createAdapter().open({
    handle: validHandle(pptxBytes),
    bytes: pptxBytes,
    descriptor_id: 'viewer.office.pptx',
    limits: { max_slides: 1 }
  });
  assert.equal(slideLimit.document_model.state, 'too_large');
  assert.equal(slideLimit.metrics.parser_dispatches, 0);
});

test('counts logical presentation slide references before dispatch even when two ids reuse one physical slide', async () => {
  const zip = await JSZip.loadAsync(await generatePptxFixture());
  const presentation = await zip.file('ppt/presentation.xml').async('string');
  zip.file(
    'ppt/presentation.xml',
    presentation.replace(
      '</p:sldIdLst>',
      '<p:sldId id="257" r:id="r1"/></p:sldIdLst>'
    )
  );
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const result = await createAdapter().open({
    handle: validHandle(bytes),
    bytes,
    descriptor_id: 'viewer.office.pptx',
    limits: { max_slides: 1 }
  });

  assert.equal(result.document_model.state, 'too_large');
  assert.equal(result.metrics.parser_dispatches, 0);
  assert.ok(result.diagnostics.some((item) => item.code === 'VIEWER_LIMIT_SLIDES'));
});

test('keeps a post-parser max slide guard when Core returns more slides than the package inventory', async () => {
  const bytes = await generatePptxFixture();
  const officeCore = {
    ...generatedOfficeCore,
    async parsePptxVscode() {
      return {
        result: {
          status: 'ok',
          diagnostics: [],
          document: {
            slides: [
              { slideNumber: 1, elements: [] },
              { slideNumber: 2, elements: [] }
            ]
          }
        }
      };
    }
  };
  const result = await createAdapter({ office_core: officeCore }).open({
    handle: validHandle(bytes),
    bytes,
    descriptor_id: 'viewer.office.pptx',
    limits: { max_slides: 1 }
  });

  assert.equal(result.document_model.state, 'too_large');
  assert.equal(result.metrics.parser_dispatches, 1);
  assert.ok(result.diagnostics.some((item) => item.code === 'VIEWER_LIMIT_SLIDES'));
});

test('stops output traversal at limit plus one for hostile arrays and never enumerates arbitrary model objects', async () => {
  const bytes = await generatePptxFixture();
  let indexedReads = 0;
  let objectEnumerations = 0;
  const hostileElement = new Proxy({ text: 'bounded text' }, {
    ownKeys() {
      objectEnumerations += 1;
      throw new Error('arbitrary model object was enumerated');
    }
  });
  const slides = new Proxy(new Array(1_000), {
    get(target, property, receiver) {
      if (/^\d+$/.test(String(property))) {
        indexedReads += 1;
        if (indexedReads > 4) throw new Error('slide traversal exceeded limit plus one');
        return { slideNumber: Number(property) + 1, elements: [hostileElement] };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const officeCore = {
    ...generatedOfficeCore,
    async parsePptxVscode() {
      return { result: { status: 'ok', document: { slides }, diagnostics: [] } };
    }
  };
  const result = await createAdapter({ office_core: officeCore }).open({
    handle: validHandle(bytes),
    bytes,
    descriptor_id: 'viewer.office.pptx',
    limits: { max_model_items: 2, max_text_items: 1 }
  });

  assert.equal(result.document_model.state, 'partial');
  assert.equal(result.document_model.slides.length, 2);
  assert.ok(indexedReads <= 3, indexedReads);
  assert.equal(objectEnumerations, 0);
  assert.ok(result.diagnostics.some((item) => item.code === 'VIEWER_OUTPUT_TRUNCATED'));
});

test('marks every undeclared OOXML feature class partial with scoped diagnostics', async () => {
  const zip = await JSZip.loadAsync(await generatePptxFixture());
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file(
    '[Content_Types].xml',
    contentTypes.replace('</Types>', '<Override PartName="/ppt/vendor/widget.xml" ContentType="application/vnd.vendor.widget+xml"/></Types>')
  );
  const slide = await zip.file('ppt/slides/slide1.xml').async('string');
  zip.file(
    'ppt/slides/slide1.xml',
    slide.replace(
      '<p:cSld>',
      '<p:cSld xmlns:vendor="https://vendor.invalid/ooxml"><p:graphicFrame><a:graphic><a:graphicData uri="https://vendor.invalid/drawing"/></a:graphic></p:graphicFrame><a:latin typeface="Unavailable Vendor Font"/>'
    )
  );
  const presentation = await zip.file('ppt/presentation.xml').async('string');
  zip.file('ppt/presentation.xml', presentation.replace('</p:presentation>', '<p:modifyVerifier/></p:presentation>'));
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/" TargetMode="External"/></Relationships>'
  );
  zip.file('ppt/vendor/widget.xml', '<vendor:widget xmlns:vendor="https://vendor.invalid/ooxml"/>');
  zip.file('ppt/embeddings/object1.bin', new Uint8Array([1, 2, 3]));
  zip.file('ppt/media/vector.emf', new Uint8Array([1, 2, 3]));
  zip.file('ppt/vbaProject.bin', new Uint8Array([1, 2, 3]));
  zip.file('ppt/externalLinks/link1.xml', '<externalLink/>');
  zip.file('ppt/theme/theme1.xml', '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>');
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const result = await createAdapter().open({
    handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.pptx'
  });

  const codes = new Set(result.diagnostics.map((item) => item.code));
  for (const code of [
    'VIEWER_OOXML_PART_UNKNOWN',
    'VIEWER_OOXML_CONTENT_TYPE_UNKNOWN',
    'VIEWER_OOXML_NAMESPACE_UNKNOWN',
    'VIEWER_OOXML_DRAWING_UNKNOWN',
    'VIEWER_OOXML_EMBEDDED_OBJECT',
    'VIEWER_OOXML_MACRO_PRESENT',
    'VIEWER_OOXML_EXTERNAL_RELATIONSHIP',
    'VIEWER_OOXML_EXTERNAL_LINK',
    'VIEWER_OOXML_FONT_UNVERIFIED',
    'VIEWER_OOXML_THEME_MASTER_UNVERIFIED',
    'VIEWER_OOXML_PROTECTION_PRESENT',
    'VIEWER_IMAGE_METADATA_UNVERIFIED'
  ]) assert.ok(codes.has(code), code);
  assert.equal(result.document_model.state, 'partial');
  assert.ok(result.diagnostics.every((item) => item.scope && item.forces_partial === true));
});

test('keeps standard package metadata and slide master/layout declarations ready', async () => {
  const zip = await JSZip.loadAsync(await generatePptxFixture());
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file(
    '[Content_Types].xml',
    contentTypes.replace(
      '</Types>',
      '<Override PartName="/docProps/core.xml" ContentType="Application/Vnd.Openxmlformats-Package.Core-Properties+Xml"/>'
        + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
        + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
        + '</Types>'
    )
  );
  const rootRels = await zip.file('_rels/.rels').async('string');
  zip.file(
    '_rels/.rels',
    rootRels.replace(
      '</Relationships>',
      '<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        + '</Relationships>'
    )
  );
  zip.file(
    'docProps/core.xml',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
      + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
      + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Standard metadata</dc:title></cp:coreProperties>'
  );
  const presentationRels = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    presentationRels.replace(
      '</Relationships>',
      '<Relationship Id="rMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
        + '</Relationships>'
    )
  );
  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
      + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree/></p:cSld></p:sldMaster>'
  );
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
      + '</Relationships>'
  );
  zip.file(
    'ppt/slideLayouts/slideLayout1.xml',
    '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
      + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree/></p:cSld></p:sldLayout>'
  );
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const result = await createAdapter().open({
    handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.pptx'
  });

  assert.equal(result.document_model.state, 'ready');
  assert.equal(result.diagnostics.length, 0);
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

test('rejects invented drawing and relationship paths on otherwise trusted OOXML hosts', async () => {
  const zip = await JSZip.loadAsync(await generatePptxFixture());
  const slide = await zip.file('ppt/slides/slide1.xml').async('string');
  zip.file(
    'ppt/slides/slide1.xml',
    slide.replace(
      '<p:cSld>',
      '<p:cSld xmlns:reviewer="http://schemas.openxmlformats.org/drawingml/2006/reviewer-invented-namespace"><p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/reviewer-invented"/></a:graphic></p:graphicFrame>',
    ),
  );
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rTrustedHostUnknown" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/reviewer-invented" Target="../widgets/widget.xml"/>'
      + '</Relationships>',
  );
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const result = await createAdapter().open({
    handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.pptx',
  });

  assert.equal(result.document_model.state, 'partial');
  assert.ok(result.diagnostics.some((item) => item.code === 'VIEWER_OOXML_NAMESPACE_UNKNOWN'));
  assert.ok(result.diagnostics.some((item) => item.code === 'VIEWER_OOXML_DRAWING_UNKNOWN'));
  assert.ok(result.diagnostics.some((item) => item.code === 'VIEWER_OOXML_RELATIONSHIP_UNKNOWN'));
});

test('parses single-quoted OOXML namespace, content-type, relationship, and drawing attributes', async () => {
  const zip = await JSZip.loadAsync(await generatePptxFixture());
  const slide = await zip.file('ppt/slides/slide1.xml').async('string');
  zip.file(
    'ppt/slides/slide1.xml',
    slide.replace(
      '<p:cSld>',
      "<p:cSld xmlns:reviewer='https://reviewer.invalid/ns'><p:graphicFrame><a:graphic><a:graphicData uri='https://reviewer.invalid/drawing'/></a:graphic></p:graphicFrame>",
    ),
  );
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file(
    '[Content_Types].xml',
    contentTypes.replace('</Types>', "<Override PartName='/ppt/reviewer.xml' ContentType='application/vnd.reviewer+xml'/></Types>"),
  );
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>"
      + "<Relationship Id='rReviewer' Type='https://reviewer.invalid/relationship' Target='../reviewer.xml'/></Relationships>",
  );
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const result = await createAdapter().open({
    handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.pptx',
  });
  const codes = new Set(result.diagnostics.map((item) => item.code));

  assert.equal(result.document_model.state, 'partial');
  for (const code of [
    'VIEWER_OOXML_NAMESPACE_UNKNOWN',
    'VIEWER_OOXML_CONTENT_TYPE_UNKNOWN',
    'VIEWER_OOXML_RELATIONSHIP_UNKNOWN',
    'VIEWER_OOXML_DRAWING_UNKNOWN',
  ]) assert.ok(codes.has(code), code);
});

test('decodes XML entities before exact OOXML URI admission checks', async () => {
  const zip = await JSZip.loadAsync(await generatePptxFixture());
  const slide = await zip.file('ppt/slides/slide1.xml').async('string');
  zip.file(
    'ppt/slides/slide1.xml',
    slide.replace(
      '<p:cSld>',
      '<p:cSld xmlns:reviewer="https://reviewer.invalid/ooxm&#108;"><p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/reviewer-&#x69;nvented"/></a:graphic></p:graphicFrame>',
    ),
  );
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rEntity" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/reviewer-&#105;nvented" Target="../reviewer.xml"/>'
      + '</Relationships>',
  );
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const result = await createAdapter().open({
    handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.pptx',
  });
  const codes = new Set(result.diagnostics.map((item) => item.code));

  assert.equal(result.document_model.state, 'partial');
  assert.ok(codes.has('VIEWER_OOXML_NAMESPACE_UNKNOWN'));
  assert.ok(codes.has('VIEWER_OOXML_RELATIONSHIP_UNKNOWN'));
  assert.ok(codes.has('VIEWER_OOXML_DRAWING_UNKNOWN'));
});

test('treats OOXML URI case variants as unknown while keeping MIME values case-insensitive', async () => {
  const zip = await JSZip.loadAsync(await generatePptxFixture());
  const slide = await zip.file('ppt/slides/slide1.xml').async('string');
  zip.file(
    'ppt/slides/slide1.xml',
    slide.replace(
      '<p:cSld>',
      '<p:cSld><p:graphicFrame><a:graphic><a:graphicData uri="HTTP://SCHEMAS.OPENXMLFORMATS.ORG/drawingml/2006/chart"/></a:graphic></p:graphicFrame>',
    ),
  );
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file(
    '[Content_Types].xml',
    contentTypes.replace(
      '</Types>',
      '<Override PartName="/docProps/core.xml" ContentType="Application/Vnd.Openxmlformats-Package.Core-Properties+Xml"/></Types>',
    ),
  );
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const result = await createAdapter().open({
    handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.pptx',
  });

  assert.equal(result.document_model.state, 'partial');
  assert.ok(result.diagnostics.some((item) => item.code === 'VIEWER_OOXML_DRAWING_UNKNOWN'));
  assert.equal(result.diagnostics.some((item) => item.code === 'VIEWER_OOXML_CONTENT_TYPE_UNKNOWN'), false);
});

test('fails partial on malformed or incomplete Content Types declarations', async (t) => {
  const mutations = [
    ['empty ContentType', (xml) => xml.replace('ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"', 'ContentType=""')],
    ['missing ContentType', (xml) => xml.replace(' ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"', '')],
    ['unquoted attribute before ContentType', (xml) => xml.replace('<Override PartName="/ppt/slides/slide1.xml" ', '<Override PartName=/ppt/slides/slide1.xml ')],
    ['duplicate ContentType', (xml) => xml.replace('ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"', 'ContentType="application/xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"')],
    ['wrong-case ContentType', (xml) => xml.replace('ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"', 'contenttype="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"')],
    ['missing Default Extension', (xml) => xml.replace('<Default Extension="rels" ', '<Default ')],
    ['missing Override PartName', (xml) => xml.replace('<Override PartName="/ppt/slides/slide1.xml" ', '<Override ')],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const zip = await JSZip.loadAsync(await generatePptxFixture());
      const contentTypes = await zip.file('[Content_Types].xml').async('string');
      zip.file('[Content_Types].xml', mutate(contentTypes));
      const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
      const result = await createAdapter().open({
        handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.pptx',
      });

      assert.equal(result.document_model.state, 'partial');
      assert.ok(result.diagnostics.some((item) => item.forces_partial === true));
      assert.ok(
        result.diagnostics.some((item) => ['VIEWER_OOXML_CONTENT_TYPE_INVALID', 'VIEWER_OOXML_XML_MALFORMED'].includes(item.code)),
      );
    });
  }
});

test('fails partial when an XML QName prefix is used without an in-scope namespace binding', async () => {
  const zip = await JSZip.loadAsync(await generatePptxFixture());
  const slide = await zip.file('ppt/slides/slide1.xml').async('string');
  zip.file(
    'ppt/slides/slide1.xml',
    slide.replace(' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"', ''),
  );
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const result = await createAdapter().open({
    handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.pptx',
  });

  assert.equal(result.document_model.state, 'partial');
  assert.ok(result.diagnostics.some((item) => item.code === 'VIEWER_OOXML_NAMESPACE_UNDECLARED'));
});

test('fails partial when an OOXML default namespace is missing', async () => {
  const zip = await JSZip.loadAsync(await generatePptxFixture());
  const relationships = await zip.file('_rels/.rels').async('string');
  zip.file(
    '_rels/.rels',
    relationships.replace(' xmlns="http://schemas.openxmlformats.org/package/2006/relationships"', ''),
  );
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const result = await createAdapter().open({
    handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.pptx',
  });

  assert.equal(result.document_model.state, 'partial');
  assert.ok(result.diagnostics.some((item) => item.code === 'VIEWER_OOXML_NAMESPACE_UNDECLARED'));
});

test('accepts standard default, xml, xmlns, mc, and Ignorable namespace semantics', async () => {
  const zip = await JSZip.loadAsync(await generatePptxFixture());
  const slide = await zip.file('ppt/slides/slide1.xml').async('string');
  zip.file(
    'ppt/slides/slide1.xml',
    slide.replace(
      '<p:sld ',
      '<p:sld xmlns:xml="http://www.w3.org/XML/1998/namespace" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="p" xml:space="preserve" ',
    ),
  );
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const result = await createAdapter().open({
    handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.pptx',
  });

  assert.equal(result.document_model.state, 'ready');
  assert.deepEqual(result.diagnostics, []);
});

test('keeps Core diagnostics request-scoped across overlapping opens', async () => {
  const restore = installDom();
  let call = 0;
  let releaseFirst;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });
  const officeCore = {
    ...generatedOfficeCore,
    async mountBundledWordViewer(_input, container, context) {
      call += 1;
      const request = call === 1 ? 'A' : 'B';
      const paragraph = document.createElement('p');
      paragraph.textContent = `request ${request}`;
      container.append(paragraph);
      if (request === 'A') {
        firstStartedResolve();
        await firstMayFinish;
        context.logger.log({ code: 'request-a-diagnostic', severity: 'warning', forces_partial: true });
      } else {
        context.logger.log({ code: 'request-b-diagnostic', severity: 'warning', forces_partial: true });
        releaseFirst();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { status: { state: 'ready', format: 'docx', renderer: 'core', diagnostics: [] }, dispose() {} };
    },
  };
  try {
    const bytes = await generateDocxFixture();
    const adapter = createAdapter({ office_core: officeCore });
    const first = adapter.open({ handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.docx' });
    await firstStarted;
    const second = adapter.open({ handle: validHandle(bytes), bytes, descriptor_id: 'viewer.office.docx' });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.document_model.state, 'partial');
    assert.deepEqual(firstResult.diagnostics.map((item) => item.code), ['VIEWER_REQUEST_A_DIAGNOSTIC']);
    assert.equal(secondResult.document_model.state, 'partial');
    assert.deepEqual(secondResult.diagnostics.map((item) => item.code), ['VIEWER_REQUEST_B_DIAGNOSTIC']);
  } finally {
    restore();
  }
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
