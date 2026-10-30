import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('permits packaged knowledge idempotency preflight and retains origin and account gates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-cors-preflight-'));
  const data = path.join(root, 'data');
  for (const name of ['projects', 'themes', 'speech-models']) {
    await fs.mkdir(path.join(data, name), { recursive: true });
  }
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({
    knowledgeLibraryEnabled: false, isolatedSpacesEnabled: false, agentMemoryToolEnabled: false,
  }));
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('./index.js', import.meta.url)), '--port', String(port), '--api-only',
  ], {
    env: {
      PATH: process.env.PATH, HOME: root, USER: process.env.USER, LOGNAME: process.env.LOGNAME,
      SHELL: '/usr/bin/false', OPENCHAMBER_DATA_DIR: data,
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: data,
      XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_SKIP_START: 'true',
      OPENCHAMBER_RELAY_HOST: 'off', OPENCHAMBER_UNIHUB_API_URL: 'http://127.0.0.1:9',
      OPENCHAMBER_UNIHUB_ISSUER: 'http://127.0.0.1:9',
      OPENCHAMBER_UNIHUB_GATEWAY_URL: 'http://127.0.0.1:9/platform/v1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const url = `http://127.0.0.1:${port}/api/knowledge-library/libraries/preview`;
    let response;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Own server exited: ${output.slice(-1500)}`);
      try {
        response = await fetch(url, {
          method: 'OPTIONS',
          headers: {
            Origin: 'openchamber-ui://app', 'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type,idempotency-key',
          },
          signal: AbortSignal.timeout(1000),
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(response, output.slice(-1500)).toBeDefined();
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('openchamber-ui://app');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-headers').toLowerCase().split(','))
      .toContain('idempotency-key');
    const denied = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://untrusted.invalid', 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'idempotency-key',
      },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    const unauthenticated = await fetch(url, {
      method: 'POST',
      headers: {
        Origin: 'openchamber-ui://app', 'Content-Type': 'application/json',
        'Idempotency-Key': 'synthetic-no-dispatch',
      },
      body: '{}',
    });
    expect([401, 403, 409]).toContain(unauthenticated.status);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(deadline);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
