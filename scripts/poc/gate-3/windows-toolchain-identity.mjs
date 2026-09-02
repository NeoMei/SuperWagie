#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const SHA256 = /^[0-9a-f]{64}$/;
const WINDOWS_HOST = 'x86_64-pc-windows-msvc';

export const EXPECTED_WINDOWS_TOOLCHAIN = Object.freeze({
  node: 'v24.18.0',
  npm: '12.0.1',
  python: 'Python 3.13.7',
  rustc: Object.freeze({
    version: 'rustc 1.97.1 (8bab26f4f 2026-07-14)',
    release: '1.97.1',
    commit_hash: '8bab26f4f68e0e26f0bb7960be334d5b520ea452',
    commit_date: '2026-07-14',
    host: WINDOWS_HOST
  }),
  cargo: Object.freeze({
    version: 'cargo 1.97.1 (c980f4866 2026-06-30)',
    release: '1.97.1',
    commit_hash: 'c980f4866141969fab6254a680546a277789d6f0',
    commit_date: '2026-06-30',
    host: WINDOWS_HOST
  })
});

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalSerialize(value) {
  return JSON.stringify(canonicalValue(value));
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseVerboseVersion(output, tool) {
  const lines = output.trim().split(/\r?\n/);
  const fields = Object.fromEntries(lines.slice(1).map((line) => {
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error(`${tool} version output is malformed`);
    return [line.slice(0, separator), line.slice(separator + 1).trim()];
  }));
  for (const required of ['release', 'commit-hash', 'commit-date', 'host']) {
    if (!fields[required]) throw new Error(`${tool} version output missing ${required}`);
  }
  return {
    version: lines[0],
    release: fields.release,
    commit_hash: fields['commit-hash'],
    commit_date: fields['commit-date'],
    host: fields.host
  };
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} schema invalid`);
  }
}

function assertExactTool(actual, expected, label) {
  assertExactKeys(actual, ['version', 'release', 'commit_hash', 'commit_date', 'host'], label);
  for (const key of ['version', 'release', 'commit_hash', 'commit_date', 'host']) {
    if (actual[key] !== expected[key]) throw new Error(`${label} ${key} does not match Task 8 toolchain`);
  }
}

export function buildToolchainIdentity({ platform, arch, versions, packageLockSha256, cargoLockSha256 }) {
  if (platform !== 'win32' || arch !== 'x64') throw new Error('toolchain identity requires Windows x64');
  for (const [label, value] of [['npm lock', packageLockSha256], ['Cargo lock', cargoLockSha256]]) {
    if (!SHA256.test(value)) throw new Error(`${label} SHA-256 invalid`);
  }
  const rustc = parseVerboseVersion(versions.rustc, 'rustc');
  const cargo = parseVerboseVersion(versions.cargo, 'cargo');
  const base = {
    arch: 'x64',
    lockfiles: {
      cargo: { path: 'scripts/poc/gate-3/reviewer-shell/Cargo.lock', sha256: cargoLockSha256 },
      npm: { path: 'scripts/poc/gate-3/package-lock.json', sha256: packageLockSha256 }
    },
    platform: 'windows-11-x64',
    schema_id: 'superwagie.office-reviewer-toolchain-identity.v1',
    schema_version: 1,
    tools: {
      cargo,
      node: { version: versions.node.trim() },
      npm: { version: versions.npm.trim() },
      python: { version: versions.python.trim() },
      rustc
    }
  };
  validateToolchainIdentityBase(base);
  return { ...base, canonical_sha256: digest(canonicalSerialize(base)) };
}

function validateToolchainIdentityBase(identity, expectedLockHashes = {}) {
  assertExactKeys(identity, ['arch', 'lockfiles', 'platform', 'schema_id', 'schema_version', 'tools'], 'toolchain identity');
  if (identity.schema_id !== 'superwagie.office-reviewer-toolchain-identity.v1' || identity.schema_version !== 1) {
    throw new Error('toolchain identity schema invalid');
  }
  if (identity.platform !== 'windows-11-x64' || identity.arch !== 'x64') throw new Error('toolchain platform/arch invalid');
  assertExactKeys(identity.lockfiles, ['cargo', 'npm'], 'toolchain lockfiles');
  assertExactKeys(identity.lockfiles.cargo, ['path', 'sha256'], 'Cargo lock');
  assertExactKeys(identity.lockfiles.npm, ['path', 'sha256'], 'npm lock');
  const expectedLocks = {
    cargo: ['scripts/poc/gate-3/reviewer-shell/Cargo.lock', expectedLockHashes.cargoLockSha256],
    npm: ['scripts/poc/gate-3/package-lock.json', expectedLockHashes.packageLockSha256]
  };
  for (const [name, [expectedPath, expectedSha256]] of Object.entries(expectedLocks)) {
    const lock = identity.lockfiles[name];
    if (lock.path !== expectedPath || !SHA256.test(lock.sha256) || (expectedSha256 && lock.sha256 !== expectedSha256)) {
      throw new Error(`${name} lock identity invalid`);
    }
  }
  assertExactKeys(identity.tools, ['cargo', 'node', 'npm', 'python', 'rustc'], 'toolchain tools');
  for (const name of ['node', 'npm', 'python']) assertExactKeys(identity.tools[name], ['version'], `${name} tool`);
  if (identity.tools.node.version !== EXPECTED_WINDOWS_TOOLCHAIN.node) throw new Error('node version does not match Task 8 toolchain');
  if (identity.tools.npm.version !== EXPECTED_WINDOWS_TOOLCHAIN.npm) throw new Error('npm version does not match Task 8 toolchain');
  if (identity.tools.python.version !== EXPECTED_WINDOWS_TOOLCHAIN.python) throw new Error('python version does not match fixed workflow version');
  assertExactTool(identity.tools.rustc, EXPECTED_WINDOWS_TOOLCHAIN.rustc, 'rustc');
  assertExactTool(identity.tools.cargo, EXPECTED_WINDOWS_TOOLCHAIN.cargo, 'cargo');
  if (identity.tools.rustc.release !== identity.tools.cargo.release) throw new Error('cargo and rustc releases differ');
  if (/[A-Za-z]:\\|\/Users\/|file:\/\//.test(JSON.stringify(identity))) throw new Error('toolchain identity contains a native path');
}

export function validateToolchainIdentity(identity, expectedLockHashes = {}) {
  assertExactKeys(identity, ['arch', 'canonical_sha256', 'lockfiles', 'platform', 'schema_id', 'schema_version', 'tools'], 'toolchain identity');
  const { canonical_sha256: canonicalSha256, ...base } = identity;
  validateToolchainIdentityBase(base, expectedLockHashes);
  if (!SHA256.test(canonicalSha256) || canonicalSha256 !== digest(canonicalSerialize(base))) {
    throw new Error('toolchain canonical SHA-256 invalid');
  }
  return identity;
}

function runVersion(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} version failed`);
  const output = result.stdout.trim();
  console.log(output);
  return output;
}

async function sha256File(file) {
  return digest(await readFile(file));
}

function parseOutput(argv) {
  if (argv.length !== 2 || argv[0] !== '--output' || !argv[1]) throw new Error('usage: windows-toolchain-identity.mjs --output FILE');
  return path.resolve(argv[1]);
}

async function main() {
  const output = parseOutput(process.argv.slice(2));
  const identity = buildToolchainIdentity({
    platform: process.platform,
    arch: process.arch,
    versions: {
      node: runVersion(process.execPath, ['--version']),
      npm: runVersion('npm.cmd', ['--version']),
      rustc: runVersion('rustc.exe', ['--version', '--verbose']),
      cargo: runVersion('cargo.exe', ['--version', '--verbose']),
      python: runVersion('python.exe', ['--version'])
    },
    packageLockSha256: await sha256File(path.join(repo, 'scripts/poc/gate-3/package-lock.json')),
    cargoLockSha256: await sha256File(path.join(repo, 'scripts/poc/gate-3/reviewer-shell/Cargo.lock'))
  });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(identity, null, 2)}\n`);
  console.log(`toolchain identity canonical SHA-256: ${identity.canonical_sha256}`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
