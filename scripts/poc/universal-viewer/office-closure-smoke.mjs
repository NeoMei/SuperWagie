import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';

const ZIP_DATE = new Date('1980-01-01T00:00:00.000Z');
const DOCX_TEXT = 'Universal Viewer DOCX Smoke';
const PPTX_TEXT = 'Universal Viewer PPTX Smoke';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function deterministicZip(entries) {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    zip.file(name, body, { date: ZIP_DATE, createFolders: false });
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE', platform: 'UNIX' });
}

export function generateDocxFixture() {
  return deterministicZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${DOCX_TEXT}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
  });
}

export function generatePptxFixture() {
  return deterministicZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    'ppt/_rels/presentation.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="r1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
    'ppt/slides/slide1.xml': `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="952500" y="952500"/><a:ext cx="4572000" cy="914400"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>${PPTX_TEXT}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  });
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://viewer.invalid/', pretendToBeVisual: true });
  const names = [
    'window', 'document', 'navigator', 'Node', 'Text', 'Element', 'HTMLElement', 'HTMLCanvasElement',
    'SVGElement', 'ShadowRoot', 'Document', 'DocumentFragment', 'DOMParser', 'XMLSerializer',
    'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ];
  for (const name of names) {
    const value = name === 'window' ? dom.window : dom.window[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  if (!dom.window.HTMLElement.prototype.scrollIntoView) dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
  // docx-preview schedules pagination work after renderAsync resolves. This
  // smoke runs in a short-lived process, so its DOM must remain alive until
  // process exit rather than being torn down under those queued callbacks.
  return () => undefined;
}

async function flushAnimationFrames(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

export async function runOfficeClosureSmoke({ bundlePath } = {}) {
  if (typeof bundlePath !== 'string' || !path.isAbsolute(bundlePath)) throw new Error('Office smoke requires an absolute bundle path');
  const restore = installDom();
  try {
    const module = await import(`${pathToFileURL(bundlePath).href}?sha256=${hash(readFileSync(bundlePath))}`);
    for (const name of ['mountWordViewer', 'mountBundledWordViewer', 'mountPptViewer', 'parsePptxVscode', 'renderSlide']) {
      if (typeof module[name] !== 'function') throw new Error(`Office bundle is missing executable export ${name}`);
    }
    const docxBytes = await generateDocxFixture();
    const pptxBytes = await generatePptxFixture();
    const ctx = {
      assets: { resolveAssetUrl: async (value) => value },
      i18n: { t: (key) => key },
      logger: { log: () => undefined },
    };

    const wordContainer = document.createElement('div');
    const word = await module.mountBundledWordViewer(
      { fileName: 'smoke.docx', data: docxBytes },
      wordContainer,
      ctx,
      { styleIsolation: 'scoped' },
    );
    const wordText = wordContainer.textContent.replace(/\s+/g, ' ').trim();
    const wordStatus = word.status.state;
    await flushAnimationFrames();
    word.dispose();

    const parsed = await module.parsePptxVscode(pptxBytes);
    if (parsed.result.status !== 'ok') throw new Error(`PPTX parse failed: ${parsed.result.failure.code}`);
    const pptContainer = document.createElement('div');
    const ppt = await module.mountPptViewer(
      { fileName: 'smoke.pptx', data: pptxBytes },
      pptContainer,
      ctx,
      {},
      { styleIsolation: 'scoped' },
    );
    const pptText = pptContainer.textContent.replace(/\s+/g, ' ').trim();
    const renderedSlide = module.renderSlide(parsed.result.document.slides[0], 1);
    const renderedSlideText = renderedSlide.textContent.replace(/\s+/g, ' ').trim();
    const pptMode = ppt.mode;
    ppt.dispose();
    await flushAnimationFrames();

    const placeholder = wordStatus !== 'ready'
      || !wordText.includes(DOCX_TEXT)
      || parsed.result.document.slides[0]?.elements.length === 0
      || !pptText.includes(PPTX_TEXT)
      || renderedSlideText !== PPTX_TEXT;
    return {
      schema_id: 'superwagie.viewer-office-closure-smoke.v1',
      fixtures: {
        docx: { bytes: docxBytes.byteLength, sha256: hash(docxBytes) },
        pptx: { bytes: pptxBytes.byteLength, sha256: hash(pptxBytes) },
      },
      docx: { status: wordStatus, rendered_text: wordText },
      pptx: {
        parse_status: parsed.result.status,
        slide_count: parsed.result.document.totalSlides,
        element_count: parsed.result.document.slides[0]?.elements.length ?? 0,
        mount_mode: pptMode,
        rendered_text: pptText,
        render_slide_text: renderedSlideText,
      },
      placeholder_content: placeholder,
    };
  } finally {
    restore();
  }
}
