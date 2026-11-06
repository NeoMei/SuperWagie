import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectOfficePackage } from './office-package.mjs';
import { OFFICE_LIMITS, officeError, validatePages, validatePng, validateSemanticNodes, pageRasterSize } from './office-limits.mjs';
import { killDocumentProcess } from './document-process.mjs';

async function render(request, bytes) {
  const { config, kind, outputDir, fallbackNodes, packageInfo } = request;
  if (request.operation !== 'probe') validateSemanticNodes(fallbackNodes);
  const { chromium } = await import(pathToFileURL(join(config.playwrightModule, 'index.mjs')).href);
  let server; let browser;
  try {
    server = await chromium.launchServer({ executablePath: config.browserExecutable, headless: true, timeout: 20000, args: ['--disable-features=MacAppCodeSignClone'] });
    process.send?.({ browserPid: server.process().pid });
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 15000 });
    if (request.operation === 'probe') return { version: browser.version() };
    const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
    let blockedRequests = 0;
    await context.route('**/*', route => { if (/^(data|blob):/.test(route.request().url())) return route.continue(); blockedRequests++; return route.abort('blockedbyclient'); });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
    await page.setContent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data: blob:; connect-src \'none\'; frame-src \'none\'; media-src data: blob:"><style>html,body{margin:0;background:#ddd}#root{display:flex;flex-direction:column;gap:24px;align-items:center;padding:24px}</style><div id="root"></div>');
    const vendor = fileURLToPath(new URL(`../../vendor/office/${kind === 'pptx' ? 'pptx2html.full.js' : 'docx-preview.js'}`, import.meta.url));
    await page.addScriptTag({ path: await realpath(vendor) });
    const diagnostics = []; let appearance = 'browser-rendered';
    try {
      await page.evaluate(async ({ kind, encoded }) => {
        const raw = atob(encoded); const data = Uint8Array.from(raw, ch => ch.charCodeAt(0)).buffer; const root = document.querySelector('#root');
        if (kind === 'pptx') await globalThis.pptx2html(data, root);
        else await globalThis.SuperVideoDocx.renderAsync(data, root, root, { useBase64URL: true, breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true });
      }, { kind, encoded: bytes.toString('base64') });
    } catch (error) {
      // Only a completed renderer rejection permits bounded readable reconstruction.
      // A hung evaluate is terminated by the parent and cannot enter this path.
      if (error.name === 'TimeoutError' || !browser.isConnected() || page.isClosed()) throw officeError('DOCUMENT_RENDER_FAILED', 'Office browser stopped during rendering');
      const groups = kind === 'pptx' ? Array.from({ length: packageInfo?.slideCount ?? 0 }, (_, index) => `slide:${index + 1}`) : ['document'];
      if (!groups.length || groups.some(group => !fallbackNodes.some(node => node.kind !== 'page' && node.text.trim() && (group === 'document' || node.locator.startsWith(group + '/'))))) {
        throw officeError('DOCUMENT_RENDER_FAILED', `Office renderer failed without text for every page: ${String(error.message).slice(0, 1024)}`);
      }
      appearance = 'reconstructed-text';
      diagnostics.push({ code: 'OFFICE_RENDER_FALLBACK', errorCode: String(error.code ?? error.name ?? 'Error').slice(0, 80), detail: String(error.message).slice(0, 2048) });
      await page.evaluate(({ kind, nodes, slideCount }) => {
        const root = document.querySelector('#root'); root.innerHTML = '';
        const groups = kind === 'pptx' ? Array.from({ length: slideCount }, (_, index) => `slide:${index + 1}`) : ['document'];
        for (const group of groups) {
          const section = document.createElement('section'); section.dataset.reconstructed = 'true';
          section.style.cssText = 'width:1280px;min-height:720px;padding:72px;box-sizing:border-box;background:white;color:#172033;font:28px/1.5 sans-serif;white-space:pre-wrap';
          section.textContent = 'Reconstructed text\n\n' + nodes.filter(node => group === 'document' || node.locator === group || node.locator.startsWith(group + '/')).map(node => node.text).filter(Boolean).join('\n\n'); root.appendChild(section);
        }
      }, { kind, nodes: fallbackNodes, slideCount: packageInfo?.slideCount });
    }
    await page.evaluate(() => document.fonts.ready);
    const selector = appearance === 'reconstructed-text' ? '#root > section[data-reconstructed]' : kind === 'pptx' ? '#root > .pptx-wrapper > section' : '#root .docx-wrapper > section.docx';
    const sections = page.locator(selector);
    const bounds = await sections.evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height }; }));
    const geometry = bounds.map(pageRasterSize);
    validatePages(geometry, kind === 'pptx' ? packageInfo?.slideCount : undefined);
    const pages = [];
    for (let index = 0; index < geometry.length; index++) {
      const section = sections.nth(index); const path = join(outputDir, `page-${index + 1}.png`);
      await section.scrollIntoViewIfNeeded();
      const png = await section.screenshot({ path, animations: 'disabled', timeout: 15000 });
      validatePng(png, geometry[index]); pages.push({ path, ...geometry[index] });
    }
    if (blockedRequests) diagnostics.push({ code: 'OFFICE_EXTERNAL_RESOURCES_BLOCKED', count: blockedRequests });
    return { pages, diagnostics, appearance };
  } finally {
    // The parent also tracks this PID and terminates it if close cannot finish.
    if (browser) await browser.close().catch(() => {});
    if (server) { await server.close().catch(() => { killDocumentProcess(server.process().pid); }); process.send?.({ browserClosed: true }); }
  }
}

// Normal exit invokes Playwright's synchronous owned-process cleanup, including
// browsers whose launch has not yet returned a BrowserServer handle.
process.once('SIGTERM', () => process.exit(143));
process.once('disconnect', () => process.exit(143));

process.once('message', async request => {
  try {
    const bytes = request.operation === 'probe' ? Buffer.alloc(0) : await readFile(request.inputPath);
    if (bytes.length > OFFICE_LIMITS.compressedBytes) throw officeError('INPUT_TOO_LARGE', 'Input exceeds 256 MiB');
    const result = request.operation === 'inspect' ? await inspectOfficePackage(bytes, request.kind, request.config) : await render(request, bytes);
    process.send({ result }, () => process.exit(0));
  } catch (error) {
    process.send({ error: { code: error.code ?? 'DOCUMENT_RENDER_FAILED', message: String(error.message).slice(0, 2048) } }, () => process.exit(0));
  }
});
