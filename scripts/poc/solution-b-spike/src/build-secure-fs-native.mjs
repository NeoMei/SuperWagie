#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const source = resolve(import.meta.dirname, 'native', 'secure-fs-native.c');
const output = resolve(import.meta.dirname, 'native', 'secure-fs-native.node');
const include = join(dirname(dirname(process.execPath)), 'include', 'node');
mkdirSync(dirname(output), { recursive: true });
const result = spawnSync('/usr/bin/clang', ['-bundle', '-undefined', 'dynamic_lookup', '-O2', '-I', include, source, '-o', output], {
  encoding: 'utf8', env: { LANG: 'C', LC_ALL: 'C' },
});
if (result.status !== 0) throw new Error(`secure fs native build failed: ${result.stderr}`);
process.stdout.write(`${output}\n`);
