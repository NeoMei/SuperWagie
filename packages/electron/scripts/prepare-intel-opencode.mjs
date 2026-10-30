import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMachOSlices } from '../../../scripts/verify-intel-compat.mjs';
import { readPinnedOpenCodeCliVersion, parseOpenCodeCliVersion } from './opencode-cli-version.mjs';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sourceLock = Object.freeze({
  version: '2.1.4',
  commit: '68bc26b7da1990ce10ffecfbc1e09eb13aa5d824',
  url: 'https://api.github.com/repos/anomalyco/opencode/tarball/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824',
  sha256: 'ae69c87a4991b3ac90fd112fe439119dbaeb77bc76cbdfd63b6dac601bd6904b',
});
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status}): ${result.stderr || result.stdout || ''}`);
  return result.stdout;
};

export function verifySourceArchive(archive) {
  if (sha256(archive) !== sourceLock.sha256) throw new Error('OpenCode source archive SHA-256 mismatch');
}

// Fail before packaging if an upstream prebuild raises its deployment target.
export function inspectMachO(buffer) {
  if (buffer.length < 4 || ![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(buffer.readUInt32BE(0))) return undefined;
  const slices = readMachOSlices(buffer);
  const slice = slices.find((value) => value.cpu === 0x01000007) || slices[0];
  const architecture = slice.cpu === 0x01000007 ? 'x64' : slice.cpu === 0x0100000c ? 'arm64' : `cpu-${slice.cpu}`;
  const minimumVersion = `${slice.minimumVersion >>> 16}.${(slice.minimumVersion >>> 8) & 255}.${slice.minimumVersion & 255}`;
  return { architecture, minimumVersion };
}

export function runtimeFiles() {
  return {
    opencode: `#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "\${1-}" in
  serve|--version|-v|--help|-h) ;;
  *) printf '%s\\n' 'This bundled OpenCode engine provides the SuperWagie local API. Use SuperWagie for interactive sessions; terminal CLI commands are unavailable in this macOS compatibility build.' >&2; exit 64 ;;
esac
exec "$here/node" --use-system-ca --disable-warning=ExperimentalWarning "$here/opencode.mjs" "$@"
`,
    node: `#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
electron="$here/../../MacOS/犇马"
if [ ! -x "$electron" ]; then
  electron="$here/../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
fi
if [ ! -x "$electron" ]; then
  printf '%s\\n' 'The bundled Electron runtime is missing. Reinstall SuperWagie.' >&2
  exit 1
fi
export ELECTRON_RUN_AS_NODE=1
exec "$electron" --import "$here/runtime-init.mjs" "$@"
`,
    'runtime-init.mjs': `import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
