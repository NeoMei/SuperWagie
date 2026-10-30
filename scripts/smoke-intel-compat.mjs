import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CdpClient, reservePort, wait } from './perf/cdp.mjs';

const options = new Map(process.argv.slice(2).map(argument => {
  const match = /^--(app|receipt)=(.+)$/.exec(argument);
  assert(match, `Unsupported argument: ${argument}`);
  return [match[1], path.resolve(match[2])];
}));
assert(options.has('app') && options.has('receipt'), '--app and --receipt are required');
assert.equal(process.platform, 'darwin');
const executable = path.join(options.get('app'), 'Contents/MacOS/犇马');
const repository = process.cwd();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'superwagie-intel-smoke-'));
const receipt = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), hostArchitecture: process.arch, hostRelease: os.release(), checks: [], passed: false };
const groups = new Set();
const owned = new Map();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const processes = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' }).trim().split('\n').map(line => {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
  return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), command: match[4] };
});

function collectOwned() {
  const rows = processes();
  for (const root of groups) {
    const ids = new Set([root, ...[...owned.values()].filter(row => row.root === root).map(row => row.pid)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
    }
    for (const row of rows) if (ids.has(row.pid) && !owned.has(row.pid)) owned.set(row.pid, { ...row, root });
  }
  return rows.filter(row => owned.get(row.pid)?.command === row.command);
}

async function until(operation, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    collectOwned();
    try { const result = await operation(); if (result) return result; } catch (error) { lastError = error; }
    await wait(250);
  }
  throw new Error('Intel smoke timed out', { cause: lastError });
}

async function stopGroup(group) {
  collectOwned();
  // Let the dev launcher complete its own two-stage teardown before fallback.
  if (alive(group)) {
    process.kill(group, 'SIGTERM');
    const deadline = Date.now() + 10_000;
    while (alive(group) && Date.now() < deadline) { collectOwned(); await wait(200); }
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
}

async function profile(name) {
  const home = path.join(root, name);
  const data = path.join(home, '.config/openchamber');
  const userData = path.join(home, 'userData');
  for (const directory of [home, data, userData, path.join(home, 'tmp'), path.join(home, 'Library/Logs/SuperWagie')]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const port = await reservePort();
  const opencodePort = await reservePort();
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ desktopLocalPort: port, desktopLanAccessEnabled: false, desktopCloseAction: 'quit' }));
  const environment = {
    PATH: process.env.PATH, USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: 'en_US.UTF-8',
    HOME: home, USERPROFILE: home, TMPDIR: path.join(home, 'tmp'), SHELL: '/bin/zsh', ZDOTDIR: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCHAMBER_DATA_DIR: data, OPENCHAMBER_DESKTOP_USER_DATA_DIR: userData,
    OPENCHAMBER_RELAY_HOST: 'off', OPENCODE_SKIP_START: 'true', OPENCODE_HOST: '127.0.0.1', OPENCODE_PORT: String(opencodePort),
    OPENCHAMBER_UNIHUB_ISSUER: 'http://127.0.0.1:9', OPENCHAMBER_UNIHUB_API_URL: 'http://127.0.0.1:9',
    OPENCHAMBER_UNIHUB_CONSOLE_URL: 'http://127.0.0.1:9', OPENCHAMBER_UNIHUB_GATEWAY_URL: 'http://127.0.0.1:9/platform/v1',
  };
  return { home, data, port, environment };
}

async function launch(command, arguments_, configuration, name, extra = {}) {
  const log = await fs.open(path.join(root, `${name}.log`), 'w', 0o600);
  const child = spawn(command, arguments_, { cwd: repository, env: { ...configuration.environment, ...extra }, detached: true, stdio: ['ignore', log.fd, log.fd] });
  const spawned = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await log.close();
  await spawned;
  groups.add(child.pid);
  return child;
}

