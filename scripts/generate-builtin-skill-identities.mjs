import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBundleIdentity } from '../packages/web/server/lib/builtin-skills/managed-tree.js';

const base = fileURLToPath(new URL('../packages/web/server/builtin-skills/', import.meta.url));
const sources = ['superppt', 'image-to-editable-pptx', ...(await fs.readdir(path.join(base, 'skills'))).map((name) => `skills/${name}`)];
for (const relative of sources) {
  const root = path.join(base, relative);
  if ((await fs.stat(root)).isDirectory()) await writeBundleIdentity(root, { sourceOnly: true, check: process.argv.includes('--check') });
}
