import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const selfTest = process.argv.includes('--self-test');
const vaultRoot = resolve(valueAfter('--vault') || '.');
const obsidianVaultRoot = valueAfter('--obsidian-vault-root') ? resolve(valueAfter('--obsidian-vault-root')) : null;
const initialFile = valueAfter('--file') || 'torture.md';
const outputPath = valueAfter('--output');
const screenshotRoot = valueAfter('--screenshots');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const consoleMessages = { errors: [], warnings: [] };

function safePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error('SW_WORKSPACE_PATH_INVALID');
  }
  const candidate = resolve(vaultRoot, relativePath);
  const rel = relative(vaultRoot, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('SW_WORKSPACE_PATH_OUTSIDE_ROOT');
  return candidate;
}

async function readText(relativePath) {
  const bytes = await readFile(safePath(relativePath));
  return { path: relativePath, content: bytes.toString('utf8'), revision: sha256(bytes) };
}

async function atomicWrite(relativePath, content, expectedRevision) {
  const target = safePath(relativePath);
  const current = await readFile(target);
  const currentRevision = sha256(current);
  if (expectedRevision !== currentRevision) {
    return { ok: false, code: 'SW_WORKSPACE_REVISION_CONFLICT', current: current.toString('utf8'), currentRevision };
  }
  const temporary = join(dirname(target), `.${basename(target)}.superwagie-${process.pid}.tmp`);
  await writeFile(temporary, content, { mode: (await stat(target)).mode });
  await rename(temporary, target);
  const bytes = Buffer.from(content, 'utf8');
  return { ok: true, path: relativePath, revision: sha256(bytes), atomic: true };
}

async function isRealObsidianVault() {
  if (!obsidianVaultRoot) return false;
  const rel = relative(obsidianVaultRoot, vaultRoot);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  try { return (await stat(join(obsidianVaultRoot, '.obsidian'))).isDirectory(); } catch { return false; }
}

