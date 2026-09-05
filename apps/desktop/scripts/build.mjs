import { copyFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

await run('cargo', ['build', '--manifest-path', '../../crates/product-core/Cargo.toml']);
const output = join(root, 'dist', 'renderer');
await mkdir(output, { recursive: true });
await build({
  entryPoints: [join(root, 'src', 'renderer', 'app.mjs')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: join(output, 'app.js'),
  sourcemap: false,
});
await Promise.all([
  copyFile(join(root, 'src', 'renderer', 'index.html'), join(output, 'index.html')),
  copyFile(join(root, 'src', 'renderer', 'styles.css'), join(output, 'styles.css')),
]);
