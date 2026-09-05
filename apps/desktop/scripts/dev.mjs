import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const smoke = process.argv.includes('--smoke');
const build = spawn(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'inherit' });
const buildCode = await new Promise((resolve) => build.on('exit', resolve));
if (buildCode !== 0) process.exit(buildCode ?? 1);
const electron = join(root, 'node_modules', '.bin', 'electron');
const child = spawn(electron, [join(root, 'src', 'main', 'entry.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ...(smoke ? { SUPERWAGIE_SMOKE: '1' } : {}) },
});
process.exitCode = await new Promise((resolve) => child.on('exit', resolve));
