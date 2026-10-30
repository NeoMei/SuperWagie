import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const implementationUrl = new URL('./prepare-hy-memory.mjs', import.meta.url);
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hy resources & spaces '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, 'source');
  for (const [name, content] of Object.entries({
    'requirements.txt': 'fixturedep==1.0.0\n',
    'python/worker.py': 'print("worker")\n',
    'python/engine.py': 'ENGINE = "fixture"\n',
    'python/tests/test_engine.py': 'excluded test',
    'python/__pycache__/engine.pyc': 'excluded cache',
    'vendor/hy_memory/__init__.py': '__version__ = "fixture"\n',
    'vendor/LICENSE': 'fixture license',
  })) {
    const file = path.join(sourceDirectory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const archive = (name, files) => {
    const directory = path.join(root, name);
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.writeFileSync(path.join(directory, file), content);
    }
    const filename = `${name}.tar.gz`;
    const archivePath = path.join(root, filename);
    const result = spawnSync('tar', ['-czf', filename, '-C', directory, '.'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return { filename, url: `https://example.invalid/${filename}`, sha256: digest(archivePath), archivePath };
  };
  const platform = process.platform === 'win32' ? 'darwin' : 'win32';
  const architecture = platform === 'win32' ? 'x64' : 'arm64';
  const target = `${platform}-${architecture}`;
  const runtimePath = platform === 'win32' ? 'runtime/python.exe' : 'runtime/bin/python3';
  const dependencyPath = platform === 'win32' ? 'runtime/Lib/site-packages' : 'runtime/lib/python3.12/site-packages';
  const sitePackages = platform === 'win32' ? 'Lib/site-packages' : 'lib/python3.12/site-packages';
  const runtime = archive('cpython', { [`python/${platform === 'win32' ? 'python.exe' : 'bin/python3'}`]: 'fixture portable runtime',
    'python/LICENSE.txt': 'Python license', [`python/${sitePackages}/pip/_vendor/distlib/w32.exe`]: 'unneeded cross-architecture installer' });
  const dependency = archive('fixturedep', { 'fixturedep/__init__.py': 'VALUE = 42\n', 'fixturedep-1.0.0.dist-info/LICENSE': 'dependency license' });
  const lock = { schemaVersion: 1, pythonVersion: '3.12.16', pythonRelease: '20261026', hySourceSha: 'fixture-sha',
    targets: { [target]: { python: runtime, dependencies: [{ ...dependency, name: 'fixturedep', version: '1.0.0' }] } } };
  const downloads = [];
  const download = async (url, destination) => {
    downloads.push(url);
    const artifact = [runtime, dependency].find((item) => item.url === url);
    fs.copyFileSync(artifact.archivePath, destination);
  };
  return { root, runtime, dependency, downloads, target, runtimePath, dependencyPath, options: { lock, platform, architecture, sourceDirectory,
    cacheDirectory: path.join(root, 'cache'), outputDirectory: path.join(root, 'resources'), download } };
}

async function implementation() {
  assert.ok(fs.existsSync(implementationUrl), 'Hy resource preparation must exist');
  return import(implementationUrl.href);
}

test('staging ships a portable interpreter, dependencies, worker and source license with checked resources', async (t) => {
  const { stageHyMemory, verifyHyMemoryResources } = await implementation();
  const { options, target, runtimePath, dependencyPath } = fixture(t);
  const manifest = await stageHyMemory(options);
  assert.equal(fs.readFileSync(path.join(options.outputDirectory, runtimePath), 'utf8'), 'fixture portable runtime');
  assert.equal(fs.readFileSync(path.join(options.outputDirectory, dependencyPath, 'fixturedep/__init__.py'), 'utf8'), 'VALUE = 42\n');
  assert.equal(fs.readFileSync(path.join(options.outputDirectory, 'vendor/LICENSE'), 'utf8'), 'fixture license');
  assert.equal(fs.existsSync(path.join(options.outputDirectory, 'python/tests')), false);
  assert.equal(fs.existsSync(path.join(options.outputDirectory, 'python/__pycache__')), false);
  assert.equal(fs.existsSync(path.join(options.outputDirectory, dependencyPath, 'pip')), false);
  assert.equal(manifest.target, target);
  assert.equal(manifest.runtimeVerified, false);
  assert.equal(verifyHyMemoryResources(options.outputDirectory).target, target);
});

test('an archive integrity failure preserves the last staged runtime and removes the invalid cache file', async (t) => {
  const { stageHyMemory } = await implementation();
  const { options, target } = fixture(t);
  fs.mkdirSync(options.outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(options.outputDirectory, 'previous'), 'last usable runtime');
  options.lock.targets[target].python.sha256 = '0'.repeat(64);
  await assert.rejects(stageHyMemory(options), /checksum/);
  assert.equal(fs.readFileSync(path.join(options.outputDirectory, 'previous'), 'utf8'), 'last usable runtime');
  assert.equal(fs.existsSync(path.join(options.cacheDirectory, 'cpython.tar.gz')), false);
});

test('changed staged bytes and source revisions rebuild from verified cached archives', async (t) => {
  const { stageHyMemory, verifyHyMemoryResources } = await implementation();
  const { options, downloads, runtimePath } = fixture(t);
  const before = await stageHyMemory(options);
  fs.writeFileSync(path.join(options.outputDirectory, runtimePath), 'tampered');
  assert.throws(() => verifyHyMemoryResources(options.outputDirectory), /integrity/);
  fs.writeFileSync(path.join(options.sourceDirectory, 'python/engine.py'), 'ENGINE = "changed"\n');
  const after = await stageHyMemory(options);
  assert.notEqual(after.sourceSha256, before.sourceSha256);
  assert.equal(fs.readFileSync(path.join(options.outputDirectory, runtimePath), 'utf8'), 'fixture portable runtime');
  assert.equal(fs.readFileSync(path.join(options.outputDirectory, 'python/engine.py'), 'utf8'), 'ENGINE = "changed"\n');
  assert.equal(downloads.length, 2);
});

test('dependency changes without a matching lock stop before downloading or replacing resources', async (t) => {
  const { stageHyMemory } = await implementation();
  const { options, downloads } = fixture(t);
  fs.writeFileSync(path.join(options.sourceDirectory, 'requirements.txt'), 'fixturedep==2.0.0\n');
  await assert.rejects(stageHyMemory(options), /requirements.*lock/);
  assert.equal(downloads.length, 0);
  assert.equal(fs.existsSync(options.outputDirectory), false);
});

test('a failed extraction leaves the last valid resources available', async (t) => {
  const { stageHyMemory } = await implementation();
  const { options, dependency, target, runtimePath } = fixture(t);
  await stageHyMemory(options);
  fs.writeFileSync(dependency.archivePath, 'not an archive');
  options.lock.targets[target].dependencies[0].sha256 = digest(dependency.archivePath);
  await assert.rejects(stageHyMemory(options), /extract|archive/i);
  assert.equal(fs.readFileSync(path.join(options.outputDirectory, runtimePath), 'utf8'), 'fixture portable runtime');
  assert.equal(fs.readdirSync(path.dirname(options.outputDirectory)).some((name) => name.startsWith('resources.staging-')), false);
});

test('package verification rejects resources prepared for another platform', async (t) => {
  const { stageHyMemory, verifyHyMemoryResources } = await implementation();
  const { options } = fixture(t);
  await stageHyMemory(options);
  assert.throws(() => verifyHyMemoryResources(options.outputDirectory, { target: 'linux-arm64' }), /target/);
});
