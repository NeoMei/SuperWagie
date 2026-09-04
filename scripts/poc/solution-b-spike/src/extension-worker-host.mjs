import { app, BrowserWindow, ipcMain, session } from 'electron';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from './core-client.mjs';
import { isExactDocumentUrl, validateExtensionManifest } from './extension-worker-policy.mjs';
import { secureAtomicWrite, secureCopyByFd, secureMkdirs, secureReadByFd } from './secure-files.mjs';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const debug = (message) => { if (process.env.SUPERWAGIE_EXTENSION_DEBUG === '1') process.stderr.write(`EXTENSION_DEBUG:${message}\n`); };

function emitReceipt(receipt) {
  const key = process.env.SUPERWAGIE_WORKER_KEY;
  if (!key) throw new Error('WORKER_KEY_REQUIRED');
  const mac = createHmac('sha256', key).update(canonicalJson(receipt)).digest('hex');
  process.stdout.write(`${JSON.stringify({ receipt, mac })}\n`);
}

function runInstaller() {
  const action = argument('--action');
  const store = resolve(argument('--store'));
  const source = argument('--source') ? resolve(argument('--source')) : null;
  let version = argument('--version');
  secureMkdirs(dirname(store), basename(store));
  if (action === 'install') {
    const manifestBytes = secureReadByFd(source, 'extension.json', 64 * 1024);
    validateExtensionManifest(JSON.parse(manifestBytes), version);
    const stagingName = `.staging-${process.pid}-${version}`;
    secureMkdirs(store, stagingName);
    secureCopyByFd(source, 'extension.json', store, `${stagingName}/extension.json`);
    secureCopyByFd(source, 'payload.txt', store, `${stagingName}/payload.txt`);
    const destination = join(store, `version-${version}`);
    if (existsSync(destination)) {
      rmSync(join(store, stagingName), { recursive: true });
      throw new Error('INSTALL_VERSION_ALREADY_EXISTS');
    }
    // Both paths are private children of the already validated store root.
    renameSync(join(store, stagingName), destination);
    secureAtomicWrite(store, 'current', Buffer.from(`${version}\n`));
  } else if (action === 'select') {
    const manifest = JSON.parse(secureReadByFd(store, `version-${version}/extension.json`, 64 * 1024));
    validateExtensionManifest(manifest, version);
    secureAtomicWrite(store, 'current', Buffer.from(`${version}\n`));
  } else if (action === 'remove') {
    rmSync(store, { recursive: true });
    version = null;
  } else throw new Error('INSTALL_ACTION_REJECTED');
  emitReceipt({ schema: 'task5-installer-receipt-v1', action, extension_id: 'task5.fixture.skill', version,
    pid: process.pid, ppid: process.ppid, executable: process.execPath,
    env_names: Object.keys(process.env).sort(), store_basename: basename(store),
    current: action === 'remove' ? null : secureReadByFd(store, 'current', 128).toString('utf8').trim(),
    isolation: 'trusted-candidate-installer-with-handle-relative-filesystem' });
  app.exit(0);
}

function fixedShapeProbe(value) {
  const keys = ['direct_core_api_absent', 'facade_ok', 'network_denied', 'node_denied', 'outside_file_denied'];
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === keys.sort().join('\0')
    && keys.every((key) => typeof value[key] === 'boolean');
}

