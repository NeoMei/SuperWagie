import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { createEmbeddedKnowledgeSupervisor } from './supervisor.js';

const FAKE_SERVER = [
  "import http from 'node:http';",
  "import fs from 'node:fs';",
  '',
  'const port = Number(process.argv[2]);',
  'const pidFile = process.argv[3];',
  'if (pidFile) fs.writeFileSync(pidFile, String(process.pid));',
  '',
  "http.createServer((req, res) => {",
  "  if (req.url === '/health') {",
  "    res.setHeader('content-type', 'application/json');",
  "    res.end(JSON.stringify({ status: 'ok' }));",
  '    return;',
  '  }',
  '  res.statusCode = 404;',
  "  res.end('{}');",
  "}).listen(port, '127.0.0.1');",
].join('\n');

const freePort = () => 18_000 + Math.floor(Math.random() * 1_000);

const isProcessAlive = (pid) => {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
};

const waitForState = async (supervisor, expected, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (supervisor.getState() === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

const started = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((supervisor) => supervisor.stop()));
});

const makeSupervisor = async (overrides = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-wk-'));
  const fixture = path.join(dir, 'fake-embedded-knowledge.mjs');
  await fs.writeFile(fixture, FAKE_SERVER);
  const pidFile = path.join(dir, 'pid');
  const port = freePort();
  const states = [];
  const supervisor = createEmbeddedKnowledgeSupervisor({
    resolveBinaryPath: () => process.execPath,
    spawnArgs: () => [fixture, String(port), pidFile],
    port,
    dataDir: dir,
    startupTimeoutMs: 10_000,
    healthIntervalMs: 60_000,
    onStateChange: (state) => states.push(state),
    ...overrides,
  });
  started.push(supervisor);
  return { supervisor, states, pidFile, port, dir };
};

