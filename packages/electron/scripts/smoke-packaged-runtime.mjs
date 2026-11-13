#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { CdpClient, evaluateValue, findPageTarget, reservePort, wait } from '../../../scripts/perf/cdp.mjs';
import { startPlatformAccountFixture } from '../../../scripts/perf/platform-account-fixture.mjs';
import { desktopOpenCodeProbeEnvironment } from '../../web/server/lib/opencode/desktop-private-runtime.js';
import { readPinnedOpenCodeCliVersion } from './opencode-cli-version.mjs';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  assert(['--app', '--receipt', '--root'].includes(key) && process.argv[index + 1], 'Use --app <packaged app> --receipt <json> [--root <new directory>]');
  options.set(key, process.argv[index + 1]);
}
assert(options.has('--app') && options.has('--receipt'), '--app and --receipt are required');
assert(['darwin', 'win32'].includes(process.platform), 'This check covers macOS and Windows');
const app = path.resolve(options.get('--app'));
assert(existsSync(app), 'Packaged application does not exist');
const executable = process.platform === 'darwin'
  ? path.join(app, 'Contents/MacOS', readdirSync(path.join(app, 'Contents/MacOS'))[0]) : app;
const resources = process.platform === 'darwin' ? path.join(app, 'Contents/Resources') : path.join(path.dirname(app), 'resources');
const engine = path.join(resources, 'opencode-cli', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
assert(existsSync(engine), 'Packaged OpenCode CLI does not exist');
const root = options.has('--root') ? path.resolve(options.get('--root')) : mkdtempSync(path.join(os.tmpdir(), 'superwagie-packaged-'));
if (options.has('--root')) mkdirSync(root, { mode: 0o700 });
const data = path.join(root, 'data'), home = path.join(root, 'home'), project = path.join(root, 'project');
for (const directory of [data, home, project, path.join(root, 'electron')]) mkdirSync(directory, { mode: 0o700 });
const receiptFile = path.resolve(options.get('--receipt'));
mkdirSync(path.dirname(receiptFile), { recursive: true });
const receipt = { platform: process.platform, architecture: process.arch, expectedEngineVersion: readPinnedOpenCodeCliVersion(), passed: false, paidModelRequests: 0,
  limits: ['Existing history is seeded with this package engine before cold launch', 'Cross-version recovery, installer GUI, automatic recovery and real billing require separate evidence'] };
const checkpoint = (stage) => { receipt.stage = stage; writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); console.log(`Packaged runtime: ${stage}`); };
const until = async (operation, timeout = 120_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const result = await operation(); if (result) return result; } catch { /* Poll only inside the bounded readiness phase. */ } await wait(200); }
  throw new Error('Packaged runtime readiness timed out');
};
const stopped = (child) => !child || child.exitCode !== null || child.signalCode !== null;
const stop = async (child, grace = 5000) => {
  if (stopped(child)) return;
  child.kill('SIGTERM');
  await until(() => stopped(child), grace).catch(() => child.kill('SIGKILL'));
  await until(() => stopped(child), 5000);
};
let seedChild, appChild, cdp, fixture;
try {
  checkpoint('private history seed');
  process.env.OPENCHAMBER_DATA_DIR = data;
  const seedEnv = desktopOpenCodeProbeEnvironment(process.env);
  const password = randomBytes(32).toString('base64url');
  seedEnv.OPENCODE_PASSWORD = password;
  seedEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({ update: 'disable', share: 'disabled', snapshots: false });
  const seedPort = await reservePort();
  seedChild = spawn(engine, ['serve', '--hostname', '127.0.0.1', '--port', String(seedPort)], { cwd: project, env: seedEnv, windowsHide: true, stdio: 'ignore' });
  const seedSdk = OpenCode.make({ baseUrl: `http://127.0.0.1:${seedPort}`, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
  const seedInfo = await until(() => seedSdk.server.info());
  assert.equal(seedInfo.version, receipt.expectedEngineVersion);
  const title = 'Packaged cold start history fixture', note = 'Local synthetic history retained without a model request';
  const session = await seedSdk.session.create({ title, location: { directory: project } });
  const seedCommand = process.platform === 'win32' ? `Write-Output '${note}'` : `printf '%s' '${note}'`;
  await seedSdk.session.shell({ sessionID: session.id, command: seedCommand });
  await until(async () => JSON.stringify((await seedSdk.message.list({ sessionID: session.id })).data).includes(note));
  await stop(seedChild); seedChild = null;
  receipt.historySeedEngineVersion = seedInfo.version; receipt.historySeedKind = 'shell-command';
  fixture = await startPlatformAccountFixture();
  const port = await reservePort(), debugPort = await reservePort();
  writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ desktopLocalPort: port, embeddedKnowledgePort: await reservePort(), desktopLanAccessEnabled: false, desktopCloseAction: 'quit', lastDirectory: project }));
  const environment = { ...desktopOpenCodeProbeEnvironment(process.env), ...fixture.env, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCHAMBER_DESKTOP_USER_DATA_DIR: path.join(root, 'electron'), OPENCHAMBER_RELAY_HOST: 'off' };
  if (process.platform === 'darwin') { environment.SHELL = '/bin/zsh'; environment.ZDOTDIR = home; }
  checkpoint('packaged cold launch');
  appChild = spawn(executable, [`--remote-debugging-port=${debugPort}`, '--disable-features=MacAppCodeSignClone'], { cwd: project, env: environment, windowsHide: true, stdio: 'ignore' });
  const target = await until(async () => { assert(!stopped(appChild)); const page = await findPageTarget(debugPort); return page.url.startsWith('openchamber-ui://app/') && !page.url.includes('__splash') && page; });
  cdp = new CdpClient(target.webSocketDebuggerUrl); await cdp.connect();
  let rendererFailure = false;
  cdp.on('Runtime.exceptionThrown', () => { rendererFailure = true; });
  cdp.on('Runtime.consoleAPICalled', event => { if (event.args.some(argument => argument.value === 'Error caught by boundary:')) rendererFailure = true; });
  await cdp.send('Runtime.enable', {}, { timeoutMs: 10_000 });
  const ui = await until(() => evaluateValue(cdp, `(() => ({packaged:location.origin==='openchamber-ui://app',mounted:[...(document.querySelector('#root')?.children??[])].some(element=>Object.keys(element).some(key=>key.startsWith('__reactFiber'))),textLength:document.body?.innerText.length??0,bridge:!!window.__OPENCHAMBER_DESKTOP__,vite:[...document.scripts].some(script=>script.src.includes('/@vite/client'))}))()`)
    .then(value => value?.mounted && value.textLength > 10 && value));
  assert.equal(ui.packaged, true); assert.equal(ui.bridge, true); assert.equal(ui.vite, false);
  receipt.packagedRenderer = ui;
  // Runtime credentials stay inside the application page. Only these test API results cross CDP.
  const rendererFetch = async (pathname, init = {}) => {
    const result = await evaluateValue(cdp, `(async()=>{const c=window.__OPENCHAMBER_READ_RUNTIME_CONFIG__?.()??{};const base=window.__OPENCHAMBER_API_BASE_URL__||c.apiBaseUrl||window.__OPENCHAMBER_LOCAL_ORIGIN__||c.localOrigin;const token=window.__OPENCHAMBER_CLIENT_TOKEN__||c.clientToken;if(!base||!token)throw new Error('Runtime authentication unavailable');const options=${JSON.stringify(init)};const response=await fetch(new URL(${JSON.stringify(pathname)},base),{...options,headers:{...options.headers,'Content-Type':'application/json',Authorization:'Bearer '+token}});return{status:response.status,text:await response.text()}})()`);
    assert(result && Number.isInteger(result.status), 'Renderer API call failed');
    return new Response(result.status === 204 ? null : result.text, { status: result.status, headers: { 'Content-Type': 'application/json' } });
  };
  checkpoint('existing account login');
  assert.equal((await rendererFetch('/api/info')).status, 401, 'Signed-out business API must remain gated');
  const login = await rendererFetch('/api/platform-account/password-login', { method: 'POST', body: JSON.stringify({ username: fixture.username, password: fixture.password }) });
  assert.equal(login.status, 200); assert.equal((await login.json()).status, 'signed-in');
  const selection = await rendererFetch('/api/platform-account/account', { method: 'PUT', body: JSON.stringify({ accountId: fixture.accountId }) });
  assert.equal(selection.status, 200);
  await cdp.send('Page.reload', {}, { timeoutMs: 10_000 });
  receipt.authenticatedAppMounted = await until(() => evaluateValue(cdp, `Boolean([...(document.querySelector('#root')?.children??[])].some(element=>Object.keys(element).some(key=>key.startsWith('__reactFiber')))&&document.body?.innerText.length>10&&!document.getElementById('initial-loading')&&!document.querySelector('#platform-account-gate-title')&&!document.querySelector('input[type="password"]'))`));
  const sdk = OpenCode.make({ baseUrl: 'http://packaged-runtime.invalid', fetch: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    const options = { method: request.method };
    if (request.body) options.body = await request.text();
    if (request.headers.has('x-opencode-directory')) options.headers = { 'x-opencode-directory': request.headers.get('x-opencode-directory') };
    return rendererFetch(url.pathname + url.search, options);
  } });
  checkpoint('authenticated engine and history readback');
  const info = await sdk.server.info(); assert.equal(info.version, receipt.expectedEngineVersion);
  const restored = await sdk.session.get({ sessionID: session.id });
  assert.equal(restored.title, title); assert.equal(path.resolve(restored.location.directory), project);
  assert(JSON.stringify((await sdk.message.list({ sessionID: session.id })).data).includes(note));
  receipt.engineVersion = info.version; receipt.existingSessionAndSyntheticHistoryRead = true; receipt.signedOutBusinessApiRefused = true;
  if (process.platform === 'win32') {
    checkpoint('Windows multiline PowerShell');
    const command = "$ErrorActionPreference = 'Stop'\r\n$items = @('first-line', '犇马✓')\r\n$items | ForEach-Object { [Console]::WriteLine($_) }\r\nexit 0";
    const created = await sdk.shell.create({ command, cwd: project, location: { directory: project }, metadata: { sessionID: session.id } });
    try {
      const shell = await until(async () => { const value = (await sdk.shell.get({ id: created.data.id, location: { directory: project } })).data; return value.status !== 'running' && value; }, 30_000);
      const output = (await sdk.shell.output({ id: shell.id, location: { directory: project }, cursor: 0 })).data.output;
      assert(/powershell|pwsh/i.test(shell.shell)); assert.equal(shell.status, 'exited'); assert.equal(shell.exit, 0);
      assert(output.includes('first-line') && output.includes('犇马✓'));
      receipt.multilinePowerShell = { status: shell.status, exit: shell.exit, unicodeOutput: true };
    } finally { await sdk.shell.remove({ id: created.data.id, location: { directory: project } }); }
  }
  checkpoint('native quit');
  assert.equal(rendererFailure, false, 'Packaged renderer raised an exception or root error boundary');
  receipt.rendererFatalErrorObserved = false;
  await evaluateValue(cdp, "void window.__OPENCHAMBER_DESKTOP__.quitApp()").catch(() => {});
  await until(() => stopped(appChild), 40_000);
  assert.equal(appChild.exitCode, 0);
  await until(() => new Promise(resolve => { const socket = connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', () => resolve(true)); socket.setTimeout(1000, () => { socket.destroy(); resolve(false); }); }), 5000);
  receipt.nativeQuit = true; receipt.backendPortClosed = true; receipt.passed = true;
} catch {
  receipt.failedStage = receipt.stage;
  receipt.failure = 'The recorded stage failed'; process.exitCode = 1;
} finally {
  cdp?.close();
  await stop(seedChild).catch(() => { receipt.cleanupFailed = true; process.exitCode = 1; });
  await stop(appChild).catch(() => { receipt.cleanupFailed = true; process.exitCode = 1; });
  await fixture?.stop().catch(() => { receipt.cleanupFailed = true; process.exitCode = 1; });
  if (receipt.cleanupFailed) receipt.passed = false;
  checkpoint(receipt.passed ? 'passed' : 'failed');
}