protocol.registerSchemesAsPrivileged([{ scheme: 'superwagie-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-sync');

function assertSender(event) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('SW_RENDERER_IDENTITY_REJECTED');
}

async function waitFor(window, expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression, true)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function capture(window, name) {
  await mkdir(screenshotRoot, { recursive: true });
  const image = await window.webContents.capturePage();
  await writeFile(join(screenshotRoot, `${name}.png`), image.toPNG());
}

async function runUiEvidence(window) {
  const realObsidianVault = await isRealObsidianVault();
  await waitFor(window, 'window.__SUPERWAGIE_READY__ === true');
  const runtimeState = await window.webContents.executeJavaScript('window.__superwagieTest.snapshot()', true);
  const livePreviewPresentation = await window.webContents.executeJavaScript(`(
    getComputedStyle(document.querySelector('#live-properties')).display !== 'none'
    && document.querySelector('#live-properties').textContent.includes('custom_plugin_field')
    && Boolean(document.querySelector('.cm-live-heading-1'))
    && [...document.querySelectorAll('.cm-live-frontmatter')].every((line) => getComputedStyle(line).display === 'none')
  )`, true);
  const modes = [];
  for (const mode of ['live', 'reading', 'source']) {
    await window.webContents.executeJavaScript(`window.__superwagieTest.setMode(${JSON.stringify(mode)})`, true);
    await waitFor(window, `document.body.dataset.mode === ${JSON.stringify(mode)}`);
    modes.push(mode);
    await capture(window, mode);
  }

  await window.webContents.executeJavaScript('window.__superwagieTest.setMode("reading")', true);
  await waitFor(window, 'document.querySelector(".sw-image-embed img")?.complete === true && document.querySelector(".sw-image-embed img")?.naturalWidth > 0');
  const reading = await window.webContents.executeJavaScript(`({
    imageLoaded: document.querySelector('.sw-image-embed img')?.naturalWidth > 0,
    documentEmbed: Boolean(document.querySelector('.sw-document-embed')),
    excalidrawEmbed: Boolean(document.querySelector('.sw-excalidraw-embed')),
    wikilinkCount: document.querySelectorAll('.sw-wikilink').length,
    visible: getComputedStyle(document.querySelector('#reading')).display !== 'none'
      && document.querySelector('#reading').getBoundingClientRect().height > 0
      && Boolean(document.querySelector('#reading h1'))
  })`, true);

  const navigated = await window.webContents.executeJavaScript('window.__superwagieTest.openFirstWikiLink()', true);
  await waitFor(window, `window.__superwagieTest.snapshot().path !== ${JSON.stringify(initialFile)}`);
  const wikilinkNavigation = navigated && await window.webContents.executeJavaScript('document.querySelector("h1")?.textContent.includes("核心内容")', true);
  await window.webContents.executeJavaScript(`window.__superwagieTest.open(${JSON.stringify(initialFile)})`, true);
  await waitFor(window, `window.__superwagieTest.snapshot().path === ${JSON.stringify(initialFile)}`);

  await window.webContents.executeJavaScript('window.__superwagieTest.setMode("source")', true);
  const compositionText = '\n中文组合输入验证 👩‍🚀';
  const composition = await window.webContents.executeJavaScript(`window.__superwagieTest.compose(${JSON.stringify(compositionText)})`, true);
  const saveResult = await window.webContents.executeJavaScript('window.__superwagieTest.save()', true);
  window.webContents.reload();
  await waitFor(window, 'window.__SUPERWAGIE_READY__ === true');
  const reopened = await window.webContents.executeJavaScript('window.__superwagieTest.snapshot()', true);
  const savedBytes = await readFile(safePath(initialFile), 'utf8');

  await window.webContents.executeJavaScript('window.__superwagieTest.setMode("source")', true);
  await window.webContents.executeJavaScript(`window.__superwagieTest.append(${JSON.stringify('\n本地未保存修改')})`, true);
  const beforeExternal = await readText(initialFile);
  const externalContent = `${beforeExternal.content}\n外部 Obsidian 模拟修改`;
  await atomicWrite(initialFile, externalContent, beforeExternal.revision);
  await waitFor(window, 'window.__superwagieTest.snapshot().externalChanged === true');
  const staleSave = await window.webContents.executeJavaScript('window.__superwagieTest.save()', true);
  const persistence = await window.webContents.executeJavaScript('window.__superwagieTest.snapshot()', true);

  const result = {
    schema_id: 'superwagie.g1-markdown-editor-ux.macos.v1',
    platform: 'macos-15-arm64',
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, sandbox: runtimeState.sandbox, realObsidianVault },
    ui: {
      codeMirror6: runtimeState.codeMirror6,
      modes,
      readingVisible: reading.visible,
      livePreviewPresentation,
      chineseComposition: composition.compositionEvents === 2 && composition.textPresent,
      imageLoaded: reading.imageLoaded,
      documentEmbed: reading.documentEmbed,
      excalidrawEmbed: reading.excalidrawEmbed,
      wikilinkNavigation: wikilinkNavigation && reading.wikilinkCount > 0,
    },
    persistence: {
      savedAndReopened: saveResult.ok === true && reopened.content.includes('中文组合输入验证'),
      unknownSyntaxPreserved: savedBytes.includes('```unknown-plugin') && savedBytes.includes('custom_plugin_field: keep-me') && savedBytes.includes('<!-- 这是 HTML 注释'),
      externalEditDetected: persistence.externalChanged === true,
      staleSaveRejected: staleSave.code === 'SW_WORKSPACE_REVISION_CONFLICT',
      atomicWrite: saveResult.atomic === true,
    },
    console: consoleMessages,
    screenshots: ['live.png', 'reading.png', 'source.png'],
  };
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

app.whenReady().then(async () => {
  protocol.handle('superwagie-asset', async (request) => {
    try {
      const url = new URL(request.url);
      const relativePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const bytes = await readFile(safePath(relativePath));
      const mime = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.svg', 'image/svg+xml'], ['.webp', 'image/webp']]).get(extname(relativePath).toLowerCase()) || 'application/octet-stream';
      return new Response(bytes, { status: 200, headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  ipcMain.handle('sw:boot', (event) => {
    assertSender(event);
    return { initialFile, sandbox: event.senderFrame.routingId !== undefined };
  });
  ipcMain.handle('sw:read-text', async (event, relativePath) => {
    assertSender(event);
    return readText(relativePath);
  });
  ipcMain.handle('sw:write-text', async (event, payload) => {
    assertSender(event);
    if (!payload || Object.keys(payload).sort().join(',') !== 'content,expectedRevision,path') throw new Error('SW_WORKSPACE_WRITE_SHAPE_INVALID');
    return atomicWrite(payload.path, payload.content, payload.expectedRevision);
  });

  const window = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: !selfTest,
    backgroundColor: '#f7f6f2',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('console-message', (details) => {
    const entry = `${details.message}`;
    if (details.level === 'error') {
      consoleMessages.errors.push(entry);
      console.error(`renderer: ${entry}`);
    }
    if (details.level === 'warning') {
      consoleMessages.warnings.push(entry);
      console.warn(`renderer: ${entry}`);
    }
  });
  const watcher = watch(vaultRoot, { recursive: true }, async (_eventType, filename) => {
    if (!filename || typeof filename !== 'string' || !filename.endsWith('.md')) return;
    try {
      const value = await readText(filename);
      window.webContents.send('sw:file-changed', { path: filename, revision: value.revision });
    } catch { /* deletion is out of scope for this PoC */ }
  });
  window.on('closed', () => watcher.close());
  await window.loadFile(join(import.meta.dirname, '..', 'dist', 'index.html'));
  if (selfTest) {
    try {
      const result = await runUiEvidence(window);
      const pass = Object.values(result.ui).every((value) => Array.isArray(value) ? value.length === 3 : value === true)
        && Object.values(result.persistence).every(Boolean)
        && result.runtime.realObsidianVault === true
        && result.console.errors.length === 0 && result.console.warnings.length === 0;
      watcher.close();
      window.destroy();
      app.exit(pass ? 0 : 1);
    } catch (error) {
      console.error(error?.stack || error);
      watcher.close();
      window.destroy();
      app.exit(2);
    }
  }
});
