import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const electronRoot = fileURLToPath(new URL('../', import.meta.url));
const lockPath = fileURLToPath(new URL('./hy-memory-runtime.lock.json', import.meta.url));
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = (file) => sha256(fs.readFileSync(file));
const interpreter = (directory, target) => path.join(directory, target.startsWith('win32-') ? 'python.exe' : 'bin/python3');
const tarExecutable = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Hy runtime command failed: ${command}\n${result.stderr?.trim() || result.stdout?.trim() || result.status}`);
  return result.stdout;
}

function extract(archive, destination, python) {
  fs.mkdirSync(destination, { recursive: true });
  const wheel = archive.endsWith('.whl');
  const entries = wheel && python
    ? JSON.parse(run(python, ['-I', '-B', '-c', 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', archive]))
    : run(tarExecutable, ['-tf', archive]).split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('\\') || entry.includes(':') || entry.split('/').includes('..')) {
      throw new Error(`Unsafe Hy runtime archive entry: ${entry}`);
    }
  }
  if (wheel && python) run(python, ['-I', '-B', '-m', 'zipfile', '-e', archive, destination]);
  else run(tarExecutable, ['-xf', archive, '-C', destination]);
}

async function downloadArtifact(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Hy runtime download failed: ${response.status} ${url}`);
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function cachedArtifact(artifact, cacheDirectory, download) {
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || path.basename(artifact.filename) !== artifact.filename) {
    throw new Error('Invalid Hy runtime artifact lock');
  }
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const file = path.join(cacheDirectory, artifact.filename);
  if (fs.existsSync(file) && fileHash(file) === artifact.sha256) return file;
  const temporary = `${file}.download-${process.pid}`;
  try {
    await download(artifact.url, temporary);
    if (fileHash(temporary) !== artifact.sha256) throw new Error(`Hy runtime checksum mismatch: ${artifact.filename}`);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    fs.rmSync(file, { force: true });
    throw error;
  }
  return file;
}

function resourceFiles(directory) {
  const files = [];
  const visit = (folder, relative = '') => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(folder, entry.name);
      if (name === 'manifest.json') continue;
      if (entry.isDirectory()) visit(file, name);
      else if (entry.isSymbolicLink()) {
        const link = fs.readlinkSync(file);
        const resolved = path.resolve(path.dirname(file), link);
        const boundary = path.relative(directory, resolved);
        if (path.isAbsolute(link) || boundary === '..' || boundary.startsWith(`..${path.sep}`)) {
          throw new Error(`Hy runtime symlink escapes resource directory: ${name}`);
        }
        files.push({ path: name, link });
      } else if (entry.isFile()) files.push({ path: name, sha256: fileHash(file), size: fs.statSync(file).size });
      else throw new Error(`Unsupported Hy runtime resource: ${name}`);
    }
  };
  visit(directory);
  return files;
}

export function verifyHyMemoryResources(directory, { target } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (target && manifest.target !== target) throw new Error(`Hy runtime target ${manifest.target} does not match package target ${target}`);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)
    || JSON.stringify(resourceFiles(directory)) !== JSON.stringify(manifest.files)) {
    throw new Error(`Hy runtime resource integrity mismatch: ${directory}`);
  }
  if (!fs.existsSync(interpreter(path.join(directory, 'runtime'), manifest.target))
    || !fs.existsSync(path.join(directory, 'python', 'worker.py'))) {
    throw new Error(`Hy runtime resources are incomplete: ${directory}`);
  }
  return manifest;
}

