import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { CdpClient, reservePort, wait } from './perf/cdp.mjs';

const options = new Map(process.argv.slice(2).map(argument => {
  const match = /^--(app|receipt|source)=(.+)$/.exec(argument);
  assert(match, `Unsupported argument: ${argument}`);
  return [match[1], match[1] === 'source' ? match[2] : path.resolve(match[2])];
}));
assert(options.has('app') && options.has('receipt'), '--app and --receipt are required');
assert.equal(process.platform, 'darwin');
const executable = path.join(options.get('app'), 'Contents/MacOS/犇马');
const repository = process.cwd();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'superwagie-intel-local-'));
const testSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim();
const sourceCommit = options.get('source') || testSourceCommit;
assert.match(sourceCommit, /^[a-f0-9]{40}$/);
const receipt = { version: '2.7.40-intel', mode: 'local', sourceCommit, testSourceCommit, testScriptSha256: crypto.createHash('sha256').update(await fs.readFile(new URL(import.meta.url))).digest('hex'), hostArchitecture: process.arch, hostRelease: os.release(), checks: [], passed: false, startedAt: new Date().toISOString(), progress: [] };
const groups = new Set();
const owned = new Map();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const processes = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
  return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), command: match[4] };
});

function collectOwned() {
  const rows = processes();
  for (const root of groups) {
    const ids = new Set(rows.filter(row => owned.get(row.pid)?.root === root && owned.get(row.pid).command === row.command).map(row => row.pid));
    if (!owned.has(root)) ids.add(root);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
    }
    for (const row of rows) if (ids.has(row.pid)) owned.set(row.pid, { ...row, root });
  }
  return rows.filter(row => owned.get(row.pid)?.command === row.command);
}

async function until(operation, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    collectOwned();
    checkpoint();
    try { const result = await operation(); if (result) return result; } catch (error) { lastError = error; }
    await wait(250);
  }
  throw new Error('Intel smoke timed out', { cause: lastError });
}

