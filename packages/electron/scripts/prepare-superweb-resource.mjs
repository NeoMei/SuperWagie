/**
 * Stage the standalone SuperWeb skill where electron-builder can copy it as an
 * extra resource. Nested node_modules are not part of the app's package graph,
 * so they travel under vendor/ and the installer restores them.
 */
import { cp, mkdir, rm, stat, readdir, readFile, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeBundleIdentity } from '../../web/server/lib/builtin-skills/managed-tree.js';
import { resolveNpmCommand } from '../../../scripts/lib/npm-command.mjs';

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(electronDir, '..', 'web', 'server', 'builtin-skills', 'skills', 'superweb');
const destination = path.resolve(electronDir, 'resources', 'superweb');
const modules = path.join(source, 'node_modules');

const exists = async (target) => stat(target).then(() => true).catch(() => false);

const targetArch = process.env.OPENCHAMBER_TARGET_ARCH || process.env.ELECTRON_BUILDER_ARCH || process.arch;
if (targetArch !== process.arch) throw new Error('SuperWeb resource requires a native build worker');

if (!(await exists(modules))) {
  const npm = resolveNpmCommand();
  const result = spawnSync(npm.command, [...npm.args, 'ci', '--omit=dev', '--ignore-scripts'], {
    cwd: source,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`SuperWeb npm ci failed with exit code ${result.status}`);
}

for (const name of await readdir(path.join(modules, '@esbuild')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) {
  const metadata = JSON.parse(await readFile(path.join(modules, '@esbuild', name, 'package.json'), 'utf8'));
  if ((metadata.os && !metadata.os.includes(process.platform)) || (metadata.cpu && !metadata.cpu.includes(targetArch))) throw new Error('SuperWeb contains a foreign esbuild package');
}
const stage = `${destination}.stage-${randomUUID()}`;
const backup = `${destination}.previous-${randomUUID()}`;
let moved = false;
try {
  await mkdir(stage, { recursive: true });
  await cp(source, stage, {
    recursive: true,
    filter: (entry) => !entry.includes(`${path.sep}node_modules`) && !entry.includes(`${path.sep}vendor`),
  });
  await mkdir(path.join(stage, 'vendor'), { recursive: true });
  await cp(modules, path.join(stage, 'vendor', 'node_modules'), { recursive: true, verbatimSymlinks: true });
  await writeBundleIdentity(stage);
  if (await exists(destination)) { await rename(destination, backup); moved = true; }
  try { await rename(stage, destination); }
  catch (error) { if (moved) await rename(backup, destination); throw error; }
  if (moved) await rm(backup, { recursive: true, force: true });
} finally { await rm(stage, { recursive: true, force: true }); }