function checkRequirements(sourceDirectory, dependencies) {
  const pinned = new Map(dependencies.map((dependency) => [dependency.name.replaceAll('_', '-').toLowerCase(), dependency.version]));
  for (const line of fs.readFileSync(path.join(sourceDirectory, 'requirements.txt'), 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const requirement = /^([a-z0-9_-]+)==([^\s;]+)$/i.exec(line.trim());
    if (!requirement || pinned.get(requirement[1].replaceAll('_', '-').toLowerCase()) !== requirement[2]) {
      throw new Error(`Hy requirements do not match the runtime lock: ${line}`);
    }
  }
}

const includeSource = (source) => !source.split(path.sep).some((part) => part === '__pycache__' || part === 'tests')
  && !/\.(?:pyc|pyo)$/.test(source);

function copySource(sourceDirectory, destination) {
  for (const name of ['python', 'vendor']) {
    fs.cpSync(path.join(sourceDirectory, name), path.join(destination, name), { recursive: true, filter: includeSource });
  }
  fs.copyFileSync(path.join(sourceDirectory, 'requirements.txt'), path.join(destination, 'requirements.txt'));
}

function installDependency(artifact, archive, sitePackages, temporaryRoot, python) {
  if (!artifact.sourcePackage) {
    extract(archive, sitePackages, python);
    // Wheels may place importable modules in a .data directory.
    for (const name of fs.readdirSync(sitePackages).filter((entry) => entry.endsWith('.data'))) {
      const data = path.join(sitePackages, name);
      for (const kind of ['purelib', 'platlib']) {
        if (fs.existsSync(path.join(data, kind))) fs.cpSync(path.join(data, kind), sitePackages, { recursive: true });
      }
      fs.rmSync(data, { recursive: true, force: true });
    }
    return;
  }
  // jieba and langdetect publish pure Python source archives. Copy only their
  // importable package and license metadata; no setup.py or build hook executes.
  const unpacked = path.join(temporaryRoot, artifact.name);
  extract(archive, unpacked);
  const root = path.join(unpacked, `${artifact.name}-${artifact.version}`);
  fs.cpSync(path.join(root, artifact.sourcePackage), path.join(sitePackages, artifact.sourcePackage), { recursive: true, filter: includeSource });
  const metadata = path.join(sitePackages, `${artifact.name.replaceAll('-', '_')}-${artifact.version}.dist-info`);
  fs.mkdirSync(metadata, { recursive: true });
  fs.writeFileSync(path.join(metadata, 'METADATA'), `Metadata-Version: 2.1\nName: ${artifact.name}\nVersion: ${artifact.version}\n`);
  for (const name of fs.readdirSync(root).filter((entry) => /^(LICENSE|COPYING|NOTICE)/i.test(entry))) {
    fs.cpSync(path.join(root, name), path.join(metadata, name), { recursive: true });
  }
  fs.rmSync(unpacked, { recursive: true, force: true });
}

function verifyNativeWorker(directory, target, lock) {
  if (target !== `${process.platform}-${process.arch}`) return false;
  const env = Object.fromEntries(['LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'SYSTEMDRIVE']
    .filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
  Object.assign(env, { PATH: '', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' });
  const binary = interpreter(path.join(directory, 'runtime'), target);
  const version = run(binary, ['-I', '-B', '-c', 'import platform,numpy,pydantic,sklearn,scipy,langdetect,json_repair,rank_bm25,jieba; print(platform.python_version())'], { env });
  if (version.trim() !== lock.pythonVersion) throw new Error('Bundled Hy Python runtime version mismatch');
  const result = spawnSync(binary, [path.join(directory, 'python', 'worker.py')], {
    input: '{"id":"packaging","method":"capabilities","params":{}}\n', encoding: 'utf8',
    env,
    windowsHide: true, timeout: 60_000,
  });
  if (result.error) throw result.error;
  let response;
  try { response = JSON.parse(result.stdout.trim().split(/\r?\n/)[0]); } catch { /* Report a bounded startup error. */ }
  if (result.status !== 0 || response?.result?.engine !== 'hy-memory' || response.result.source_sha !== lock.hySourceSha) {
    throw new Error(`Bundled Hy Python worker failed its capabilities handshake: ${result.stderr?.slice(0, 2000) || result.status}`);
  }
  return true;
}

export async function stageHyMemory({
  platform = process.platform, architecture = resolveTargetArchitecture().node,
  sourceDirectory = path.resolve(electronRoot, '../web/server/lib/hy-memory'),
  outputDirectory = path.join(electronRoot, 'resources/hy-memory'),
  cacheDirectory = path.join(electronRoot, '.cache/hy-memory/downloads'),
  lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')), download = downloadArtifact,
} = {}) {
  const target = `${platform}-${architecture}`;
  const artifacts = lock.targets[target];
  if (lock.schemaVersion !== 1 || !artifacts) throw new Error(`No pinned Hy Python runtime for ${target}`);
  const dependencies = [...(lock.dependencies || []), ...artifacts.dependencies];
  checkRequirements(sourceDirectory, dependencies);
  const lockSha256 = sha256(JSON.stringify(lock));
  fs.mkdirSync(path.dirname(outputDirectory), { recursive: true });
  const staging = fs.mkdtempSync(`${outputDirectory}.staging-`);
  const previous = `${outputDirectory}.previous-${process.pid}`;
  try {
    copySource(sourceDirectory, staging);
    const sourceSha256 = sha256(JSON.stringify(resourceFiles(staging)));
    const runtimeArchive = await cachedArtifact(artifacts.python, cacheDirectory, download);
    const unpacked = path.join(staging, '.unpacked');
    extract(runtimeArchive, unpacked);
    fs.renameSync(path.join(unpacked, 'python'), path.join(staging, 'runtime'));
    const sitePackages = path.join(staging, 'runtime', platform === 'win32' ? 'Lib/site-packages' : 'lib/python3.12/site-packages');
    fs.mkdirSync(sitePackages, { recursive: true });
    // Runtime installation is complete before distribution. Pip's bundled
    // Windows launcher executables include other architectures.
    for (const name of fs.readdirSync(sitePackages).filter((entry) => entry === 'pip' || /^pip-.*\.dist-info$/.test(entry))) {
      fs.rmSync(path.join(sitePackages, name), { recursive: true, force: true });
    }
    const scripts = path.join(staging, 'runtime', platform === 'win32' ? 'Scripts' : 'bin');
    if (fs.existsSync(scripts)) {
      for (const name of fs.readdirSync(scripts).filter((entry) => /^pip(?:\d|\.|$)/.test(entry))) fs.rmSync(path.join(scripts, name), { force: true });
    }
    const python = target === `${process.platform}-${process.arch}` ? interpreter(path.join(staging, 'runtime'), target) : undefined;
    for (const artifact of dependencies) {
      const archive = await cachedArtifact(artifact, cacheDirectory, download);
      installDependency(artifact, archive, sitePackages, unpacked, python);
    }
    fs.rmSync(unpacked, { recursive: true, force: true });
    const manifest = { schemaVersion: 1, target, pythonVersion: lock.pythonVersion, pythonRelease: lock.pythonRelease,
      hySourceSha: lock.hySourceSha, sourceSha256, lockSha256, runtimeVerified: verifyNativeWorker(staging, target, lock),
      artifacts: [artifacts.python, ...dependencies].map(({ filename, url, sha256: hash }) => ({ filename, url, sha256: hash })),
      files: resourceFiles(staging) };
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    verifyHyMemoryResources(staging);
    if (fs.existsSync(outputDirectory)) fs.renameSync(outputDirectory, previous);
    try { fs.renameSync(staging, outputDirectory); }
    catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, outputDirectory);
      throw error;
    }
    fs.rmSync(previous, { recursive: true, force: true });
    return manifest;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requestedTarget = process.argv.find((argument) => argument.startsWith('--target='))?.slice('--target='.length);
  const requestedOutput = process.argv.find((argument) => argument.startsWith('--output='))?.slice('--output='.length);
  const [platform, architecture] = requestedTarget?.split('-') || [];
  const options = {};
  if (platform) { options.platform = platform; options.architecture = architecture; }
  if (requestedOutput) options.outputDirectory = path.resolve(requestedOutput);
  stageHyMemory(options)
    .then((manifest) => console.log(`[hy-memory] staged ${manifest.target}, Python ${manifest.pythonVersion}, native handshake ${manifest.runtimeVerified ? 'passed' : 'not run on this host'}`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