async function stopGroup(group) {
  checkpoint(`stop.${group}.begin`);
  const ownedRoot = collectOwned().some(row => row.pid === group);
  // Allow the backend and managed engine to finish their bounded shutdown.
  if (ownedRoot && alive(group)) {
    process.kill(group, 'SIGTERM');
    const deadline = Date.now() + 40_000;
    while (alive(group) && Date.now() < deadline) { collectOwned(); checkpoint(); await wait(200); }
  }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const rows = collectOwned().filter(row => owned.get(row.pid).root === group);
    if (!rows.length) break;
    for (const processGroup of new Set(rows.map(row => row.group))) {
      assert.notEqual(processGroup, processes().find(row => row.pid === process.pid).group);
      try { process.kill(-processGroup, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await wait(signal === 'SIGTERM' ? 2500 : 500);
  }
  assert(!collectOwned().some(row => owned.get(row.pid).root === group), `Owned process tree ${group} survived`);
  checkpoint(`stop.${group}.complete`);
}

const enginePassword = crypto.randomBytes(32).toString('base64url');
const logs = new Map();
const redact = text => text.split(enginePassword).join('[redacted]').split('\n').map(line => /password|authorization|bearer|client.?token|api.?key|private.?key|access.?token|refresh.?token|cookie|oc_client_/i.test(line) ? '[redacted runtime authentication log]' : line).join('\n');

const receiptFile = options.get('receipt');
const logFile = `${receiptFile}.log`;
const mainLogLines = new Map();
let lastCheckpointAt = 0;
const diagnosticFailure = error => { receipt.diagnosticsError = redact(error.message); receipt.passed = false; process.exitCode = 1; };
const appendLog = text => { try { appendFileSync(logFile, text, { mode: 0o600 }); } catch (error) { diagnosticFailure(error); } };

// The CI step can be terminated before finally runs. Persist complete safe
// receipts and logs during the run so its last completed boundary survives.
function checkpoint(stage) {
  const now = Date.now();
  if (!stage && now - lastCheckpointAt < 1000) return;
  const at = new Date(now).toISOString();
  if (stage) { receipt.stage = stage; receipt.progress.push({ stage, at }); }
  receipt.updatedAt = at;
  try {
    mkdirSync(path.dirname(receiptFile), { recursive: true });
    for (const name of ['packaged', 'hmr']) {
      try {
        const lines = readFileSync(path.join(root, name, 'Library/Logs/SuperWagie/main.log'), 'utf8').split('\n');
        lines.pop();
        const previous = mainLogLines.get(name) || 0;
        if (lines.length > previous) appendLog(`[${name}/main.log]\n${redact(lines.slice(previous).join('\n'))}\n`);
        mainLogLines.set(name, lines.length);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const temporary = `${receiptFile}.pending`;
    writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, receiptFile);
    lastCheckpointAt = now;
  } catch (error) { diagnosticFailure(error); }
  if (stage) console.log(`[intel-local] ${stage}`);
}

async function profile(name) {
  const home = path.join(root, name), data = path.join(home, '.config/openchamber');
  const userData = path.join(home, 'userData');
  for (const directory of [home, data, userData, path.join(home, 'tmp'), path.join(home, 'Library/Logs/SuperWagie')]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const port = await reservePort(), opencodePort = await reservePort(), knowledgePort = await reservePort();
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ desktopLocalPort: port, desktopLanAccessEnabled: false, desktopCloseAction: 'quit', embeddedKnowledgePort: knowledgePort }));
  const environment = {
    PATH: process.env.PATH, USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: 'en_US.UTF-8',
    HOME: home, USERPROFILE: home, TMPDIR: path.join(home, 'tmp'), SHELL: '/bin/zsh', ZDOTDIR: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCHAMBER_DATA_DIR: data, OPENCHAMBER_DESKTOP_USER_DATA_DIR: userData,
    OPENCHAMBER_RELAY_HOST: 'off', OPENCHAMBER_SKIP_LOCAL_SERVER: '0',
    OPENCHAMBER_OPENCODE_HOSTNAME: '127.0.0.1', OPENCODE_PORT: String(opencodePort), OPENCODE_SERVER_PASSWORD: enginePassword,
    OPENCHAMBER_UNIHUB_ISSUER: 'http://127.0.0.1:9', OPENCHAMBER_UNIHUB_API_URL: 'http://127.0.0.1:9',
    OPENCHAMBER_UNIHUB_CONSOLE_URL: 'http://127.0.0.1:9', OPENCHAMBER_UNIHUB_GATEWAY_URL: 'http://127.0.0.1:9/platform/v1',
  };
  assert(!Object.hasOwn(environment, 'OPENCODE_SKIP_START'));
  return { home, data, port, opencodePort, knowledgePort, environment };
}

async function launch(configuration, debugPort, name, hmr = false) {
  checkpoint(`${name}.launch`);
  const command = hmr ? process.execPath : executable;
  const arguments_ = hmr ? [path.join(repository, 'packages/electron/scripts/electron-dev.mjs')] : [`--remote-debugging-port=${debugPort}`];
  const child = spawn(command, arguments_, { cwd: repository, env: configuration.environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const spawned = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  logs.set(name, []);
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => {
    const safe = redact(line);
    logs.get(name).push(safe);
    appendLog(`[${name}] ${safe}\n`);
  });
  await spawned;
  groups.add(child.pid);
  checkpoint(`${name}.spawned`);
  return child;
}

async function inspect(child, configuration, debugPort, name, hmr = false) {
  checkpoint(`${name}.health`);
  const health = await until(async () => {
    assert(alive(child.pid), 'Owned application exited before local health');
    const response = await fetch(`http://127.0.0.1:${configuration.port}/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const value = await response.json();
    return { status: response.status, service: value.service, version: value.version, statusField: value.status };
  });
  checkpoint(`${name}.target`);
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) });
    return (await response.json()).find(target => target.type === 'page' && !target.url.includes('__splash') && !target.url.startsWith('devtools://'));
  });
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    checkpoint(`${name}.cdp-connect`);
    let connectTimer;
    try {
      await Promise.race([client.connect(), new Promise((_, reject) => { connectTimer = setTimeout(() => reject(new Error('CDP connection did not open within 10s')), 10_000); })]);
    } finally { clearTimeout(connectTimer); }
    checkpoint(`${name}.ui`);
    const ui = await until(async () => {
      const response = await client.send('Runtime.evaluate', { expression: `(() => ({url:location.href, mounted:[...(document.querySelector('#root')?.children??[])].some(element=>Object.keys(element).some(key=>key.startsWith('__reactFiber'))), textLength:document.body?.innerText.length??0, vite:[...document.scripts].some(script=>script.src.includes('/@vite/client')), bridge:!!window.__OPENCHAMBER_DESKTOP__, loginForm:!!document.querySelector('input[type="password"]'),accountGate:!!document.querySelector('#platform-account-gate-title'),readyState:document.readyState,hasApi:!!window.__OPENCHAMBER_API_BASE_URL__}))()`, returnByValue: true }, { timeoutMs: 10_000 });
      const summary = response.result?.value;
      receipt.lastUi = { name, ...summary };
      checkpoint();
      return summary?.mounted && summary.textLength > 10 && (hmr ? summary.accountGate : summary.loginForm) && summary;
    });
    assert.equal(ui.bridge, true); assert.equal(ui.vite, hmr);
    assert.equal(new URL(ui.url).protocol, hmr ? 'http:' : 'openchamber-ui:');
    checkpoint(`${name}.hosts`);
    const hosts = await client.send('Runtime.evaluate', { expression: `window.__OPENCHAMBER_DESKTOP__.invoke('desktop_hosts_get',{}).then(value=>({localOrigin:value.localOrigin,defaultHostId:value.defaultHostId}))`, returnByValue: true, awaitPromise: true }, { timeoutMs: 10_000 });
    assert(!hosts.exceptionDetails);
    assert.equal(new URL(hosts.result.value.localOrigin).origin, `http://127.0.0.1:${configuration.port}`);
    checkpoint(`${name}.account-gate`);
    const gate = await client.send('Runtime.evaluate', { expression: `fetch(new URL('/api/opencode/health',window.__OPENCHAMBER_API_BASE_URL__||window.__OPENCHAMBER_LOCAL_ORIGIN__),{headers:{Authorization:'Bearer '+window.__OPENCHAMBER_CLIENT_TOKEN__}}).then(async response=>({status:response.status,body:await response.json()}))`, returnByValue: true, awaitPromise: true }, { timeoutMs: 10_000 });
    assert(!gate.exceptionDetails);
    assert.equal(gate.result.value.status, hmr ? 409 : 401);
    assert.equal(gate.result.value.body.error, hmr ? 'platform_runtime_unsupported' : 'platform_session_expired');
    checkpoint(`${name}.engine`);
    const engine = hmr ? { skipped: true, reason: 'Development uses the explicit skip-start fixture; managed compatibility engine is exercised by both packaged launches' } : await until(async () => {
      const response = await fetch(`http://127.0.0.1:${configuration.opencodePort}/api/info`, { headers: { Authorization: `Basic ${Buffer.from(`opencode:${enginePassword}`).toString('base64')}` }, signal: AbortSignal.timeout(1000) });
      if (!response.ok) return null;
      const info = await response.json();
      assert.equal(info.version.replace(/^v/, ''), '2.1.4');
      const rows = collectOwned();
      assert(rows.some(row => row.pid === info.pid && owned.get(row.pid).root === child.pid), 'Engine PID must belong to this application');
      assert(rows.some(row => owned.get(row.pid).root === child.pid && row.command.includes('/opencode-cli/')), 'The bundled compatibility engine was not launched');
      return { status: response.status, version: info.version, pid: info.pid, ownedByApplication: true, packagedRuntime: true };
    });
    checkpoint(`${name}.knowledge`);
    const knowledge = hmr ? { skipped: true, reason: 'Packaged backend is verified in both packaged launches' } : await until(async () => {
      const response = await fetch(`http://127.0.0.1:${configuration.knowledgePort}/health`, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) return null;
      const value = await response.json();
      assert.equal(value.status, 'ok');
      const rows = collectOwned();
      assert(rows.some(row => owned.get(row.pid).root === child.pid && row.command.includes('/embedded-knowledge/embedded-knowledge-server')), 'The local knowledge backend must belong to the application');
      return { status: response.status, healthy: true, ownedByApplication: true };
    });
    checkpoint(`${name}.screenshot`);
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 10_000 });
    await fs.writeFile(`${options.get('receipt')}.${name}.png`, Buffer.from(screenshot.data, 'base64'));
    receipt.checks.push({ name, health, ui, localOrigin: hosts.result.value.localOrigin, signedOutGate: gate.result.value, engine, knowledge });
    checkpoint(`${name}.verified`);
  } catch (error) {
    try { const screenshot = await client.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 10_000 }); await fs.writeFile(`${options.get('receipt')}.${name}.failure.png`, Buffer.from(screenshot.data, 'base64')); } catch {}
    throw error;
  } finally { client.close(); }
}

