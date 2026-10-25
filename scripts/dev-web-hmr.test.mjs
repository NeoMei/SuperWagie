import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));

// The fixture uses a Unix executable shim. Windows's real Bun executable is
// covered by bun-executable.test.mjs; this exercises the launch ordering.
for (const installExit of [0, 7]) {
  test(`dependency preparation ${installExit ? 'failure stops before server launch' : 'finishes before either server starts'}`, { skip: process.platform === 'win32' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hmr-launch-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
      fs.mkdirSync(path.join(root, 'packages/web'), { recursive: true });
      fs.copyFileSync(path.join(scripts, 'dev-web-hmr.mjs'), path.join(root, 'scripts/dev-web-hmr.mjs'));
      fs.copyFileSync(path.join(scripts, 'lib/bun-executable.mjs'), path.join(root, 'scripts/lib/bun-executable.mjs'));
      const executable = path.join(root, 'bun');
      const calls = path.join(root, 'calls.jsonl');
      fs.writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(process.argv[2] === 'install' ? ${installExit} : 0);\n`, { mode: 0o755 });
      const result = spawnSync(process.execPath, ['scripts/dev-web-hmr.mjs', '--prepare'], {
        cwd: root, env: { ...process.env, npm_execpath: executable }, encoding: 'utf8', timeout: 10_000,
      });
      const recorded = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
      assert.deepEqual(recorded[0], ['install', '--frozen-lockfile']);
      assert.equal(result.status, installExit);
      if (installExit) assert.equal(recorded.length, 1, 'a failed dependency install must not launch API or Vite');
      else assert.equal(recorded.length, 3, 'both servers start after dependency installation');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
