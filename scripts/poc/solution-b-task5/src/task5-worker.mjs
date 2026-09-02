import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => value === null ? 'null'
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value);

function emitReceipt(receipt) {
  const key = process.env.SUPERWAGIE_WORKER_KEY;
  if (!key) throw new Error('WORKER_KEY_REQUIRED');
  process.stdout.write(`${JSON.stringify({ receipt, mac: createHmac('sha256', key).update(canonical(receipt)).digest('hex') })}\n`);
}

async function installer() {
  const action = arg('--action');
  const store = resolve(arg('--store'));
  const source = arg('--source') ? resolve(arg('--source')) : null;
  const extensionId = 'task5.fixture.skill';
  mkdirSync(store, { recursive: true, mode: 0o700 });
  let version = arg('--version');
  if (action === 'install') {
    const manifest = JSON.parse(readFileSync(join(source, 'extension.json'), 'utf8'));
    if (manifest.type !== 'skill' || manifest.id !== extensionId || manifest.version !== version) throw new Error('INSTALL_MANIFEST_REJECTED');
    const staging = join(store, `.staging-${process.pid}-${version}`);
    mkdirSync(staging, { mode: 0o700 });
    cpSync(join(source, 'extension.json'), join(staging, 'extension.json'), { errorOnExist: true });
    cpSync(join(source, 'payload.txt'), join(staging, 'payload.txt'), { errorOnExist: true });
    const destination = join(store, `version-${version}`);
    if (existsSync(destination)) rmSync(destination, { recursive: true });
    renameSync(staging, destination);
    writeFileSync(join(store, 'current'), `${version}\n`, { mode: 0o600 });
  } else if (action === 'select') {
    if (!existsSync(join(store, `version-${version}`, 'extension.json'))) throw new Error('ROLLBACK_VERSION_MISSING');
    writeFileSync(join(store, 'current'), `${version}\n`, { mode: 0o600 });
  } else if (action === 'remove') {
    rmSync(store, { recursive: true });
    version = null;
  } else throw new Error('INSTALL_ACTION_REJECTED');
  emitReceipt({ schema: 'task5-installer-receipt-v1', action, extension_id: extensionId, version,
    pid: process.pid, ppid: process.ppid, executable: process.execPath,
    env_names: Object.keys(process.env).sort(), store_basename: basename(store),
    current: action === 'remove' ? null : readFileSync(join(store, 'current'), 'utf8').trim() });
}

async function extension() {
  const store = resolve(arg('--store'));
  const outside = resolve(arg('--outside-canary'));
  const core = resolve(arg('--core'));
  const version = readFileSync(join(store, 'current'), 'utf8').trim();
  const manifest = JSON.parse(readFileSync(join(store, `version-${version}`, 'extension.json'), 'utf8'));
  let outsideFileDenied = false;
  try { readFileSync(outside); } catch { outsideFileDenied = true; }
  let networkDenied = false;
  try { await fetch('http://127.0.0.1:9/task5', { signal: AbortSignal.timeout(750) }); } catch { networkDenied = true; }
  const directCore = await new Promise((resolvePromise) => {
    let child;
    try { child = spawn(core, [], { stdio: 'ignore', env: {} }); }
    catch (error) { resolvePromise({ denied: true, error: error.code ?? error.message, pid: null }); return; }
    child.once('error', (error) => resolvePromise({ denied: true, error: error.code ?? error.message, pid: child.pid ?? null }));
    child.once('exit', (code, signal) => resolvePromise({ denied: code !== 0, code, signal, pid: child.pid }));
  });
  const request = { type: 'facade_request', protocol: 'task5-public-facade-v1', request_id: `ext-${process.pid}`,
    extension_id: manifest.id, command_type: 'artifact.read_metadata', payload: { artifact_id: 'artifact:task5' } };
  process.stdout.write(`${JSON.stringify(request)}\n`);
  const lines = createInterface({ input: process.stdin });
  const response = await new Promise((resolvePromise) => lines.once('line', (line) => resolvePromise(JSON.parse(line))));
  lines.close();
  const facadeOk = response.request_id === request.request_id && response.ok === true
    && response.facade_token === process.env.SUPERWAGIE_FACADE_TOKEN;
  emitReceipt({ schema: 'task5-extension-receipt-v1', extension_id: manifest.id, version,
    pid: process.pid, ppid: process.ppid, executable: process.execPath,
    env_names: Object.keys(process.env).sort(), outside_file_denied: outsideFileDenied,
    network_denied: networkDenied, direct_core_denied: directCore.denied, direct_core_attempt: directCore,
    facade_request_count: 1, facade_ok: facadeOk,
    payload_sha256: sha256(readFileSync(join(store, `version-${version}`, 'payload.txt'))) });
}

async function canaryServer() {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ type: 'canary_ready', pid: process.pid, port: server.address().port })}\n`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

async function securityProbe() {
  const root = resolve(arg('--root'));
  const relativePath = arg('--path');
  const securityModule = resolve(arg('--security-module'));
  let rejected = false;
  let errorCode = null;
  try {
    const { secureReadByFd } = await import(securityModule);
    secureReadByFd(root, relativePath, 128 * 1024);
  } catch (error) {
    rejected = true;
    errorCode = error?.message ?? String(error);
  }
  emitReceipt({ schema: 'task5-security-probe-receipt-v1', probe: 'secure-read-symlink-manifest',
    pid: process.pid, ppid: process.ppid, executable: process.execPath,
    security_module: securityModule, rejected, error_code: errorCode });
}

const mode = arg('--mode');
if (mode === 'installer') await installer();
else if (mode === 'extension') await extension();
else if (mode === 'canary-server') await canaryServer();
else if (mode === 'security-probe') await securityProbe();
else throw new Error('WORKER_MODE_REJECTED');
