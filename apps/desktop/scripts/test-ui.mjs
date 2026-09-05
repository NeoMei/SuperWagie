import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runUiLifecycle } from './ui-lifecycle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = spawn(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'inherit' });
const buildCode = await new Promise((resolve) => build.on('exit', resolve));
if (buildCode !== 0) process.exit(buildCode ?? 1);
const result = await runUiLifecycle();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
