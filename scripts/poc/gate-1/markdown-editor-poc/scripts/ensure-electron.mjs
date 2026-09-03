import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

if (!existsSync(binary)) {
  const installer = join(root, 'node_modules/electron/install.js');
  if (!existsSync(installer)) throw new Error('Electron npm package is missing; run npm ci first.');
  const install = spawnSync(process.execPath, [installer], {
    cwd: root,
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
