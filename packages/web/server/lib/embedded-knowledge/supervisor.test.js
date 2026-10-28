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
