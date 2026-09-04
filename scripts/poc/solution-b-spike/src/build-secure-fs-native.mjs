#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const spikeRoot = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(import.meta.dirname, 'native');
const nodeGyp = resolve(spikeRoot, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
const fingerprintDirectory = resolve(spikeRoot, 'node_modules', '.cache', 'superwagie-native');
mkdirSync(outputDirectory, { recursive: true });
mkdirSync(fingerprintDirectory, { recursive: true });

function buildFingerprint(arguments_, outputName) {
  const digest = createHash('sha256');
  digest.update('superwagie-secure-fs-native-build-v2\0');
  digest.update(process.version + '\0' + process.versions.modules + '\0');
  digest.update(JSON.stringify(arguments_) + '\0' + outputName + '\0');
  for (const file of ['binding.gyp', 'src/native/secure-fs-native.c']) {
    digest.update(file + '\0');
    digest.update(readFileSync(resolve(spikeRoot, file)));
  }
  return digest.digest('hex');
}

function build(arguments_, outputName) {
  const destination = resolve(outputDirectory, outputName);
  const fingerprintPath = join(fingerprintDirectory, `${outputName}.sha256`);
  const fingerprint = buildFingerprint(arguments_, outputName);
  if (existsSync(destination) && existsSync(fingerprintPath)
    && readFileSync(fingerprintPath, 'utf8').trim() === fingerprint) {
    process.stdout.write(`${destination}\n`);
    return;
  }
  const result = spawnSync(process.execPath, [nodeGyp, 'rebuild', ...arguments_], {
    cwd: spikeRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'error' },
  });
  if (result.status !== 0) {
    throw new Error(`secure fs native build failed: ${result.stdout}${result.stderr}`);
  }
  const built = resolve(spikeRoot, 'build', 'Release', 'secure_fs_native.node');
  if (!existsSync(built)) throw new Error('secure fs native output missing');
  // Mach-O release modules retain absolute object-file paths in their debug
  // symbol table even when the C source never references __FILE__. Strip only
  // that table before promotion so privacy scanning can stay fail-closed.
  if (process.platform === 'darwin') {
    const stripped = spawnSync('/usr/bin/strip', ['-S', built], {
      cwd: spikeRoot,
      encoding: 'utf8',
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
    if (stripped.status !== 0) {
      throw new Error(`secure fs native debug-symbol stripping failed: ${stripped.stdout}${stripped.stderr}`);
    }
  }
  // Windows locks a loaded native module. Evidence tests may rebuild in a
  // sibling process while another test still has the identical module loaded;
  // avoid replacing an already byte-identical destination in that case.
  if (!existsSync(destination) || !readFileSync(destination).equals(readFileSync(built))) {
    copyFileSync(built, destination);
  }
  writeFileSync(fingerprintPath, `${fingerprint}\n`, { mode: 0o600 });
  process.stdout.write(`${destination}\n`);
}

if (process.platform === 'win32') {
  build([], 'secure-fs-native-node.node');
  build(['--target=44.1.0', '--dist-url=https://electronjs.org/headers'], 'secure-fs-native-electron.node');
} else {
  build([], 'secure-fs-native.node');
}
