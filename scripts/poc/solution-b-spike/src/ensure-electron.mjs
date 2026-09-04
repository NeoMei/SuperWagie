import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { joinRuntimePath, runtimePlatform } from './runtime-platform.mjs';

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = joinRuntimePath(spikeRoot, runtimePlatform().developmentElectron);

if (!existsSync(binary)) {
  const installer = join(spikeRoot, 'node_modules', 'electron', 'install.js');
  if (!existsSync(installer)) {
    throw new Error('Pinned Electron npm package is missing; run npm ci first.');
  }
  const install = spawnSync(process.execPath, [installer], {
    cwd: spikeRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (install.status !== 0 || !existsSync(binary)) {
    throw new Error([
      'Pinned Electron runtime preparation failed.',
      install.stdout || '',
      install.stderr || '',
      install.error?.message || '',
    ].filter(Boolean).join('\n'));
  }
}