async function inspect(child, configuration, debugPort, name, hmr = false) {
  const health = await until(async () => {
    assert(alive(child.pid), `${name} exited`);
    const response = await fetch(`http://127.0.0.1:${configuration.port}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && { status: response.status, body: await response.json() };
  });
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) });
    return (await response.json()).find(target => target.type === 'page' && !target.url.includes('__splash') && !target.url.startsWith('devtools://'));
  });
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    const ui = await until(async () => {
      const response = await client.send('Runtime.evaluate', { expression: `(() => ({url:location.href, mounted:[...(document.querySelector('#root')?.children??[])].some(element=>Object.keys(element).some(key=>key.startsWith('__reactFiber'))), textLength:document.body?.innerText.length??0, vite:[...document.scripts].some(script=>script.src.includes('/@vite/client')), bridge:!!window.__OPENCHAMBER_DESKTOP__}))()`, returnByValue: true });
      return response.result?.value?.mounted && response.result.value.textLength > 10 && response.result.value;
    });
    assert.equal(ui.bridge, true);
    assert.equal(ui.vite, hmr);
    const response = await client.send('Runtime.evaluate', { expression: `Promise.all([fetch(location.href).then(response=>response.status),window.__OPENCHAMBER_DESKTOP__.invoke('desktop_check_for_updates',{})]).then(([status,update])=>({status,update}))`, returnByValue: true, awaitPromise: true }, { timeoutMs: 15_000 });
    assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
    assert.equal(response.result.value.status, 200);
    assert.equal(response.result.value.update.available, false);
    receipt.checks.push({ name, health, ui, ipc: response.result.value });
  } finally { client.close(); }
  assert(!collectOwned().some(process => /(?:^|\/)opencode(?:\s|$)/.test(process.command)), 'Managed OpenCode unexpectedly started');
}

try {
  assert.equal(alive(999999999), false);
  const probe = path.join(root, 'runtime-probe.cjs');
  await fs.writeFile(probe, `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const {DatabaseSync} = require('node:sqlite');
    assert.equal(process.arch, 'x64');
    assert.equal(process.versions.electron, '43.8.4');
    assert.equal(process.versions.node, '24.22.1');
    assert.equal(process.versions.modules, '148');
    const database = new DatabaseSync(':memory:');
    database.exec('BEGIN EXCLUSIVE; ROLLBACK');
    database.close();
    const modules = path.join(process.argv[2], 'Contents/Resources/app.asar.unpacked/node_modules/node-pty');
    const binary = ['build/Release/pty.node', 'prebuilds/darwin-x64/pty.node'].map(name=>path.join(modules,name)).find(name=>fs.existsSync(name));
    assert(binary, 'Packaged native PTY missing');
    require(binary);
    console.log(JSON.stringify({architecture:process.arch,electron:process.versions.electron,node:process.versions.node,abi:process.versions.modules,sqlite:true,ptyLoaded:true}));
  `);
  const configuration = await profile('packaged');
  receipt.runtime = JSON.parse(execFileSync(executable, [probe, options.get('app')], { encoding: 'utf8', timeout: 20_000, env: { ...configuration.environment, ELECTRON_RUN_AS_NODE: '1' } }));
  const store = path.join(configuration.data, 'unihub-model');
  await fs.mkdir(store, { mode: 0o700 });
  const stateFile = path.join(store, 'state.json');
  const lockFile = path.join(store, 'writer.lock');
  const before = Buffer.from(JSON.stringify({ version: 1,
    tasks: { session: { id: 'task', sessionID: 'session', actorID: 'actor', accountID: 'account', owner: 'owner', model: 'fixture' } },
    calls: { fixture: { id: 'fixture', sessionID: 'session', taskID: 'task', model: 'fixture', digest: 'fixture-request', status: 'UNKNOWN', output: true } },
  }));
  await fs.writeFile(stateFile, before, { mode: 0o600 });
  await fs.writeFile(lockFile, `999999999:${crypto.randomUUID()}`, { mode: 0o600 });
  let debugPort = await reservePort();
  const first = await launch(executable, [`--remote-debugging-port=${debugPort}`], configuration, 'first');
  await inspect(first, configuration, debugPort, 'first');
  const firstOwner = await fs.readFile(lockFile, 'utf8');
  assert.equal(Number(firstOwner.split(':')[0]), first.pid);
  const guard = await fs.stat(path.join(store, 'writer-guard.sqlite'));
  first.kill('SIGKILL');
  await until(() => first.exitCode !== null || first.signalCode !== null);
  assert.equal(first.signalCode, 'SIGKILL');
  await stopGroup(first.pid);
  assert.equal(await fs.readFile(lockFile, 'utf8'), firstOwner);
  assert((await fs.readFile(stateFile)).equals(before));
  debugPort = await reservePort();
  const second = await launch(executable, [`--remote-debugging-port=${debugPort}`], configuration, 'restart');
  await inspect(second, configuration, debugPort, 'restart');
  const secondOwner = await fs.readFile(lockFile, 'utf8');
  assert.equal(Number(secondOwner.split(':')[0]), second.pid);
  assert.notEqual(secondOwner, firstOwner);
  assert.equal((await fs.stat(path.join(store, 'writer-guard.sqlite'))).ino, guard.ino);
  assert((await fs.readFile(stateFile)).equals(before));
  receipt.journal = { unchanged: true, sha256: digest(before), sameGuardInode: true, staleOwnerRecovered: true, killedOwnerRecovered: true };
  await stopGroup(second.pid);
  await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });

  const development = await profile('hmr');
  debugPort = await reservePort();
  const uiPort = await reservePort();
  const hmr = await launch(process.execPath, [path.join(repository, 'packages/electron/scripts/electron-dev.mjs')], development, 'hmr', {
    OPENCHAMBER_ELECTRON_AUTO_START_HMR: '1', OPENCHAMBER_ELECTRON_REMOTE_DEBUGGING_PORT: String(debugPort),
    OPENCHAMBER_HMR_UI_PORT: String(uiPort), OPENCHAMBER_HMR_API_PORT: String(development.port),
  });
  await inspect(hmr, development, debugPort, 'hmr', true);
  await stopGroup(hmr.pid);
  receipt.passed = true;
} catch (error) {
  receipt.error = error.stack;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  for (const group of groups) {
    try { await stopGroup(group); } catch (error) { receipt.passed = false; receipt.cleanupError = error.message; process.exitCode = 1; }
  }
  receipt.survivingOwnedProcesses = collectOwned().map(process => process.pid);
  assert.equal(receipt.survivingOwnedProcesses.length, 0);
  const logs = [];
  for (const name of ['first.log', 'restart.log', 'hmr.log', 'packaged/Library/Logs/SuperWagie/main.log', 'hmr/Library/Logs/SuperWagie/main.log']) {
    const content = await fs.readFile(path.join(root, name), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (content) logs.push(`${name}\n${content}`);
  }
  await fs.mkdir(path.dirname(options.get('receipt')), { recursive: true });
  await fs.writeFile(`${options.get('receipt')}.log`, logs.join('\n'));
  await fs.rm(root, { recursive: true, force: true });
  receipt.isolatedProfilesRemoved = true;
  receipt.finishedAt = new Date().toISOString();
  receipt.limits = ['Native architecture execution on the recorded host OS; no macOS 12 host was used', 'Managed OpenCode was disabled; no real login or model generation', 'No GUI installation or updater installation acceptance'];
  await fs.writeFile(options.get('receipt'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ passed: receipt.passed, receipt: options.get('receipt') }));
}
