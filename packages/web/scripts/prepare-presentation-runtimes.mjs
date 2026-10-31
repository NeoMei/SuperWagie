import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveNpmCommand } from '../../../scripts/lib/npm-command.mjs';
import { inventory, BUNDLE, writeBundleIdentity } from '../server/lib/builtin-skills/managed-tree.js';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
export const presentationNames = ['superppt', 'image-to-editable-pptx'];
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hostLibc = () => process.platform === 'linux' ? (process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl') : null;
const json = async (filename) => JSON.parse(await fs.readFile(filename, 'utf8'));

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Presentation runtime command failed with exit ${result.status}`);
}

export function requireNativeTarget(platform, arch) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) throw new Error('Unsupported presentation runtime target');
  if (platform !== process.platform || arch !== process.arch) throw new Error(`Presentation runtime ${platform}-${arch} requires a native build worker; host is ${process.platform}-${process.arch}`);
}

async function verifySources(source) {
  const snapshot = await json(path.join(source, 'VENDOR-SNAPSHOT.json'));
  for (const entry of snapshot.files) {
    if (sha(await fs.readFile(path.join(source, entry.path))) !== entry.shippedSha256) throw new Error(`Presentation vendor fingerprint changed: ${entry.path}`);
  }
  return snapshot;
}

export async function verifyPresentationResource(root, { platform = process.platform, arch = process.arch, source = path.join(webRoot, 'server/builtin-skills', path.basename(root)) } = {}) {
  const manifest = await json(path.join(root, 'superwagie-runtime.json'));
  if (manifest.schema !== 1 || manifest.platform !== platform || manifest.arch !== arch || (platform === process.platform && arch === process.arch && manifest.libc !== hostLibc())) throw new Error('Presentation runtime target does not match this package');
  const sourceSnapshot = await fs.readFile(path.join(source, 'VENDOR-SNAPSHOT.json'));
  if (manifest.sourceSnapshotSha256 !== sha(sourceSnapshot) || manifest.version !== JSON.parse(sourceSnapshot).version) throw new Error('Presentation runtime was built from a stale vendor snapshot');
  const files = (await inventory(root, { ignoreBundle: true })).entries.filter((entry) => entry[0] !== 'superwagie-runtime.json');
  if (sha(JSON.stringify(files)) !== manifest.payloadSha256) throw new Error('Presentation runtime payload inventory does not match');
  for (const required of ['dist/src/cli.js', 'src/cli.ts', 'LICENSE', 'vendor/modules/sharp/package.json']) await fs.access(path.join(root, required));
  return manifest;
}

async function stageComponent(name, source, destination, platform, arch) {
  const snapshot = await verifySources(source);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'superwagie-presentation-'));
  try {
    await fs.cp(source, scratch, { recursive: true, filter: (entry) => !['node_modules', 'vendor', 'dist', BUNDLE].includes(path.basename(entry)) });
    const npm = resolveNpmCommand();
    run(npm.command, [...npm.args, 'ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund'], scratch);
    run(npm.command, [...npm.args, 'run', 'build'], scratch);
    run(npm.command, [...npm.args, 'prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], scratch);
    const modules = path.join(scratch, 'node_modules');
    const native = [];
    for (const scope of ['@img', '@esbuild']) {
      const directory = path.join(modules, scope);
      const names = await fs.readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
      for (const entry of names) {
        const info = await json(path.join(directory, entry, 'package.json'));
        if ((info.os && !info.os.includes(platform)) || (info.cpu && !info.cpu.includes(arch))) throw new Error(`Foreign native package ${scope}/${entry}`);
        native.push({ name: info.name, version: info.version });
      }
    }
    if (!native.some((entry) => entry.name === `@img/sharp-${platform}-${arch}` || entry.name === `@img/sharp-linuxmusl-${arch}`)) throw new Error('Target Sharp package missing');
    run(process.execPath, ['--input-type=module', '-e', 'import sharp from "sharp"; const pixels=await sharp({create:{width:8,height:8,channels:4,background:"red"}}).png().toBuffer(); if((await sharp(pixels).metadata()).width!==8) throw Error("Sharp smoke failed");'], scratch);
    if (name === 'superppt') run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', 'await import("./src/generation/task-batch.ts");'], scratch);
    else run(process.execPath, ['--input-type=module', '-e', 'await import("./dist/src/pipeline.js");'], scratch);
    await fs.mkdir(destination, { recursive: true });
    await fs.cp(source, destination, { recursive: true, filter: (entry) => !['node_modules', 'vendor', 'dist', BUNDLE, 'tests'].includes(path.basename(entry)) });
    await fs.cp(path.join(scratch, 'dist/src'), path.join(destination, 'dist/src'), { recursive: true });
    try { await fs.cp(path.join(scratch, 'dist/scripts'), path.join(destination, 'dist/scripts'), { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(path.join(destination, 'vendor'), { recursive: true });
    await fs.cp(modules, path.join(destination, 'vendor/modules'), { recursive: true, dereference: true, filter: (entry) => !['.bin', '.package-lock.json'].includes(path.basename(entry)) });
    // npm excludes nested node_modules even inside vendor. Encode only that
    // directory name; the managed installer reverses it inside the closure.
    async function encodeModules(directory) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name === '__superwagie_node_modules__') throw new Error('Reserved dependency transport directory');
        if (!entry.isDirectory()) continue;
        const current = path.join(directory, entry.name);
        await encodeModules(current);
        if (entry.name === 'node_modules') await fs.rename(current, path.join(directory, '__superwagie_node_modules__'));
      }
    }
    await encodeModules(path.join(destination, 'vendor/modules'));
    // npm omits these metadata files and empty directories. Remove them before
    // stamping so physical Electron and npm payloads have identical inventories.
    async function removePackOmissions(directory) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (['.npmrc', '.npmignore', '.gitignore'].includes(entry.name)) await fs.rm(filename);
        else if (entry.isDirectory()) {
          await removePackOmissions(filename);
          if (!(await fs.readdir(filename)).length) await fs.rmdir(filename);
        }
      }
    }
    await removePackOmissions(destination);
    const tree = await inventory(destination, { ignoreBundle: true });
    const manifest = { schema: 1, component: name, version: snapshot.version, platform, arch, libc: hostLibc(), native, sourceSnapshotSha256: sha(await fs.readFile(path.join(source, 'VENDOR-SNAPSHOT.json'))), payloadSha256: sha(JSON.stringify(tree.entries)) };
    await fs.writeFile(path.join(destination, 'superwagie-runtime.json'), `${JSON.stringify(manifest)}\n`);
    await writeBundleIdentity(destination);
    await verifyPresentationResource(destination, { platform, arch, source });
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

export async function preparePresentationRuntimes({ source = path.join(webRoot, 'server/builtin-skills'), destination = path.join(webRoot, 'server/presentation-runtime'), platform = process.platform, arch = process.env.OPENCHAMBER_TARGET_ARCH || process.env.ELECTRON_BUILDER_ARCH || process.arch } = {}) {
  requireNativeTarget(platform, arch);
  const stage = `${destination}.stage-${randomUUID()}`;
  const backup = `${destination}.previous-${randomUUID()}`;
  let moved = false;
  try {
    for (const name of presentationNames) await stageComponent(name, path.join(source, name), path.join(stage, name), platform, arch);
    try { await fs.rename(destination, backup); moved = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(stage, destination); }
    catch (error) { if (moved) await fs.rename(backup, destination); throw error; }
    if (moved) await fs.rm(backup, { recursive: true, force: true });
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await preparePresentationRuntimes();