// Electron's launch flag must not reach model tools or user child processes.
delete process.env.ELECTRON_RUN_AS_NODE;
// Upstream selfCommand and child_process.fork require a Node-shaped launcher.
process.execPath = path.join(root, 'node');
process.argv[0] = process.execPath;
process.env.PATH = [root, path.resolve(root, '../ripgrep'), process.env.PATH || '/usr/bin:/bin'].join(path.delimiter);
`,
  };
}

const builder = String.raw`
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { mainConfig, appArchiveAsset } from './vite.node.config'
import { copyNodeAssets, hashNodeAssets } from './script/node-assets'
import { collectFiles } from './script/files'
import { resolveOpencodePty } from './script/opencode-pty'
import { nodeTarget, photonWasmAsset, shellParserWasmAssets } from './src/node/target'
import { AppArchive } from './src/app-archive'
const target = nodeTarget('darwin', process.env.SUPERWAGIE_OPENCODE_ARCH)
const require = createRequire(import.meta.url)
const coreRequire = createRequire(path.resolve('../../packages/core/package.json'))
const resolve = (name) => { try { return require.resolve(name) } catch { return coreRequire.resolve(name) } }
const ptyRoot = path.resolve(path.dirname(resolve(target.nodePtyPackage)), '..')
const persistentPty = await resolveOpencodePty(target)
const assets = [
  { key: target.parcelWatcherAsset, source: resolve(target.parcelWatcherPackage) },
  { key: photonWasmAsset, source: resolve(photonWasmAsset) },
  ...Object.values(shellParserWasmAssets).map((key) => ({ key, source: resolve(key) })),
  ...await Promise.all((await collectFiles(ptyRoot)).filter((file) => !file.endsWith('.map') && !file.endsWith('.pdb')).map(async (file) => ({ key: target.nodePtyPackage + '/' + file, source: path.join(ptyRoot, file) }))),
  ...(persistentPty ? [{ key: target.opencodePtyAsset, source: persistentPty.source }] : []),
]
await fs.rm('dist-node', { recursive: true, force: true })
await copyNodeAssets(assets)
await fs.writeFile('dist-node/assets/' + appArchiveAsset, AppArchive.encode([]))
const config = mainConfig({ version: '2.1.4', channel: 'latest', assetHash: await hashNodeAssets(assets), target })
config.build = { ...config.build, target: 'node24' }
config.define.OPENCODE_CLI_NAME = JSON.stringify('opencode')
// The upstream graph check requires TUI simulation renderers. The desktop API keeps its control server.
config.plugins = config.plugins.filter((plugin) => plugin.name !== 'opencode:simulation-graph')
const packages = new Map()
config.plugins.unshift({
  name: 'superwagie:headless-node24',
  enforce: 'pre',
  async load(id) {
    const normalized = id.replaceAll('\\', '/')
    if (normalized.includes('/cli/src/commands/handlers/') && !normalized.endsWith('/handlers/serve.ts'))
      return 'import { Effect } from "effect"; export default () => Effect.fail(new Error("Use SuperWagie for interactive sessions; this engine provides serve, --version and --help only."))'
    // CLI configuration migration needs schemas, while these TSX provider tails would import the native terminal renderer.
    if (normalized.endsWith('/tui/src/config/index.tsx') || normalized.endsWith('/tui/src/config/v1/index.tsx')) {
      const source = await fs.readFile(id, 'utf8')
      const marker = '\nconst ConfigContext = createContext<'
      if (!source.includes(marker)) throw new Error('OpenCode TUI config provider boundary changed')
      return source.slice(0, source.indexOf(marker)).replace(/^import .* from [\"'](?:solid-js(?:\/store)?|\.\.\/util\/watch)[\"']\n/gm, '')
    }
    if (!normalized.endsWith('/core/src/filesystem/fff.node.ts')) return
    const source = await fs.readFile(id, 'utf8')
    const needle = 'const { FileFinder } = await import("@ff-labs/fff-node").catch(() => ({ FileFinder: undefined }))'
    if (!source.includes(needle)) throw new Error('OpenCode FFF adapter changed')
    return source.replace(needle, 'const FileFinder = undefined')
  },
  async generateBundle() {
    const modules = [...this.getModuleIds()].map((id) => id.replaceAll('\\', '/'))
    if (!modules.some((id) => id.endsWith('/packages/simulation/src/control-server.ts'))) throw new Error('Headless simulation control server missing')
    const unsupported = modules.filter((id) => id.includes('/ffi-rs/') || id.includes('/fff-node/') || id.includes('/@opentui/core/') || id.includes('/@opentui/solid/'))
    if (unsupported.length) throw new Error('Unsupported native TUI/FFF module entered the headless graph: ' + unsupported.map((id) => id + ' <- ' + this.getModuleInfo(id)?.importers.join(', ')).join('\n'))
    for (const id of this.getModuleIds()) {
      if (!path.isAbsolute(id)) continue
      let directory = path.dirname(id.split('?')[0])
      while (directory !== path.dirname(directory)) {
        const manifestPath = path.join(directory, 'package.json')
        try {
          const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
          if (manifest.name && manifest.version) packages.set(directory, manifest)
          break
        } catch { directory = path.dirname(directory) }
      }
    }
  },
})
await build(config)
const licenseRoot = path.resolve('dist-node/licenses')
await fs.mkdir(licenseRoot, { recursive: true })
const licenses = []
// Native assets loaded through paths are absent from Rollup's JavaScript module graph.
for (const asset of assets) {
  let directory = path.dirname(asset.source)
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
      if (manifest.name && manifest.version) packages.set(directory, manifest)
      break
    } catch { directory = path.dirname(directory) }
  }
}
for (const [directory, manifest] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const name = manifest.name.replaceAll('/', '__') + '@' + manifest.version
  const files = []
  for (const file of await fs.readdir(directory)) {
    if (!/^(license|licence|copying|notice)(\.|$)/i.test(file)) continue
    if (!(await fs.stat(path.join(directory, file))).isFile()) continue
    await fs.mkdir(path.join(licenseRoot, name), { recursive: true })
    await fs.copyFile(path.join(directory, file), path.join(licenseRoot, name, file))
    files.push(name + '/' + file)
  }
  licenses.push({ name: manifest.name, version: manifest.version, license: manifest.license, files })
}
await fs.copyFile('../../LICENSE', 'dist-node/LICENSE.opencode')
await fs.writeFile('dist-node/third-party-licenses.json', JSON.stringify(licenses, null, 2) + '\n')
`;

const inventory = (root, directory = root) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name);
  if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in staged engine: ${file}`);
  if (entry.isDirectory()) return inventory(root, file);
  return [{ path: path.relative(root, file).split(path.sep).join('/'), size: fs.statSync(file).size, sha256: sha256(file) }];
});

