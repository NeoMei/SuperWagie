import { app, BrowserWindow, nativeImage, protocol, session } from 'electron';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const siblingCore = new URL('./core-client.mjs', import.meta.url);
const siblingSecureFiles = new URL('./secure-files.mjs', import.meta.url);
const coreModule = existsSync(fileURLToPath(siblingCore)) ? siblingCore : new URL('../../solution-b-spike/src/core-client.mjs', import.meta.url);
const secureFilesModule = existsSync(fileURLToPath(siblingSecureFiles)) ? siblingSecureFiles : new URL('../../solution-b-spike/src/secure-files.mjs', import.meta.url);
const [{ canonicalJson }, { resolvePrivate, secureAtomicWrite, secureReadByFd }] = await Promise.all([
  import(coreModule.href), import(secureFilesModule.href),
]);

process.stderr.write('worker-boot: imports-complete\n');
protocol.registerSchemesAsPrivileged([{
  scheme: 'superwagie-review',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
}]);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const valueAfter = (flag) => { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : undefined; };
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function writeJson(root, path, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  secureAtomicWrite(root, path, bytes);
  return bytes;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validateManifest(root, wrapper) {
  if (!exactKeys(wrapper, ['mac', 'manifest']) || !isHash(wrapper.mac)) throw new Error('EXECUTION_MANIFEST_SCHEMA_INVALID');
  const key = process.env.SUPERWAGIE_JOB_KEY;
  const expected = createHmac('sha256', key).update(canonicalJson(wrapper.manifest)).digest();
  const supplied = Buffer.from(wrapper.mac, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error('EXECUTION_MANIFEST_MAC_INVALID');
  const m = wrapper.manifest;
  const keys = ['schema_version', 'job_id', 'request_id', 'run_nonce', 'audience', 'revision', 'attempt',
    'document', 'renderer', 'pages', 'text_layer', 'resource_limits', 'checkpoint', 'output_authorization',
    'crash_injection_after_pages', 'crash_injection_mode'];
  if (!exactKeys(m, keys) || m.schema_version !== 'solution-b-review-execution-v1'
    || m.audience !== 'review_render_worker' || !/^[a-z0-9-]{1,64}$/.test(m.job_id)
    || !/^[a-f0-9]{32}$/.test(m.request_id) || !/^[a-f0-9]{32}$/.test(m.run_nonce)
    || !Number.isSafeInteger(m.revision) || m.revision < 1
    || !Number.isSafeInteger(m.attempt) || m.attempt < 1) throw new Error('EXECUTION_MANIFEST_DOMAIN_INVALID');
  if (!exactKeys(m.document, ['kind', 'source_path', 'source_sha256', 'declared_page_count'])
    || !['pdf', 'docx', 'wps-pdf'].includes(m.document.kind)
    || !isHash(m.document.source_sha256)
    || !Number.isSafeInteger(m.document.declared_page_count)
    || m.document.declared_page_count <= 0 || m.document.declared_page_count > 500) throw new Error('EXECUTION_MANIFEST_DOCUMENT_INVALID');
  if (!exactKeys(m.renderer, ['scale', 'zoom_variants', 'library_hashes', 'worker_script_sha256'])
    || typeof m.renderer.scale !== 'number' || m.renderer.scale <= 0.1 || m.renderer.scale > 4
    || !Array.isArray(m.renderer.zoom_variants) || m.renderer.zoom_variants.length === 0
    || m.renderer.zoom_variants.length > 4
    || !m.renderer.zoom_variants.every((zoom) => typeof zoom === 'number' && zoom > 0.25 && zoom < 4)
    || !isHash(m.renderer.worker_script_sha256)) throw new Error('EXECUTION_MANIFEST_RENDERER_INVALID');
  if (!Array.isArray(m.renderer.library_hashes) || m.renderer.library_hashes.length === 0
    || m.renderer.library_hashes.length > 8) throw new Error('EXECUTION_MANIFEST_RENDERER_INVALID');
  const libraryPaths = new Set();
  for (const entry of m.renderer.library_hashes) {
    if (!exactKeys(entry, ['path', 'sha256']) || !isHash(entry.sha256)) throw new Error('EXECUTION_MANIFEST_RENDERER_INVALID');
    resolvePrivate(root, entry.path);
    libraryPaths.add(entry.path);
  }
  if (!exactKeys(m.pages, ['indices']) || !Array.isArray(m.pages.indices) || m.pages.indices.length === 0
    || m.pages.indices.some((page) => !Number.isSafeInteger(page) || page < 1 || page > m.document.declared_page_count)
    || new Set(m.pages.indices).size !== m.pages.indices.length) throw new Error('EXECUTION_MANIFEST_PAGES_INVALID');
  if (!exactKeys(m.text_layer, ['required', 'max_items_per_page']) || m.text_layer.required !== true
    || !Number.isSafeInteger(m.text_layer.max_items_per_page) || m.text_layer.max_items_per_page <= 0
    || m.text_layer.max_items_per_page > 100000) throw new Error('EXECUTION_MANIFEST_TEXT_INVALID');
  if (!exactKeys(m.resource_limits, ['max_pages', 'max_page_bytes', 'max_output_bytes', 'max_process_tree_rss_bytes'])
    || !Object.values(m.resource_limits).every((value) => Number.isSafeInteger(value) && value > 0)
    || m.pages.indices.length > m.resource_limits.max_pages) throw new Error('EXECUTION_MANIFEST_LIMITS_INVALID');
  if (!exactKeys(m.checkpoint, ['path', 'job_id', 'revision', 'initial_sha256'])
    || !exactKeys(m.output_authorization, ['directory', 'result_path', 'job_id', 'revision', 'page_pattern', 'text_pattern'])
    || m.checkpoint.job_id !== m.job_id || m.checkpoint.revision !== m.revision
    || m.output_authorization.job_id !== m.job_id || m.output_authorization.revision !== m.revision
    || m.output_authorization.page_pattern !== 'page-%04d.png'
    || m.output_authorization.text_pattern !== 'page-%04d.text.json') throw new Error('EXECUTION_MANIFEST_OUTPUT_INVALID');
  if (!Number.isSafeInteger(m.crash_injection_after_pages) || m.crash_injection_after_pages < 0
    || m.crash_injection_after_pages > m.resource_limits.max_pages
    || !['none', 'sigkill', 'exit1', 'exit86', 'hang'].includes(m.crash_injection_mode)
    || (m.crash_injection_after_pages === 0) !== (m.crash_injection_mode === 'none')
    || (m.attempt === 1 ? m.checkpoint.initial_sha256 !== null : !isHash(m.checkpoint.initial_sha256))) {
    throw new Error('EXECUTION_MANIFEST_BOUNDS_INVALID');
  }
  for (const path of [m.document.source_path, m.checkpoint.path, m.output_authorization.directory,
    m.output_authorization.result_path]) resolvePrivate(root, path, { leafMayBeMissing: true });
  return m;
}

const PDF_PAGE_SCRIPT = [
  'window.addEventListener("error", (event) => console.error("page-error: " + event.message + " " + (event.filename || "") + ":" + event.lineno));',
  'window.addEventListener("unhandledrejection", (event) => console.error("page-rejection: " + (event.reason && (event.reason.stack || event.reason.message) || String(event.reason))));',
  '(async () => {',
  '  try {',
  '    const pdfjs = window.pdfjsLib;',
  '    console.log("pdf-step: lib-present=" + (pdfjs && typeof pdfjs.getDocument === "function"));',
  '    const classicEcho = await new Promise((resolve) => {',
  '      const w = new Worker(URL.createObjectURL(new Blob(["self.onmessage=function(e){self.postMessage({echo:e.data})}"], { type: "text/javascript" })));',
  '      const timer = setTimeout(() => resolve("TIMEOUT"), 1500);',
  '      w.onmessage = (event) => { clearTimeout(timer); resolve("OK:" + JSON.stringify(event.data)); };',
  '      w.onerror = (event) => { clearTimeout(timer); resolve("ERR:" + event.message); };',
  '      w.postMessage("ping");',
  '    });',
  '    console.log("pdf-step: classic-echo=" + classicEcho);',
  '    const moduleEcho = await new Promise((resolve) => {',
  '      const w = new Worker(URL.createObjectURL(new Blob(["self.onmessage=(e)=>self.postMessage({echo:e.data})"], { type: "text/javascript" })), { type: "module" });',
  '      const timer = setTimeout(() => resolve("TIMEOUT"), 1500);',
  '      w.onmessage = (event) => { clearTimeout(timer); resolve("OK:" + JSON.stringify(event.data)); };',
  '      w.onerror = (event) => { clearTimeout(timer); resolve("ERR:" + event.message); };',
  '      w.postMessage("ping");',
  '    });',
  '    console.log("pdf-step: module-echo=" + moduleEcho);',
  '    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.classic.js";',
  '    console.log("pdf-step: workerless-mode-ready handler=" + (window.pdfjsWorker && !!window.pdfjsWorker.WorkerMessageHandler));',
  '    const task = pdfjs.getDocument({ url: "/source.pdf", isEvalSupported: false });',
  '    const doc = await task.promise;',
  '    console.log("pdf-step: doc-loaded pages=" + doc.numPages);',
  '    window.__prepare = async () => ({ page_count: doc.numPages });',
  '    window.__renderPage = async (index, scale) => {',
  '      const page = await doc.getPage(index);',
  '      const viewport = page.getViewport({ scale });',
  '      const base = page.getViewport({ scale: 1 });',
  '      const canvas = document.getElementById("page-canvas");',
  '      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);',
  '      const context = canvas.getContext("2d", { alpha: false });',
  '      context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);',
  '      await page.render({ canvasContext: context, viewport }).promise;',
  '      const content = await page.getTextContent();',
  '      const items = [];',
  '      for (const item of content.items) {',
  '        if (!item.str || !item.str.trim() || items.length >= 20000) continue;',
  '        const transform = item.transform; const width = item.width || 0; const height = item.height || 0;',
  '        const x = transform[4]; const y = transform[5];',
  '        const x0 = x / base.width; const y0 = 1 - (y + height) / base.height;',
  '        const box = [x0, y0, width / base.width, height / base.height].map((value) => Math.max(0, Math.min(1, value)));',
  '        items.push({ text: item.str, bbox: box });',
  '      }',
  '      return { pngDataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height, textItems: items };',
  '    };',
  '  } catch (error) {',
  '    console.error("pdf-module-failed: " + (error && (error.stack || error.message) || String(error)));',
  '    window.__pdfModuleError = String(error && (error.stack || error));',
  '  }',
  '})();',
].join('\n');

const PDF_PAGE_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>pdf review</title></head><body>',
  '<canvas id="page-canvas"></canvas>',
  '<script src="/boot.js"></script>',
  '<script src="/pdf.classic.js"></script>',
  '<script src="/pdf.worker.classic.js"></script>',
  '<script src="/render.js"></script>',
  '</body></html>',
].join('\n');

const DOCX_PAGE_SCRIPT = [
  'window.addEventListener("error", (event) => console.error("page-error: " + event.message + " " + (event.filename || "") + ":" + event.lineno));',
  'window.addEventListener("unhandledrejection", (event) => console.error("page-rejection: " + (event.reason && (event.reason.stack || event.reason.message) || String(event.reason))));',
  'window.__prepare = async () => {',
  '  const response = await fetch("/source.docx");',
  '  const buffer = await response.arrayBuffer();',
  '  await window.docx.renderAsync(buffer, document.getElementById("container"), null, {',
  '    inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: false, useBase64URL: true,',
  '  });',
  '  window.__sections = Array.from(document.querySelectorAll("#container section.docx"));',
  '  const fonts = new Set();',
  '  for (const element of document.querySelectorAll("p,span,h1,h2,h3,h4,h5,h6,li,td,th,div,font")) {',
  '    const family = getComputedStyle(element).fontFamily; if (family) fonts.add(family);',
  '  }',
  '  return { page_count: window.__sections.length, requested_fonts: [...fonts].slice(0, 64) };',
  '};',
  'window.__pageBox = (index) => {',
  '  const rect = window.__sections[index].getBoundingClientRect();',
  '  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };',
  '};',
  'window.__setZoom = (zoom) => { document.getElementById("container").style.zoom = String(zoom); };',
  'window.__textItems = (index) => {',
  '  const section = window.__sections[index]; const rect = section.getBoundingClientRect();',
  '  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);',
  '  const items = []; let node;',
  '  while ((node = walker.nextNode()) && items.length < 20000) {',
  '    const text = node.nodeValue; if (!text || !text.trim()) continue;',
  '    const words = text.split(/(\\s+)/); let offset = 0;',
  '    for (const word of words) {',
  '      const start = offset; offset += word.length;',
  '      if (!word.trim()) continue;',
  '      const range = document.createRange();',
  '      range.setStart(node, start); range.setEnd(node, start + word.length);',
  '      const box = range.getBoundingClientRect();',
  '      if (box.width <= 0 || box.height <= 0) continue;',
  '      items.push({ text: word, bbox: [',
  '        (box.x - rect.x) / rect.width, (box.y - rect.y) / rect.height,',
  '        box.width / rect.width, box.height / rect.height,',
  '      ].map((value) => Math.max(0, Math.min(1, value))) });',
  '    }',
  '  }',
  '  return items;',
  '};',
].join('\n');

const DOCX_PAGE_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>docx review</title>',
  '<style>html,body{margin:0;padding:0;background:#ffffff}</style></head><body>',
  '<div id="container"></div>',
  '<script src="/jszip.min.js"></script>',
  '<script src="/docx-preview.min.js"></script>',
  '<script src="/boot.js"></script>',
  '<script src="/render.js"></script>',
  '</body></html>',
].join('\n');