try {
  await fs.mkdir(path.dirname(options.get('receipt')), { recursive: true });
  writeFileSync(logFile, '', { mode: 0o600 });
  checkpoint('runtime-probe');
  assert.equal(alive(999999999), false);
  const probe = path.join(root, 'runtime-probe.cjs');
  await fs.writeFile(probe, `
    const assert = require('node:assert/strict');
    const {DatabaseSync} = require('node:sqlite');
    assert.equal(process.arch, 'x64'); assert.equal(process.versions.electron, '43.8.4');
    assert.equal(process.versions.node, '24.22.1'); assert.equal(process.versions.modules, '148');
    const database = new DatabaseSync(':memory:'); database.exec('BEGIN EXCLUSIVE; ROLLBACK'); database.close();
    console.log(JSON.stringify({architecture:process.arch,electron:process.versions.electron,node:process.versions.node,abi:process.versions.modules,sqlite:true}));
  `);
  const configuration = await profile('packaged');
  receipt.runtime = JSON.parse(execFileSync(executable, [probe], { encoding: 'utf8', timeout: 20_000, env: { ...configuration.environment, ELECTRON_RUN_AS_NODE: '1' } }));
  checkpoint('runtime-probe.complete');
  const store = path.join(configuration.data, 'unihub-model');
  await fs.mkdir(store, { mode: 0o700 });
  const stateFile = path.join(store, 'state.json'), lockFile = path.join(store, 'writer.lock');
  const guardFile = path.join(store, 'writer-guard.sqlite');
  const before = Buffer.from(JSON.stringify({ version: 1,
    tasks: { session: { id: 'task', sessionID: 'session', actorID: 'actor', accountID: 'account', owner: 'owner', model: 'fixture' } },
    calls: { fixture: { id: 'fixture', sessionID: 'session', taskID: 'task', model: 'fixture', digest: 'fixture-request', status: 'UNKNOWN', output: true } },
  }));
  await fs.writeFile(stateFile, before, { mode: 0o600 });
  const originalOwner = `999999999:${crypto.randomUUID()}`;
  await fs.writeFile(lockFile, originalOwner, { mode: 0o600 });
  let debugPort = await reservePort();
  const first = await launch(configuration, debugPort, 'first');
  await inspect(first, configuration, debugPort, 'first');
  const firstOwner = await fs.readFile(lockFile, 'utf8'), firstGuard = await fs.stat(guardFile);
  assert.equal(Number(firstOwner.split(':')[0]), first.pid);
  assert.notEqual(firstOwner, originalOwner);
  assert((await fs.readFile(stateFile)).equals(before));
  checkpoint('first.sigkill');
  collectOwned(); first.kill('SIGKILL');
  await until(() => first.signalCode === 'SIGKILL');
  assert.equal(await fs.readFile(lockFile, 'utf8'), firstOwner);
  assert((await fs.readFile(stateFile)).equals(before));
  await stopGroup(first.pid);
  debugPort = await reservePort();
  const restarted = await launch(configuration, debugPort, 'restart');
  await inspect(restarted, configuration, debugPort, 'restart');
  const nextOwner = await fs.readFile(lockFile, 'utf8'), nextGuard = await fs.stat(guardFile);
  assert.equal(Number(nextOwner.split(':')[0]), restarted.pid);
  assert.notEqual(nextOwner, firstOwner); assert.equal(nextGuard.ino, firstGuard.ino);
  assert((await fs.readFile(stateFile)).equals(before));
  await stopGroup(restarted.pid);
  await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
  assert((await fs.readFile(stateFile)).equals(before));
  receipt.journal = { unknownStatePreserved: true, sha256: digest(before), deadLegacyOwnerRecovered: true, sigkillOwnerRecovered: true, sameGuardInode: true, gracefulOwnerRemoved: true };
  checkpoint('journal.verified');
  checkpoint('hmr.profile');
  const development = await profile('hmr');
  debugPort = await reservePort();
  const uiPort = await reservePort();
  Object.assign(development.environment, {
    OPENCHAMBER_ELECTRON_AUTO_START_HMR: '1',
    OPENCHAMBER_ELECTRON_REMOTE_DEBUGGING_PORT: String(debugPort),
    OPENCHAMBER_HMR_UI_PORT: String(uiPort),
    OPENCHAMBER_HMR_API_PORT: String(development.port),
    OPENCODE_SKIP_START: 'true',
  });
  const dev = await launch(development, debugPort, 'hmr', true);
  await inspect(dev, development, debugPort, 'hmr', true);
  const developmentLock = path.join(development.data, 'unihub-model/writer.lock');
  const developmentOwner = Number((await fs.readFile(developmentLock, 'utf8')).split(':')[0]);
  assert(collectOwned().some(row => row.pid === developmentOwner && owned.get(row.pid).root === dev.pid), 'Development writer lock belongs to an owned descendant');
  await stopGroup(dev.pid);
  await assert.rejects(fs.stat(developmentLock), { code: 'ENOENT' });
  receipt.hmr = { rendered: true, ownedWriterLock: true, gracefulOwnerRemoved: true, skipStartExplicit: true };
  receipt.passed = true;
  checkpoint('checks.complete');
} catch (error) {
  receipt.failureStage = receipt.stage;
  receipt.error = redact(error.stack);
  console.error(receipt.error);
  checkpoint('checks.failed');
  process.exitCode = 1;
} finally {
  for (const group of groups) {
    try { await stopGroup(group); } catch (error) { receipt.passed = false; receipt.cleanupError = redact(error.message); process.exitCode = 1; }
  }
  receipt.survivingOwnedProcesses = collectOwned().map(process => process.pid);
  if (receipt.survivingOwnedProcesses.length) { receipt.passed = false; process.exitCode = 1; }
  const outputLogs = [...logs].map(([name, lines]) => `${name}\n${lines.join('\n')}`);
  for (const profileName of ['packaged', 'hmr']) {
    const appLog = await fs.readFile(path.join(root, profileName, 'Library/Logs/SuperWagie/main.log'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (appLog) outputLogs.push(`${profileName}/main.log\n${redact(appLog)}`);
  }
  await fs.mkdir(path.dirname(options.get('receipt')), { recursive: true });
  appendLog(`\n[final logs]\n${outputLogs.join('\n')}`);
  checkpoint('cleanup.processes-complete');
  await fs.rm(root, { recursive: true, force: true });
  receipt.isolatedProfilesRemoved = true;
  receipt.finishedAt = new Date().toISOString();
  if (receipt.diagnosticsError) receipt.passed = false;
  receipt.limits = ['Execution uses the recorded host OS; macOS 12 hardware acceptance is separate', 'Local backend, managed OpenCode readiness, packaged login screen and crash recovery are checked; account login and model/tool execution belong to separate checks', 'No GUI installation or updater installation acceptance'];
  checkpoint(receipt.passed ? 'complete' : 'failed');
  console.log(JSON.stringify({ passed: receipt.passed, receipt: options.get('receipt') }));
}
