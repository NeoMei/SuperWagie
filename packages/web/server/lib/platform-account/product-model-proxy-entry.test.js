import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../../product-model-proxy.mjs', import.meta.url));
const listenPort = async () => {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};
const stop = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  child.kill();
  await ended;
};

it('starts only one isolated proxy process against the same vault', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-proxy-exclusive-'));
  let first; let second;
  try {
    const [firstPort, secondPort] = await Promise.all([listenPort(), listenPort()]);
    const credentialFile = path.join(dir, 'service-credential');
    await fs.writeFile(credentialFile, 'test-exclusive-credential', { mode: 0o600 });
    const start = async (port) => {
      const settings = path.join(dir, port + '.json');
      await fs.writeFile(settings, JSON.stringify({ uniHubOrigin: 'https://accounts.test', modelGateway: 'https://models.test/platform/v1', allowedModels: ['fixture'], serviceCredentialFile: credentialFile, vaultPath: path.join(dir, 'vault'), port }), { mode: 0o600 });
      return spawn(process.execPath, [entry, settings], { stdio: ['ignore', 'ignore', 'pipe'] });
    };
    first = await start(firstPort);
    const deadline = Date.now() + 5000;
    let live;
    while (Date.now() < deadline && first.exitCode === null && !live) {
      live = await fetch('http://127.0.0.1:' + firstPort + '/v1/product-model/calls/test').catch(() => null);
      if (!live) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(live?.status).toBe(401);
    second = await start(secondPort);
    const diagnostic = Array.fromAsync(second.stderr);
    const result = await Promise.race([
      once(second, 'exit').then(([code]) => code),
      new Promise((resolve) => setTimeout(() => resolve(null), 1000).unref()),
    ]);
    expect(result).toBe(1);
    expect(Buffer.concat(await diagnostic).toString('utf8')).toContain('platform_store_busy');
  } finally {
    await stop(second);
    await stop(first);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
