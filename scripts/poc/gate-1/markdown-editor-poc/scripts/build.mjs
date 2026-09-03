import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [resolve(root, 'src/renderer.mjs')],
  bundle: true,
  outfile: resolve(dist, 'renderer.js'),
  format: 'esm',
  platform: 'browser',
  target: 'chrome152',
  sourcemap: true,
});
await cp(resolve(root, 'src/index.html'), resolve(dist, 'index.html'));
await cp(resolve(root, 'src/styles.css'), resolve(dist, 'styles.css'));
await cp(resolve(root, 'node_modules/katex/dist/katex.min.css'), resolve(dist, 'katex.min.css'));
await cp(resolve(root, 'node_modules/katex/dist/fonts'), resolve(dist, 'fonts'), { recursive: true });