function validateTextItems(items, limits) {
  if (!Array.isArray(items) || items.length === 0 || items.length > limits.max_items_per_page) {
    throw new Error('TEXT_LAYER_INVALID');
  }
  for (const item of items) {
    if (!exactKeys(item, ['text', 'bbox']) || typeof item.text !== 'string' || item.text.length === 0
      || item.text.length > 4096 || !Array.isArray(item.bbox) || item.bbox.length !== 4
      || item.bbox.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error('TEXT_LAYER_INVALID');
    }
  }
  return true;
}

async function waitForPaint(webContents) {
  await new Promise((resolvePaint) => {
    webContents.once('paint', () => resolvePaint());
    setTimeout(resolvePaint, 400);
  });
}

async function run() {
  const jobFile = valueAfter('--job-file');
  if (jobFile !== 'execution-manifest.json') throw new Error('RELATIVE_LOCKED_JOB_FILE_REQUIRED');
  const root = process.cwd();
  const manifest = validateManifest(root, JSON.parse(secureReadByFd(root, jobFile, 256 * 1024).toString('utf8')));
  if (sha256(readFileSync(process.argv[1])) !== manifest.renderer.worker_script_sha256) {
    throw new Error('WORKER_SCRIPT_IDENTITY_MISMATCH');
  }
  const sourceBytes = secureReadByFd(root, manifest.document.source_path, 48 * 1024 * 1024);
  if (sha256(sourceBytes) !== manifest.document.source_sha256) throw new Error('SOURCE_HASH_MISMATCH');
  for (const entry of manifest.renderer.library_hashes) {
    if (sha256(secureReadByFd(root, entry.path, 16 * 1024 * 1024)) !== entry.sha256) throw new Error('LIBRARY_HASH_MISMATCH');
  }

  const forbiddenEnvironment = ['HOME', 'PATH', 'CODEX_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'SUPERWAGIE_ENV_CANARY', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY'];
  const forbiddenVisible = forbiddenEnvironment.filter((name) => process.env[name] !== undefined);
  const allowedEnvironment = new Set(['LANG', 'LC_ALL', 'SUPERWAGIE_JOB_KEY', '__CFBundleIdentifier', '__CF_USER_TEXT_ENCODING', 'ELECTRON_RUN_AS_NODE']);
  const unexpectedEnvironment = Object.keys(process.env).filter((name) => !allowedEnvironment.has(name));

  const partition = 'review-job-' + manifest.job_id + '-' + manifest.run_nonce;
  const ses = session.fromPartition(partition, { cache: false });
  const schemeCounts = {};
  let blockedRemoteRequests = 0;
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.on('will-download', (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const url = new URL(details.url);
    schemeCounts[url.protocol] = (schemeCounts[url.protocol] ?? 0) + 1;
    const allowed = url.protocol === 'superwagie-review:' && url.hostname === 'bundle';
    if (!allowed) blockedRemoteRequests += 1;
    callback({ cancel: !allowed });
  });
  const libraryByBasename = new Map(manifest.renderer.library_hashes.map((entry) => [entry.path.split('/').pop(), entry.path]));
  const isPdfKind = manifest.document.kind !== 'docx';
  const pageHtml = isPdfKind ? PDF_PAGE_HTML : DOCX_PAGE_HTML;
  const pageScript = isPdfKind ? PDF_PAGE_SCRIPT : DOCX_PAGE_SCRIPT;
  const csp = "default-src 'none'; script-src 'self'; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'";
  await ses.protocol.handle('superwagie-review', (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'bundle') return new Response('not found', { status: 404 });
    const pathname = url.pathname;
    const respond = (bytes, type) => new Response(bytes, {
      headers: {
        'content-type': type,
        'content-security-policy': csp,
        'x-content-type-options': 'nosniff',
        'access-control-allow-origin': '*',
      },
    });
    try {
      if (pathname === '/render.html') return respond(Buffer.from(pageHtml), 'text/html; charset=utf-8');
      if (pathname === '/boot.js') {
        const boot = 'window.__bootRan = true; window.addEventListener("error", function (event) { console.error("page-error: " + event.message + " " + (event.filename || "") + ":" + event.lineno); });';
        return respond(Buffer.from(boot), 'text/javascript; charset=utf-8');
      }
      if (pathname === '/render.js') {
        return respond(Buffer.from(pageScript), 'text/javascript; charset=utf-8');
      }
      if (pathname === '/source.pdf' || pathname === '/source.docx') {
        return respond(sourceBytes, 'application/octet-stream');
      }
      const libraryPath = libraryByBasename.get(pathname.slice(1));
      if (libraryPath) {
        const bytes = secureReadByFd(root, libraryPath, 16 * 1024 * 1024);
        const type = libraryPath.endsWith('.mjs') || libraryPath.endsWith('.js')
          ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
        return respond(bytes, type);
      }
      return new Response('not found', { status: 404 });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  const worker = new BrowserWindow({
    show: false, width: 1200, height: 1600, useContentSize: true,
    webPreferences: {
      session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, offscreen: true, backgroundThrottling: false, webviewTag: false,
    },
  });
  worker.webContents.on('will-navigate', (event) => event.preventDefault());
  worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  worker.webContents.setFrameRate(30);
  worker.webContents.on('console-message', (_event, _level, message) => {
    process.stderr.write('renderer-console: ' + message + '\n');
  });
  worker.webContents.on('did-fail-load', (_event, code, description, url) => {
    process.stderr.write('did-fail-load: ' + code + ' ' + description + ' ' + url + '\n');
  });
  worker.webContents.on('render-process-gone', (_event, details) => {
    process.stderr.write('render-process-gone: ' + JSON.stringify(details) + '\n');
  });
  await worker.loadURL('superwagie-review://bundle/render.html');
  worker.webContents.setZoomFactor(1);

  const fetchProbe = await worker.webContents.executeJavaScript(
    '(async () => { const out = { boot: window.__bootRan === true };'
    + ' for (const path of ["/render.mjs", "/render.js", "/pdf.min.mjs", "/pdf.worker.min.mjs", "/docx-preview.min.js", "/jszip.min.js", "/source.pdf", "/source.docx"]) {'
    + ' try { const response = await fetch(path); const buffer = await response.arrayBuffer(); out[path] = response.status + ":" + buffer.byteLength;'
    + ' } catch (error) { out[path] = "ERR:" + (error && error.message); } } return out; })()',
  );
  process.stderr.write('fetch-probe: ' + JSON.stringify(fetchProbe) + '\n');

  const rendererReady = await worker.webContents.executeJavaScript(
    'new Promise((resolve) => {'
    + ' const deadline = Date.now() + 15000;'
    + ' const poll = () => {'
    + '  if (typeof window.__prepare === "function") return resolve({ ready: true, error: null });'
    + '  if (window.__pdfModuleError) return resolve({ ready: false, error: String(window.__pdfModuleError) });'
    + '  if (Date.now() >= deadline) return resolve({ ready: false, error: "RENDERER_READY_TIMEOUT" });'
    + '  setTimeout(poll, 25);'
    + ' }; poll();'
    + '})',
  );
  if (!rendererReady?.ready) throw new Error('RENDERER_NOT_READY:' + (rendererReady?.error ?? 'UNKNOWN'));
  const preparation = await worker.webContents.executeJavaScript('window.__prepare()');
  if (!preparation || !Number.isSafeInteger(preparation.page_count) || preparation.page_count <= 0) {
    throw new Error('RENDER_PREPARATION_FAILED');
  }
  const pageExact = manifest.document.kind === 'pdf';
  if (pageExact && preparation.page_count !== manifest.document.declared_page_count) {
    throw new Error('PAGE_COUNT_MISMATCH:' + preparation.page_count);
  }
  const repaginated = preparation.page_count !== manifest.document.declared_page_count;

  const checkpointPath = resolvePrivate(root, manifest.checkpoint.path, { leafMayBeMissing: true });
  let checkpoint = { job_id: manifest.job_id, revision: manifest.revision, attempt: manifest.attempt, completed: {} };
  let checkpointRootVerified = manifest.attempt === 1;
  if (existsSync(checkpointPath)) {
    const checkpointBytes = secureReadByFd(root, manifest.checkpoint.path, 8 * 1024 * 1024);
    if (manifest.attempt === 1 || sha256(checkpointBytes) !== manifest.checkpoint.initial_sha256) throw new Error('CHECKPOINT_ROOT_MISMATCH');
    checkpointRootVerified = true;
    checkpoint = JSON.parse(checkpointBytes.toString('utf8'));
    if (!exactKeys(checkpoint, ['attempt', 'completed', 'job_id', 'revision']) || checkpoint.job_id !== manifest.job_id
      || checkpoint.revision !== manifest.revision || checkpoint.attempt !== manifest.attempt - 1
      || !checkpoint.completed || typeof checkpoint.completed !== 'object' || Array.isArray(checkpoint.completed)) {
      throw new Error('CHECKPOINT_IDENTITY_INVALID');
    }
    checkpoint.attempt = manifest.attempt;
  } else if (manifest.attempt > 1) {
    throw new Error('CHECKPOINT_ROOT_MISSING');
  }
  const pageFile = (pattern, page) => pattern.replace('%04d', String(page).padStart(4, '0'));
  let totalOutputBytes = 0;
  for (const [page, hash] of Object.entries(checkpoint.completed)) {
    if (!/^[1-9][0-9]{0,5}$/.test(page) || !isHash(hash) || !manifest.pages.indices.includes(Number(page))) {
      throw new Error('CHECKPOINT_PAGE_INVALID');
    }
    const relativePng = manifest.output_authorization.directory + '/' + pageFile(manifest.output_authorization.page_pattern, Number(page));
    resolvePrivate(root, relativePng);
    const existingPng = secureReadByFd(root, relativePng, manifest.resource_limits.max_page_bytes);
    if (sha256(existingPng) !== hash) throw new Error('CHECKPOINT_PNG_HASH_MISMATCH');
    const decoded = nativeImage.createFromBuffer(existingPng);
    if (decoded.isEmpty() || decoded.getSize().width < 8 || decoded.getSize().height < 8) {
      throw new Error('CHECKPOINT_PNG_INVALID');
    }
    totalOutputBytes += existingPng.byteLength;
  }

  const started = performance.now();
  let pagesRenderedThisAttempt = 0;
  const pageGeometry = {};
  const textItemCounts = {};
  const emitProgressReceipt = (checkpointBytes) => {
    const receipt = {
      schema_version: 'solution-b-progress-v1', job_id: manifest.job_id,
      request_id: manifest.request_id, run_nonce: manifest.run_nonce,
      revision: manifest.revision, attempt: manifest.attempt,
      checkpoint_sha256: sha256(checkpointBytes), completed: checkpoint.completed,
    };
    const wrapper = { type: 'checkpoint_progress', receipt,
      mac: createHmac('sha256', process.env.SUPERWAGIE_JOB_KEY).update(canonicalJson(receipt)).digest('hex') };
    writeSync(1, JSON.stringify(wrapper) + '\n');
  };

  for (const pageIndex of manifest.pages.indices) {
    const key = String(pageIndex);
    if (checkpoint.completed[key]) continue;
    let png;
    let width;
    let height;
    let textItems;
    if (manifest.document.kind !== 'docx') {
      const evaluation = await worker.webContents.executeJavaScript(
        'window.__renderPage(' + JSON.stringify(pageIndex) + ',' + JSON.stringify(manifest.renderer.scale) + ')',
      );
      const prefix = 'data:image/png;base64,';
      if (!evaluation || !evaluation.pngDataUrl || !evaluation.pngDataUrl.startsWith(prefix)) throw new Error('PNG_ENCODING_FAILED');
      png = Buffer.from(evaluation.pngDataUrl.slice(prefix.length), 'base64');
      width = evaluation.width;
      height = evaluation.height;
      textItems = evaluation.textItems;
    } else {
      const box = await worker.webContents.executeJavaScript('window.__pageBox(' + JSON.stringify(pageIndex - 1) + ')');
      if (!box || box.width < 8 || box.height < 8) throw new Error('DOCX_PAGE_BOX_INVALID');
      const requiredWidth = Math.ceil(box.x + box.width) + 16;
      const requiredHeight = Math.ceil(box.y + box.height) + 16;
      const currentSize = worker.getContentSize();
      if (requiredWidth > currentSize[0] || requiredHeight > currentSize[1]) {
        worker.setContentSize(Math.max(requiredWidth, currentSize[0]), Math.max(requiredHeight, currentSize[1]));
        await waitForPaint(worker.webContents);
      }
      await waitForPaint(worker.webContents);
      const image = await worker.webContents.capturePage({
        x: Math.max(0, Math.floor(box.x)), y: Math.max(0, Math.floor(box.y)),
        width: Math.ceil(box.width), height: Math.ceil(box.height),
      });
      if (image.isEmpty()) throw new Error('DOCX_CAPTURE_FAILED');
      png = image.toPNG();
      width = image.getSize().width;
      height = image.getSize().height;
      textItems = await worker.webContents.executeJavaScript('window.__textItems(' + JSON.stringify(pageIndex - 1) + ')');
    }
    validateTextItems(textItems, manifest.text_layer);
    if (png.byteLength > manifest.resource_limits.max_page_bytes) throw new Error('PAGE_RESOURCE_LIMIT');
    totalOutputBytes += png.byteLength;
    if (totalOutputBytes > manifest.resource_limits.max_output_bytes) throw new Error('OUTPUT_RESOURCE_LIMIT');
    const decodedPage = nativeImage.createFromBuffer(png);
    if (decodedPage.isEmpty() || decodedPage.getSize().width !== width || decodedPage.getSize().height !== height) {
      throw new Error('PAGE_PNG_DECODE_INVALID');
    }
    const hash = sha256(png);
    const outputName = pageFile(manifest.output_authorization.page_pattern, pageIndex);
    const textName = pageFile(manifest.output_authorization.text_pattern, pageIndex);
    writeJson(root, manifest.output_authorization.directory + '/' + outputName + '.meta.json', {
      sha256: hash, bytes: png.byteLength, width, height,
    });
    secureAtomicWrite(root, manifest.output_authorization.directory + '/' + outputName, png);
    writeJson(root, manifest.output_authorization.directory + '/' + textName, { page: pageIndex, items: textItems });
    pageGeometry[key] = { width, height };
    textItemCounts[key] = textItems.length;
    checkpoint.completed[key] = hash;
    const checkpointBytes = writeJson(root, manifest.checkpoint.path, checkpoint);
    emitProgressReceipt(checkpointBytes);
    pagesRenderedThisAttempt += 1;
    if (manifest.crash_injection_after_pages && pagesRenderedThisAttempt >= manifest.crash_injection_after_pages) {
      if (manifest.crash_injection_mode === 'hang') {
        setInterval(() => {}, 60_000);
        await new Promise(() => {});
      }
      worker.destroy();
      if (manifest.crash_injection_mode === 'sigkill') process.kill(process.pid, 'SIGKILL');
      else if (manifest.crash_injection_mode === 'exit1') app.exit(1);
      else app.exit(86);
      return;
    }
  }

  const zoomArtifacts = [];
  const zoomPage = manifest.pages.indices[0];
  for (const zoom of manifest.renderer.zoom_variants) {
    if (zoom === 1) continue;
    let zoomPng;
    let zoomWidth;
    let zoomHeight;
    if (manifest.document.kind === 'pdf') {
      const evaluation = await worker.webContents.executeJavaScript(
        'window.__renderPage(' + JSON.stringify(zoomPage) + ',' + JSON.stringify(manifest.renderer.scale * zoom) + ')',
      );
      const prefix = 'data:image/png;base64,';
      zoomPng = Buffer.from(evaluation.pngDataUrl.slice(prefix.length), 'base64');
      zoomWidth = evaluation.width;
      zoomHeight = evaluation.height;
    } else {
      await worker.webContents.executeJavaScript('window.__setZoom(' + JSON.stringify(zoom) + ')');
      await waitForPaint(worker.webContents);
      const box = await worker.webContents.executeJavaScript('window.__pageBox(' + JSON.stringify(zoomPage - 1) + ')');
      const requiredWidth = Math.ceil(box.x + box.width) + 16;
      const requiredHeight = Math.ceil(box.y + box.height) + 16;
      const currentSize = worker.getContentSize();
      if (requiredWidth > currentSize[0] || requiredHeight > currentSize[1]) {
        worker.setContentSize(Math.max(requiredWidth, currentSize[0]), Math.max(requiredHeight, currentSize[1]));
        await waitForPaint(worker.webContents);
      }
      await waitForPaint(worker.webContents);
      const image = await worker.webContents.capturePage({
        x: Math.max(0, Math.floor(box.x)), y: Math.max(0, Math.floor(box.y)),
        width: Math.ceil(box.width), height: Math.ceil(box.height),
      });
      zoomPng = image.toPNG();
      zoomWidth = image.getSize().width;
      zoomHeight = image.getSize().height;
      await worker.webContents.executeJavaScript('window.__setZoom(1)');
    }
    const zoomName = 'zoom/page-' + String(zoomPage).padStart(4, '0') + '-z' + String(Math.round(zoom * 100)).padStart(3, '0') + '.png';
    resolvePrivate(root, manifest.output_authorization.directory + '/' + zoomName, { leafMayBeMissing: true });
    secureAtomicWrite(root, manifest.output_authorization.directory + '/' + zoomName, zoomPng);
    zoomArtifacts.push({ zoom, page: zoomPage, sha256: sha256(zoomPng), width: zoomWidth, height: zoomHeight });
  }

  const elapsedMs = performance.now() - started;
  const metrics = app.getAppMetrics();
  const processTreeRssBytes = metrics.reduce((sum, item) => sum + (item.memory?.workingSetSize ?? 0) * 1024, 0);
  if (processTreeRssBytes > manifest.resource_limits.max_process_tree_rss_bytes) throw new Error('PROCESS_TREE_RESOURCE_LIMIT');
  const hashes = manifest.pages.indices.map((page) => checkpoint.completed[String(page)]);
  const result = {
    jobId: manifest.job_id,
    requestId: manifest.request_id,
    revision: manifest.revision,
    attempt: manifest.attempt,
    hostPid: process.pid,
    parentPid: process.ppid,
    partition,
    kind: manifest.document.kind,
    declaredPageCount: manifest.document.declared_page_count,
    renderedPageCount: preparation.page_count,
    repaginated,
    requestedFonts: preparation.requested_fonts ?? [],
    fontSubstitution: { standard_font_data_bundled: false, renderer: manifest.document.kind === 'pdf' ? 'pdfjs-system-fallback' : 'chromium-system-fallback' },
    pageIndices: manifest.pages.indices,
    hashes,
    pageGeometry,
    textItemCounts,
    zoomArtifacts,
    pagesRenderedThisAttempt,
    elapsedMs,
    hostMainRssBytes: process.memoryUsage().rss,
    processTreeRssBytes,
    processTreeTypes: [...new Set(metrics.map((item) => item.type))].sort(),
    checkpointRootVerified,
    environmentFromEmptyWhitelist: unexpectedEnvironment.length === 0 && forbiddenVisible.length === 0,
    hostSecretCanaryVisible: forbiddenVisible.includes('SUPERWAGIE_ENV_CANARY'),
    unexpectedEnvironment,
    forbiddenVisible,
    allSchemeNetworkAttempts: Object.values(schemeCounts).reduce((a, b) => a + b, 0),
    schemeCounts,
    blockedRemoteRequests,
    allowedRemoteRequests: 0,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    executionManifestVerified: true,
  };
  writeJson(root, manifest.output_authorization.result_path, result);
  await ses.clearStorageData();
  worker.destroy();
  app.quit();
}

app.whenReady().then(run).catch((error) => {
  console.error(error.stack ?? error);
  app.exit(1);
});
