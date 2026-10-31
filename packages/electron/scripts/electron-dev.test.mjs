import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));

async function fixture(t, scenario, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-hmr-'));
  fs.mkdirSync(path.join(root, 'packages/electron/scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(scripts, 'electron-dev.mjs'), path.join(root, 'packages/electron/scripts/electron-dev.mjs'));
  fs.copyFileSync(path.join(scripts, '../electron-dev-mode.mjs'), path.join(root, 'packages/electron/electron-dev-mode.mjs'));
  fs.writeFileSync(path.join(root, 'packages/electron/scripts/ensure-electron.mjs'), '');
  const eventsFile = path.join(root, 'events.jsonl');
  // Only Bun/Electron and the expensive web backend are stand-ins. The launcher,
  // HTTP probes, OS child processes, signal handling and teardown run unchanged.
  fs.writeFileSync(path.join(root, 'bun'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.EVENTS, JSON.stringify({ event: process.argv.includes('electron') ? 'electron' : 'build', at: Date.now(), pid: process.pid, env: { api: process.env.OPENCHAMBER_HMR_API_PORT, bundled: process.env.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI } }) + '\\n');
`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'scripts/dev-web-hmr.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
const record = (event, extra = {}) => fs.appendFileSync(process.env.EVENTS, JSON.stringify({event, at: Date.now(), ...extra}) + '\\n');
const scenario = JSON.parse(process.env.SCENARIO);
const descendant = spawn(process.execPath, ['-e', scenario.ignoreSignal ? "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" : 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
record('dev', {pid: process.pid, descendant: descendant.pid});
if (scenario.exit !== undefined) setTimeout(() => process.exit(scenario.exit), 100);
for (const [label, port, delay] of [['api', process.env.OPENCHAMBER_HMR_API_PORT, scenario.api], ['ui', process.env.OPENCHAMBER_HMR_UI_PORT, scenario.ui]]) {
  http.createServer((req, res) => {
    if (req.url !== '/health') { res.writeHead(404); res.end(); return; }
    if (delay === null) return;
    const ready = Date.now() - started >= delay;
    res.writeHead(ready ? 200 : 503);
    res.end(ready ? 'ready' : 'starting');
    if (ready) record(label + '-ready');
  }).listen(Number(port), '127.0.0.1');
}
const started = Date.now();
`);
  // Compress only the production cold-start deadline, leaving its polling and
  // real HTTP cancellation intact. No production source or timeout option changes.
  fs.writeFileSync(path.join(root, 'deadline.cjs'), `
const original = global.setTimeout;
global.setTimeout = (fn, delay, ...args) => original(fn, delay === 120000 && ${Boolean(scenario.timeout)} ? 350 : delay, ...args);
`);
  const child = spawn(process.execPath, ['--require', path.join(root, 'deadline.cjs'), 'packages/electron/scripts/electron-dev.mjs'], {
    cwd: root, env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, EVENTS: eventsFile,
      OPENCHAMBER_ELECTRON_AUTO_START_HMR: '1', OPENCHAMBER_ELECTRON_USE_BUNDLED_UI: '',
      OPENCHAMBER_HMR_API_PORT: '0', OPENCHAMBER_HMR_UI_PORT: '0', SCENARIO: JSON.stringify(scenario), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const completion = once(child, 'exit');
  const events = () => fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await completion;
    for (const entry of events()) {
      for (const pid of [entry.pid, entry.descendant]) {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    }
    unrelated.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { child, completion, events, unrelated, output: () => output };
}

const options = { skip: process.platform === 'win32', timeout: 12_000 };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function assertStopped(run) {
  assert.equal(alive(run.unrelated.pid), true, 'unrelated processes remain alive');
  const dev = run.events().find((entry) => entry.event === 'dev');
  if (!dev) return;
  for (let attempt = 0; attempt < 40 && (alive(dev.pid) || alive(dev.descendant)); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(alive(dev.pid), false, 'owned dev server exits');
  assert.equal(alive(dev.descendant), false, 'owned descendant exits');
}

for (const [name, scenario] of [['API', { api: 6_000, ui: 0 }], ['UI', { api: 0, ui: 200 }]]) {
  test(`Electron waits for delayed ${name} readiness`, options, async (t) => {
    const run = await fixture(t, scenario);
    const [code] = await run.completion;
    assert.equal(code, 0, run.output());
    const events = run.events();
    const electron = events.filter((entry) => entry.event === 'electron');
    assert.equal(electron.length, 1);
    for (const endpoint of ['api-ready', 'ui-ready']) {
      assert.ok(events.findIndex((entry) => entry.event === endpoint) < events.indexOf(electron[0]) && events.some((entry) => entry.event === endpoint), `${endpoint} precedes Electron`);
    }
    await assertStopped(run);
  });
}

for (const [name, scenario] of [['child exit', { api: null, ui: null, exit: 7 }], ['clean child exit', { api: null, ui: null, exit: 0 }], ['timeout', { api: null, ui: null, timeout: true }], ['timeout with stubborn descendant', { api: null, ui: null, timeout: true, ignoreSignal: true }]]) {
  test(`HMR ${name} fails without launching Electron and cleans descendants`, options, async (t) => {
    const run = await fixture(t, scenario);
    const [code] = await run.completion;
    assert.equal(code, name === 'child exit' ? 7 : 1, run.output());
    assert.equal(run.events().some((entry) => entry.event === 'electron'), false);
    if (scenario.timeout) assert.match(run.output(), /120.*API.*UI|API.*UI.*120/);
    await assertStopped(run);
  });
}

for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} cancels readiness and cleans the owned tree`, options, async (t) => {
    const run = await fixture(t, { api: null, ui: null });
    while (!run.events().some((entry) => entry.event === 'dev')) await new Promise((resolve) => setTimeout(resolve, 5));
    run.child.kill(signal);
    run.child.kill(signal);
    const [code] = await run.completion;
    assert.equal(code, expected, run.output());
    assert.equal(run.events().some((entry) => entry.event === 'electron'), false);
    await assertStopped(run);
  });
}

for (const [name, env] of [['default', { OPENCHAMBER_ELECTRON_AUTO_START_HMR: '' }], ['bundled override', { OPENCHAMBER_ELECTRON_USE_BUNDLED_UI: '1' }]]) {
  test(`${name} builds bundled assets and never starts HMR`, options, async (t) => {
    const run = await fixture(t, {}, env);
    assert.equal((await run.completion)[0], 0, run.output());
    assert.deepEqual(run.events().map((entry) => entry.event), ['build', 'electron']);
    assert.equal(run.events()[1].env.bundled, '1');
  });
}

// Execute the existing platform branch with a child-process boundary double.
// Native Windows process enumeration and console visibility need a native run.
test('Windows cleanup terminates the owned tree before its root', async () => {
  const source = fs.readFileSync(path.join(scripts, 'electron-dev.mjs'), 'utf8');
  const functions = source.slice(source.indexOf('function killWindowsProcessTree('), source.indexOf('async function main()'));
  const calls = [];
  const child = { pid: 4123, exitCode: null, signalCode: null,
    kill(signal) { calls.push(['root', signal]); this.signalCode = signal; } };
  const context = {
    process: { platform: 'win32' },
    spawnSync(command, args, options) {
      calls.push([command, Array.from(args), options.windowsHide, options.stdio]);
      child.exitCode = 0;
    },
    waitForExit: async () => {},
  };
  await vm.runInNewContext(`${functions}\nstopChildTree(child);`, { ...context, child });
  assert.deepEqual(calls, [['taskkill.exe', ['/PID', '4123', '/T', '/F'], true, 'ignore']]);
});


test('dev-server spawn error cancels readiness before Electron starts', async () => {
  const source = fs.readFileSync(path.join(scripts, 'electron-dev.mjs'), 'utf8');
  const main = source.slice(source.indexOf('async function main()'), source.indexOf('\nmain().catch'));
  const child = new EventEmitter();
  const exits = [];
  const stopped = [];
  let spawns = 0;
  let readinessAborted = false;
  await vm.runInNewContext(`${main}\nmain();`, {
    resolveElectronDevMode: () => ({ startHmr: true, useBundledUi: false }),
    process: { env: {}, on() {}, exit(code) { exits.push(code); } },
    AbortController,
    console: { log() {}, warn() {}, error() {} },
    ensureElectronInstalled() {},
    resolveBundledOpenCodeCliEnv: () => ({}),
    findAvailablePort: async (port) => port,
    preferredHmrApiPort: 3901, preferredHmrUiPort: 5173, electronDir: '/fixture/electron',
    spawnProcess() {
      spawns++;
      queueMicrotask(() => child.emit('error', new Error('ENOENT')));
      return child;
    },
    waitForHmrReady: async (_api, _ui, signal) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      readinessAborted = signal.aborted;
      signal.throwIfAborted();
    },
    stopChildTree: async (owned) => { if (owned) stopped.push(owned); },
  });
  assert.equal(spawns, 1, 'failed dev-server spawn never launches Electron');
  assert.equal(readinessAborted, true);
  assert.deepEqual(exits, [1]);
  assert.deepEqual(stopped, [child]);
});

test('bundled asset build retains its existing launcher signal ownership', async () => {
  const source = fs.readFileSync(path.join(scripts, 'electron-dev.mjs'), 'utf8');
  const main = source.slice(source.indexOf('async function main()'), source.indexOf('\nmain().catch'));
  const signals = [];
  let releaseBuild;
  let spawns = 0;
  const build = new Promise((resolve) => { releaseBuild = resolve; });
  const launched = vm.runInNewContext(`${main}\nmain();`, {
    resolveElectronDevMode: () => ({ startHmr: false, useBundledUi: true }),
    process: { env: {}, on(signal) { signals.push(signal); }, exit() {} },
    AbortController, console,
    ensureElectronInstalled() {}, resolveBundledOpenCodeCliEnv: () => ({}),
    runProcess: () => build,
    spawnProcess() { spawns++; return new EventEmitter(); }, electronDir: '/fixture/electron',
    stopChildTree: async () => {},
  });
  assert.deepEqual(signals, [], 'the launcher does not intercept signals while the existing asset build owns startup');
  releaseBuild();
  await launched;
  assert.equal(spawns, 1);
  assert.deepEqual(signals, ['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGHUP']);
});
