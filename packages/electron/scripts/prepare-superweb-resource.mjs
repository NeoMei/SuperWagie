/**
 * Stage the standalone SuperWeb skill where electron-builder can copy it as an
 * extra resource. Nested node_modules are not part of the app's package graph,
 * so they travel under vendor/ and the installer restores them.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(electronDir, '..', 'web', 'server', 'builtin-skills', 'skills', 'superweb');
const destination = path.resolve(electronDir, 'resources', 'superweb');
const modules = path.join(source, 'node_modules');

const exists = async (target) => stat(target).then(() => true).catch(() => false);

if (!(await exists(modules))) {
  const result = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], {
    cwd: source,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('SuperWeb dependencies are missing and npm ci failed');
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, {
  recursive: true,
  filter: (entry) => !entry.includes(`${path.sep}node_modules`) && !entry.includes(`${path.sep}vendor`),
});
await mkdir(path.join(destination, 'vendor'), { recursive: true });
await cp(modules, path.join(destination, 'vendor', 'node_modules'), { recursive: true, verbatimSymlinks: true });