async function runExtension() {
  debug('start');
  const store = resolve(argument('--store'));
  const outside = resolve(argument('--outside-canary'));
  const core = resolve(argument('--core'));
  const version = secureReadByFd(store, 'current', 128).toString('utf8').trim();
  const manifest = JSON.parse(secureReadByFd(store, `version-${version}/extension.json`, 64 * 1024));
  validateExtensionManifest(manifest, version);
  const payloadHash = sha256(secureReadByFd(store, `version-${version}/payload.txt`, 64 * 1024));

  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
  app.commandLine.appendSwitch('no-proxy-server');
  await app.whenReady();
  debug('app-ready');
  const partition = `extension-worker-${process.pid}`;
  const ses = session.fromPartition(partition, { cache: false });
  const outsideUrl = pathToFileURL(outside).href;
  const workerDocument = join(import.meta.dirname, 'static', 'extension-worker.html');
  const workerDocumentUrl = pathToFileURL(workerDocument).href;
  const isWorkerDocument = (url) => isExactDocumentUrl(url, workerDocumentUrl);
  let blockedRequests = 0;
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.on('will-download', (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const allowed = isWorkerDocument(details.url);
    if (!allowed) blockedRequests += 1;
    callback({ cancel: !allowed });
  });
  debug('session-ready');

  let facadeCount = 0;
  let facadeRequest = null;
  let probeResolve;
  const probe = new Promise((resolvePromise) => { probeResolve = resolvePromise; });
  let rendererPid = null;
  ipcMain.handle('extension:capability', async (event, request) => {
    if (!isWorkerDocument(event.senderFrame.url) || facadeCount !== 0
      || request?.type !== 'facade_request' || request?.extension_id !== manifest.id
      || request?.command_type !== 'artifact.read_metadata') throw new Error('FACADE_REQUEST_REJECTED');
    if (!process.env.SUPERWAGIE_FACADE_TOKEN) throw new Error('FACADE_TOKEN_REQUIRED');
    facadeCount += 1;
    facadeRequest = request;
    return { artifact_id: 'artifact:task5', source: 'public-capability-facade' };
  });
  ipcMain.handle('extension:complete-probe', (event, result) => {
    debug('probe-complete');
    if (!isWorkerDocument(event.senderFrame.url) || !fixedShapeProbe(result)) throw new Error('EXTENSION_PROBE_REJECTED');
    probeResolve(result);
    return true;
  });
  const worker = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true,
    contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false,
    preload: join(import.meta.dirname, 'extension-worker-preload.cjs') } });
  worker.webContents.on('preload-error', (_event, _path, error) => process.stderr.write(`EXTENSION_PRELOAD_ERROR:${error.message}\n`));
  worker.webContents.on('render-process-gone', (_event, details) => process.stderr.write(`EXTENSION_RENDERER_GONE:${details.reason}\n`));
  worker.webContents.on('did-fail-load', (_event, code) => process.stderr.write(`EXTENSION_LOAD_FAILED:${code}\n`));
  worker.webContents.on('console-message', (_event, details) => process.stderr.write(`EXTENSION_CONSOLE:${details.level}:${details.message}\n`));
  worker.webContents.on('will-navigate', (event) => event.preventDefault());
  worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  debug('load-start');
  await worker.loadFile(workerDocument, { query: { extensionId: manifest.id, outsideUrl } });
  debug('load-complete');
  rendererPid = worker.webContents.getOSProcessId();
  const result = await Promise.race([probe, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('EXTENSION_PROBE_TIMEOUT')), 15_000))]);
  emitReceipt({ schema: 'task5-extension-receipt-v1', extension_id: manifest.id, version,
    pid: process.pid, ppid: process.ppid, renderer_pid: rendererPid, executable: process.execPath,
    env_names: Object.keys(process.env).sort(), outside_file_denied: result.outside_file_denied,
    network_denied: result.network_denied && blockedRequests > 0,
    direct_core_denied: result.direct_core_api_absent, direct_core_attempt: { denied: result.direct_core_api_absent, api_absent: true, path_hash: sha256(Buffer.from(core)) },
    facade_request_count: facadeCount, facade_ok: result.facade_ok,
    facade_request: facadeRequest,
    payload_sha256: payloadHash, sandbox_type: 'electron-chromium-renderer',
    web_preferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  worker.destroy();
  await ses.clearStorageData();
  app.quit();
}

const mode = argument('--mode');
const fail = (error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  app.exit(1);
};
try {
  if (mode === 'installer') runInstaller();
  else if (mode === 'extension') runExtension().catch(fail);
  else throw new Error('WORKER_MODE_REJECTED');
} catch (error) {
  fail(error);
}