describe('embedded knowledge supervisor', () => {
  it.skipIf(process.platform !== 'darwin')('reaps an unresponsive worker when the host is killed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-wk-owner-'));
    const fixture = path.join(dir, 'fake backend.mjs');
    const pidFile = path.join(dir, 'pid');
    const bashStartup = path.join(dir, 'bash-startup');
    const port = freePort();
    await fs.writeFile(fixture, FAKE_SERVER);
    await fs.writeFile(bashStartup, 'exit 99\n');
    const moduleUrl = new URL('./supervisor.js', import.meta.url);
    const hostScript = `
      import { createEmbeddedKnowledgeSupervisor } from ${JSON.stringify(moduleUrl.href)};
      const [fixture, port, pidFile, bashStartup] = process.argv.slice(1);
      const supervisor = createEmbeddedKnowledgeSupervisor({
        resolveBinaryPath: () => process.execPath,
        spawnArgs: () => [fixture, port, pidFile],
        buildEnv: () => ({ SHELLOPTS: 'errexit:monitor', BASH_ENV: bashStartup }),
        port: Number(port),
        backoffMs: [0],
      });
      process.send(await supervisor.start());
    `;
    const host = spawn(process.execPath, ['--input-type=module', '--eval', hostScript, fixture, String(port), pidFile, bashStartup], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const exit = once(host, 'exit');
    const unrelated = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
    const unrelatedExit = once(unrelated, 'exit');
    let workerPid;
    try {
      const state = await Promise.race([once(host, 'message').then(([message]) => message), exit]);
      expect(state).toBe('running');
      workerPid = Number(await fs.readFile(pidFile, 'utf8'));
      process.kill(workerPid, 'SIGSTOP');
      host.kill('SIGKILL');
      expect(await exit).toEqual([null, 'SIGKILL']);
      await expect.poll(() => isProcessAlive(workerPid), { timeout: 1200 }).toBe(false);
      await expect.poll(() => isProcessAlive(-workerPid), { timeout: 1200 }).toBe(false);
      expect(isProcessAlive(unrelated.pid)).toBe(true);
    } finally {
      host.kill('SIGKILL');
      await exit;
      if (workerPid && isProcessAlive(workerPid)) process.kill(workerPid, 'SIGKILL');
      unrelated.kill('SIGKILL');
      await unrelatedExit;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps checking an owned worker after a successful probe and restarts it after two failures', async () => {
    let successfulProbes = 0;
    let failuresLeft = 0;
    const ownershipDuringFailures = [];
    const { supervisor, pidFile } = await makeSupervisor({
      healthIntervalMs: 30,
      backoffMs: [0],
      fetchImpl: async (url, options) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          ownershipDuringFailures.push(supervisor.ownsProcess());
          return new Response('{}', { status: 503 });
        }
        const response = await fetch(url, options);
        if (response.ok) successfulProbes += 1;
        return response;
      },
    });

    expect(await supervisor.start()).toBe('running');
    const initialPid = Number(await fs.readFile(pidFile, 'utf8'));
    await expect.poll(() => successfulProbes).toBeGreaterThanOrEqual(2);
    failuresLeft = 2;
    await expect.poll(async () => {
      return supervisor.getState() === 'running' && Number(await fs.readFile(pidFile, 'utf8')) !== initialPid;
    }, { timeout: 2500 }).toBe(true);
    expect(ownershipDuringFailures).toEqual([true, true]);
    expect(isProcessAlive(initialPid)).toBe(false);
  });

  it('cancels health recovery when stop is requested during replacement startup', async () => {
    const scheduled = [];
    const preflight = Promise.withResolvers();
    const releasePreflight = Promise.withResolvers();
    let recovering = false;
    const { supervisor } = await makeSupervisor({
      schedule: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancelSchedule: () => {},
      backoffMs: [0],
      fetchImpl: async (url, options) => {
        if (!recovering) return fetch(url, options);
        if (!supervisor.ownsProcess()) {
          preflight.resolve();
          await releasePreflight.promise;
        }
        return new Response('{}', { status: 503 });
      },
    });

    expect(await supervisor.start()).toBe('running');
    recovering = true;
    await scheduled.shift()();
    const recovery = scheduled.shift()();
    await preflight.promise;
    await supervisor.stop();
    recovering = false;
    releasePreflight.resolve();
    await recovery;
    expect(supervisor.getState()).toBe('stopped');
    expect(supervisor.ownsProcess()).toBe(false);
  });

  it.skipIf(process.platform !== 'darwin')('waits for the old worker group before starting a replacement', async () => {
    const scheduled = [];
    let failuresLeft = 0;
    const { supervisor, port, dir, pidFile } = await makeSupervisor({
      spawnArgs: () => [wrapper, leaderFile, fixture, String(port), pidFile],
      schedule: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancelSchedule: () => {},
      backoffMs: [0],
      fetchImpl: async (url, options) => {
        if (failuresLeft === 0) return fetch(url, options);
        failuresLeft -= 1;
        return new Response('{}', { status: 503 });
      },
    });
    const wrapper = path.join(dir, 'worker-wrapper.mjs');
    const leaderFile = path.join(dir, 'leader');
    const fixture = path.join(dir, 'fake-embedded-knowledge.mjs');
    await fs.writeFile(wrapper, `
      import { spawn } from 'node:child_process';
      import fs from 'node:fs';
      fs.writeFileSync(process.argv[2], String(process.pid));
      spawn(process.execPath, process.argv.slice(3), { stdio: 'inherit' });
      process.once('SIGTERM', () => process.exit(0));
    `);

    expect(await supervisor.start()).toBe('running');
    const leader = Number(await fs.readFile(leaderFile, 'utf8'));
    const initialPid = Number(await fs.readFile(pidFile, 'utf8'));
    const group = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
    const watchdog = group.split('\n').map((row) => row.trim().split(/\s+/, 3))
      .find(([, parent, command]) => Number(parent) === leader && ['/bin/sh', '/bin/bash'].includes(command));
    expect(watchdog).toBeDefined();
    const watchdogPid = Number(watchdog[0]);
    process.kill(watchdogPid, 'SIGSTOP');
    let recovery;
    try {
      failuresLeft = 2;
      await scheduled.shift()();
      recovery = scheduled.shift()();
      expect(await waitForState(supervisor, 'unavailable')).toBe(true);
      expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(supervisor.getState()).toBe('unavailable');
    } finally {
      if (isProcessAlive(watchdogPid)) process.kill(watchdogPid, 'SIGCONT');
      await recovery;
    }
    expect(supervisor.ownsProcess()).toBe(true);
    expect(Number(await fs.readFile(pidFile, 'utf8'))).not.toBe(initialPid);
    expect(isProcessAlive(initialPid)).toBe(false);
  });

  it('starts the binary, reports running, and stops it', async () => {
    const { supervisor, states, pidFile } = await makeSupervisor();
    await supervisor.start();
    expect(supervisor.getState()).toBe('running');
    expect(states).toContain('starting');
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(await supervisor.restartOwned()).toBe('running');
    const replacementPid = Number(await fs.readFile(pidFile, 'utf8'));
    expect(replacementPid).not.toBe(pid);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => process.kill(replacementPid, 0)).not.toThrow();
    await supervisor.stop();
    expect(supervisor.getState()).toBe('stopped');
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => process.kill(replacementPid, 0)).toThrow();
  });

  it('reports not-installed when the binary is missing', async () => {
    const { supervisor } = await makeSupervisor({ resolveBinaryPath: () => null });
    await supervisor.start();
    expect(supervisor.getState()).toBe('not-installed');
  });

  it('reports a spawn failure instead of leaving a silent timeout', async () => {
    const { supervisor } = await makeSupervisor({
      resolveBinaryPath: () => path.join(os.tmpdir(), 'missing-embedded-knowledge-fixture'),
      spawnArgs: () => [],
      startupTimeoutMs: 250,
      backoffMs: [0],
    });
    await supervisor.start();
    expect(supervisor.getState()).toBe('unavailable');
    expect(supervisor.getError()).toBe('backend_spawn_failed');
  });

  it('adopts a healthy backend it did not start', async () => {
    const { supervisor, port, dir } = await makeSupervisor();
    const other = createEmbeddedKnowledgeSupervisor({
      resolveBinaryPath: () => process.execPath,
      spawnArgs: () => [path.join(dir, 'fake-embedded-knowledge.mjs'), String(port), path.join(dir, 'other.pid')],
      port,
      dataDir: dir,
      startupTimeoutMs: 10_000,
      healthIntervalMs: 60_000,
    });
    await other.start();
    expect(other.getState()).toBe('running');
    await supervisor.start();
    expect(supervisor.getState()).toBe('running');
    expect(await supervisor.restartOwned()).toBeNull();
    expect(other.getState()).toBe('running');
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.ok).toBe(true);
    await other.stop();
  });

  it('reports a port conflict instead of retrying forever', async () => {
    const http = await import('node:http');
    const { port } = await makeSupervisor();
    const occupant = http.createServer((req, res) => {
      res.statusCode = 500;
      res.end('{}');
    });
    await new Promise((resolve) => occupant.listen(port, '127.0.0.1', resolve));
    const { supervisor } = await makeSupervisor({
      port,
      backoffMs: [0],
      startupTimeoutMs: 2_000,
    });
    await supervisor.start();
    expect(supervisor.getState()).toBe('port-conflict');
    await new Promise((resolve) => occupant.close(resolve));
  });
});