export async function prepareIntelOpenCode(options = {}) {
  if (process.platform !== 'darwin') throw new Error('Intel compatibility OpenCode preparation requires macOS');
  const arch = 'x64';
  if (readPinnedOpenCodeCliVersion() !== sourceLock.version) throw new Error('Update the reviewed Node24 source lock before changing the OpenCode version');
  const cache = path.resolve(options.cacheRoot || path.join(electronRoot, '.cache/opencode-node24', sourceLock.version));
  const output = path.resolve(options.outputDir || path.join(electronRoot, 'resources/opencode-cli'));
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, 'source.tar.gz');
  if (!fs.existsSync(archive)) {
    const response = await fetch(sourceLock.url);
    if (!response.ok) throw new Error(`OpenCode source download failed: HTTP ${response.status}`);
    const temporary = `${archive}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
    try { verifySourceArchive(temporary); fs.renameSync(temporary, archive); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  verifySourceArchive(archive);
  const source = path.join(cache, 'source');
  fs.rmSync(source, { recursive: true, force: true });
  fs.mkdirSync(source, { recursive: true });
  run('/usr/bin/tar', ['-xzf', archive, '--strip-components=1', '-C', source]);
  const originalLock = sha256(path.join(source, 'bun.lock'));
  // Build-only dependencies stay in this verified upstream checkout.
  run('bun', ['install', '--frozen-lockfile', '--ignore-scripts', '--cpu=*', '--os=darwin'], { cwd: source, stdio: 'inherit' });
  if (sha256(path.join(source, 'bun.lock')) !== originalLock) throw new Error('Upstream frozen install modified bun.lock');
  const targetFile = path.join(source, 'packages/cli/src/node/target.ts');
  const targetSource = fs.readFileSync(targetFile, 'utf8');
  const flag = '"--experimental-ffi", ';
  if (!targetSource.includes(flag)) throw new Error('OpenCode Node flags changed');
  fs.writeFileSync(targetFile, targetSource.replace(flag, ''));
  const cli = path.join(source, 'packages/cli');
  fs.writeFileSync(path.join(cli, 'superwagie-build.ts'), builder);
  run('bun', ['run', 'superwagie-build.ts'], { cwd: cli, env: { ...process.env, SUPERWAGIE_OPENCODE_ARCH: arch }, stdio: 'inherit' });
  const staging = `${output}.${process.pid}.tmp`;
  const backup = `${output}.${process.pid}.previous`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.cpSync(path.join(cli, 'dist-node'), staging, { recursive: true });
    for (const [name, contents] of Object.entries(runtimeFiles())) fs.writeFileSync(path.join(staging, name), contents, { mode: name.endsWith('.mjs') ? 0o644 : 0o755 });
    const nativeAssets = [];
    for (const file of inventory(staging)) {
      const macho = inspectMachO(fs.readFileSync(path.join(staging, file.path)));
      if (!macho) continue;
      if (macho.architecture !== arch || !macho.minimumVersion || macho.minimumVersion.split('.').reduce((value, part) => value * 256 + Number(part), 0) > (12 << 16))
        throw new Error(`Incompatible OpenCode native asset: ${file.path} (${macho.architecture}, macOS ${macho.minimumVersion || 'unknown'})`);
      nativeAssets.push({ path: file.path, ...macho });
      if (!file.path.endsWith('.node')) fs.chmodSync(path.join(staging, file.path), 0o755);
    }
    if (nativeAssets.length !== 4) throw new Error(`Expected PTY addon/helper, persistent PTY and watcher, found ${nativeAssets.length}`);
    const manifest = {
      version: sourceLock.version, platform: 'darwin', arch, binary: 'opencode', sourceCommit: sourceLock.commit,
      source: { url: sourceLock.url, sha256: sourceLock.sha256, lockSha256: originalLock },
      runtime: { kind: 'electron-node24', serverOnly: true },
      capabilities: { api: true, plugins: true, pty: true, search: 'ripgrep', tui: false, cli: ['serve', '--version', '--help'] },
      nativeAssets, files: inventory(staging),
    };
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const electron = options.electron || path.join(electronRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    const validationHome = path.join(cache, 'validation-home');
    fs.mkdirSync(validationHome, { recursive: true });
    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin', HOME: validationHome, ELECTRON_RUN_AS_NODE: '1',
      XDG_CONFIG_HOME: path.join(validationHome, 'config'), XDG_DATA_HOME: path.join(validationHome, 'data'),
      XDG_CACHE_HOME: path.join(validationHome, 'cache'), XDG_STATE_HOME: path.join(validationHome, 'state'),
    };
    const runtime = JSON.parse(run(electron, ['-p', 'JSON.stringify({arch:process.arch,node:process.versions.node,electron:process.versions.electron})'], { env, timeout: 30000 }));
    if (runtime.arch !== arch || !runtime.node.startsWith('24.') || runtime.electron !== '43.8.4') throw new Error('OpenCode compatibility staging requires target-architecture Electron 43.8.4 with Node 24');
    const version = run(electron, ['--import', path.join(staging, 'runtime-init.mjs'), path.join(staging, 'opencode.mjs'), '--version'], { env, timeout: 30000 });
    if (parseOpenCodeCliVersion(version) !== sourceLock.version) throw new Error('Prepared Node24 engine version mismatch');
    // The previous complete engine remains available until staging is validated.
    if (fs.existsSync(output)) fs.renameSync(output, backup);
    try { fs.renameSync(staging, output); }
    catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, output); throw error; }
    fs.rmSync(backup, { recursive: true, force: true });
    console.log(`[electron] prepared local OpenCode ${sourceLock.version} for darwin-${arch}: ${output}`);
    return manifest;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--cache-root=')) options.cacheRoot = arg.slice(13);
    else if (arg.startsWith('--output-dir=')) options.outputDir = arg.slice(13);
    else if (arg.startsWith('--electron=')) options.electron = arg.slice(11);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  prepareIntelOpenCode(options).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