it('refuses managed adoption and leaves the existing listener alive', async () => {
  const { supervisor: owner, port } = await makeSupervisor();
  await owner.start();
  const { supervisor } = await makeSupervisor({ port, managed: true });
  expect(await supervisor.start()).toBe('port-conflict');
  expect(supervisor.getError()).toBe('managed_worker_unowned');
  await supervisor.stop();
  expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
});

it.each(['already-exited', 'exit-during-probe', 'error-during-probe'])('refuses a foreign healthy listener when its child is %s', async (mode) => {
  let child; let probes = 0; let kills = 0;
  const occupant = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"status":"ok"}'); });
  const { supervisor, port } = await makeSupervisor({ managed: true, backoffMs: [0], startupTimeoutMs: 1000,
    fetchImpl: async () => {
      probes++;
      if (probes === 1) return new Response('{}', { status: 503 });
      if (mode === 'exit-during-probe') { child.exitCode = 1; child.emit('exit', 1, null); }
      if (mode === 'error-during-probe') child.emit('error', new Error('synthetic spawn failure'));
      return new Response('{"status":"ok"}');
    },
    spawnImpl: () => {
      occupant.listen(port, '127.0.0.1');
      child = new EventEmitter(); child.exitCode = mode === 'already-exited' ? 1 : null; child.stderr = new EventEmitter();
      child.kill = () => { kills++; child.exitCode = 0; child.emit('exit', 0, null); };
      return child;
    },
  });
  try {
    expect(await supervisor.start()).not.toBe('running'); expect(supervisor.ownsProcess()).toBe(false);
    await supervisor.stop(); expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true); expect(kills).toBe(0);
  } finally { await new Promise((resolve) => occupant.close(resolve)); }
});
