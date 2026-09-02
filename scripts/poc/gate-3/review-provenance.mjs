import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const PLACEHOLDER = /^(?:task-8-explicit|unknown|default|0+)$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const RENDERER_IDENTITY_KEYS = [
  'platform', 'machine', 'wps', 'python_executable_sha256',
  'wpscomposer_source_sha256', 'font_manifest_sha256', 'render_options'
];
const RENDERER_PROVENANCE_KEYS = [
  'schema_id', 'schema_version', ...RENDERER_IDENTITY_KEYS,
  'renderer_environment_sha256'
];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function cleanIdentity(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || PLACEHOLDER.test(value)
    || /[\\/]/.test(value)) throw new Error(`${label} is incomplete or path-bearing`);
  return value;
}

export function buildPathFreeProvenance(input) {
  const platform = cleanIdentity(input.platform, 'platform');
  const profileId = cleanIdentity(input.machineProfileId, 'machine profile');
  const wpsVersion = cleanIdentity(input.wpsVersion, 'WPS version');
  const bridgeIdentity = cleanIdentity(input.bridgeIdentity, 'WPS bridge identity');
  const applicationIdentity = input.wpsApplicationIdentity;
  if (!applicationIdentity || Object.keys(applicationIdentity).sort().join('\0') !== ['target_kind', 'executable_sha256', 'bundle_manifest_sha256', 'bridge_sha256'].sort().join('\0')
    || !['macos-app-bundle', 'windows-executable'].includes(applicationIdentity.target_kind)
    || ![applicationIdentity.executable_sha256, applicationIdentity.bundle_manifest_sha256, applicationIdentity.bridge_sha256].every((value) => /^[0-9a-f]{64}$/.test(value))) {
    throw new Error('WPS application identity is incomplete');
  }
  if ((platform.startsWith('macos-') && applicationIdentity.target_kind !== 'macos-app-bundle')
    || (platform === 'windows-11-x64' && applicationIdentity.target_kind !== 'windows-executable')
    || (!platform.startsWith('macos-') && platform !== 'windows-11-x64')) throw new Error('WPS application identity does not match platform');
  if (bridgeIdentity !== `sha256:${applicationIdentity.bridge_sha256}`) throw new Error('WPS bridge identity mismatch');
  if (!Buffer.isBuffer(input.pythonBytes) || input.pythonBytes.length === 0) throw new Error('python executable bytes required');
  if (!Array.isArray(input.wpsComposerFiles) || input.wpsComposerFiles.length === 0) throw new Error('WPSComposer source required');
  const sourceRecords = input.wpsComposerFiles.map(({ identity, bytes }) => {
    if (typeof identity !== 'string' || identity.length === 0 || pathBearing(identity) || !Buffer.isBuffer(bytes)) throw new Error('source record invalid');
    return { identity, sha256: sha(bytes) };
  }).sort((a, b) => a.identity.localeCompare(b.identity));
  if (!Array.isArray(input.fontRecords) || input.fontRecords.length === 0) throw new Error('font inventory required');
  const fonts = input.fontRecords.map((font) => {
    if (!font || typeof font.family !== 'string' || !font.family || typeof font.version !== 'string' || !font.version
      || typeof font.style !== 'string' || !font.style || [font.family, font.version, font.style].some(pathBearing)) throw new Error('font record invalid');
    return { family: font.family, style: font.style, version: font.version };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const renderOptions = stable(input.renderOptions ?? {});
  assertPathFreeValue(renderOptions, 'renderer options');
  const pythonExecutableSha256 = sha(input.pythonBytes);
  const sourceSha256 = sha(JSON.stringify(sourceRecords));
  const fontSha256 = sha(JSON.stringify(fonts));
  const identity = {
    platform,
    machine: { profile_id: profileId, representative: input.representative === true },
    wps: { application: 'WPS', exact_version: wpsVersion, bridge_identity: bridgeIdentity, application_identity: applicationIdentity },
    python_executable_sha256: pythonExecutableSha256,
    wpscomposer_source_sha256: sourceSha256,
    font_manifest_sha256: fontSha256,
    render_options: renderOptions
  };
  return {
    schema_id: 'superwagie.review-renderer-provenance.v1',
    schema_version: 1,
    ...identity,
    renderer_environment_sha256: rendererEnvironmentSha256(identity)
  };
}

export function rendererEnvironmentSha256(identity) {
  if (!exactKeys(identity, RENDERER_IDENTITY_KEYS)) throw new Error('renderer identity invalid');
  return sha(JSON.stringify(stable(identity)));
}

export function validateRendererProvenanceDocument(document, expected = {}) {
  if (!exactKeys(document, RENDERER_PROVENANCE_KEYS)
    || document.schema_id !== 'superwagie.review-renderer-provenance.v1'
    || document.schema_version !== 1) {
    throw new Error('renderer provenance schema invalid');
  }
  const platform = cleanIdentity(document.platform, 'platform');
  if (expected.platform !== undefined && platform !== expected.platform) {
    throw new Error('renderer provenance platform mismatch');
  }
  if (!exactKeys(document.machine, ['profile_id', 'representative'])
    || cleanIdentity(document.machine.profile_id, 'machine profile') !== document.machine.profile_id
    || typeof document.machine.representative !== 'boolean'
    || (expected.representative !== undefined
      && document.machine.representative !== expected.representative)) {
    throw new Error('renderer provenance machine profile invalid');
  }
  if (!exactKeys(document.wps, ['application', 'exact_version', 'bridge_identity', 'application_identity'])
    || document.wps.application !== 'WPS'
    || cleanIdentity(document.wps.exact_version, 'WPS version') !== document.wps.exact_version
    || !/^sha256:[0-9a-f]{64}$/.test(document.wps.bridge_identity ?? '')) {
    throw new Error('renderer provenance WPS identity invalid');
  }
  const application = document.wps.application_identity;
  if (!exactKeys(application, ['target_kind', 'executable_sha256', 'bundle_manifest_sha256', 'bridge_sha256'])
    || !['macos-app-bundle', 'windows-executable'].includes(application.target_kind)
    || ![application.executable_sha256, application.bundle_manifest_sha256, application.bridge_sha256].every((value) => SHA256.test(value ?? ''))
    || (platform.startsWith('macos-') && application.target_kind !== 'macos-app-bundle')
    || (platform === 'windows-11-x64' && application.target_kind !== 'windows-executable')
    || (!platform.startsWith('macos-') && platform !== 'windows-11-x64')) {
    throw new Error('renderer provenance application identity invalid');
  }
  if (document.wps.bridge_identity !== `sha256:${application.bridge_sha256}`) {
    throw new Error('renderer provenance bridge identity mismatch');
  }
  if (![document.python_executable_sha256, document.wpscomposer_source_sha256,
    document.font_manifest_sha256, document.renderer_environment_sha256]
    .every((value) => SHA256.test(value ?? ''))) {
    throw new Error('renderer provenance interpreter, source, font, or digest identity invalid');
  }
  if (!document.render_options || typeof document.render_options !== 'object'
    || Array.isArray(document.render_options)) {
    throw new Error('renderer provenance options identity invalid');
  }
  assertPathFreeValue(document, 'renderer provenance');
  const identity = Object.fromEntries(RENDERER_IDENTITY_KEYS.map((key) => [key, document[key]]));
  const rendererEnvironmentDigest = rendererEnvironmentSha256(identity);
  if (document.renderer_environment_sha256 !== rendererEnvironmentDigest) {
    throw new Error('renderer provenance canonical digest mismatch');
  }
  return {
    rendererEnvironmentSha256: rendererEnvironmentDigest,
    identity: structuredClone(identity)
  };
}

export async function captureTrustedProvenance({ wpsPython, wpsComposerRoot, wpsApplication, machineProfile, platform, platformServices = {} }) {
  for (const value of [wpsPython, wpsComposerRoot, wpsApplication, machineProfile]) if (!path.isAbsolute(value ?? '')) throw new Error('provenance inputs must be absolute');
  const profile = JSON.parse(await readFile(machineProfile, 'utf8'));
  if (!profile || Object.keys(profile).sort().join('\0') !== ['schema_id', 'schema_version', 'profile_id', 'platform', 'representative', 'wps', 'render_options'].sort().join('\0')
    || profile.schema_id !== 'superwagie.review-machine-profile.v1' || profile.schema_version !== 1
    || profile.platform !== platform || typeof profile.representative !== 'boolean'
    || !profile.wps || profile.wps.application !== 'WPS') throw new Error('machine profile invalid');
  const sourceFiles = [];
  await collectSourceFiles(wpsComposerRoot, wpsComposerRoot, sourceFiles);
  const fonts = await collectSystemFonts(platform, platformServices);
  const applicationIdentity = await probeWpsApplicationTarget({
    platform, wpsApplication, wpsComposerRoot, profile: profile.wps,
    execFile: platformServices.execFile
  });
  return buildPathFreeProvenance({
    platform,
    machineProfileId: profile.profile_id,
    representative: profile.representative,
    wpsVersion: profile.wps.exact_version,
    bridgeIdentity: profile.wps.bridge_identity,
    wpsApplicationIdentity: applicationIdentity,
    pythonBytes: await readFile(wpsPython),
    wpsComposerFiles: sourceFiles,
    fontRecords: fonts,
    renderOptions: profile.render_options
  });
}

export async function privateWpsLaunchEnvironment({ wpsApplication, machineProfile, provenance }) {
  if (!path.isAbsolute(wpsApplication ?? '') || !path.isAbsolute(machineProfile ?? '')) throw new Error('private WPS launch inputs must be absolute');
  const profile = JSON.parse(await readFile(machineProfile, 'utf8'));
  if (profile?.schema_id !== 'superwagie.review-machine-profile.v1' || profile.schema_version !== 1
    || profile.wps?.exact_version !== provenance?.wps?.exact_version
    || profile.wps?.bridge_identity !== provenance?.wps?.bridge_identity
    || !profile.wps?.bridge_relative_path
    || (provenance?.wps?.application_identity?.target_kind === 'macos-app-bundle' && !profile.wps?.executable_relative_path)) {
    throw new Error('private WPS launch profile mismatch');
  }
  for (const value of [profile.wps.bridge_relative_path, profile.wps.executable_relative_path].filter(Boolean)) {
    if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..') || /[\r\n\0]/.test(value)) throw new Error('private WPS launch relative path invalid');
  }
  return {
    SUPERWAGIE_WPS_APPLICATION: wpsApplication,
    SUPERWAGIE_WPS_APPLICATION_IDENTITY: JSON.stringify(provenance.wps.application_identity),
    SUPERWAGIE_WPS_BRIDGE_RELATIVE_PATH: profile.wps.bridge_relative_path,
    ...(profile.wps.executable_relative_path ? { SUPERWAGIE_WPS_EXECUTABLE_RELATIVE_PATH: profile.wps.executable_relative_path } : {})
  };
}

async function collectSourceFiles(root, directory, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('WPSComposer source symlink rejected');
    if (['.git', '.venv', 'venv', 'node_modules', '__pycache__', 'dist', 'build'].includes(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectSourceFiles(root, candidate, output);
    else if (entry.isFile() && /\.(?:py|js|mjs|cjs|ts|json|toml|lock)$/i.test(entry.name)) {
      output.push({ identity: path.relative(root, candidate).split(path.sep).join('/'), bytes: await readFile(candidate) });
    }
  }
  if (directory === root && output.length === 0) throw new Error('WPSComposer source inventory empty');
}

export async function collectSystemFonts(platform, { execFile: execute = exec } = {}) {
  if (platform.startsWith('macos-')) {
    const { stdout } = await execute('/usr/sbin/system_profiler', ['SPFontsDataType', '-json'], { maxBuffer: 32 * 1024 * 1024 });
    const values = [];
    extractFontRecords(JSON.parse(stdout), values);
    if (values.length === 0) throw new Error('system font inventory empty');
    return canonicalFonts(values);
  }
  if (platform === 'windows-11-x64') {
    const script = [
      '$ErrorActionPreference="Stop"',
      'Get-ChildItem -LiteralPath "$env:WINDIR\\Fonts" -File | ForEach-Object {',
      '$h=(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant();',
      '$v=$_.VersionInfo.FileVersion; if ([string]::IsNullOrWhiteSpace($v)) {$v="unknown"}; $v="$v;sha256:$h";',
      '[pscustomobject]@{family=$_.BaseName;style="system-file";version=$v}',
      '} | Sort-Object family,style,version | ConvertTo-Json -Compress'
    ].join(' ');
    const { stdout } = await execute(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 32 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    const records = (Array.isArray(parsed) ? parsed : [parsed]).map(({ family, style, version }) => ({ family, style, version }));
    if (records.length === 0) throw new Error('Windows system font inventory empty');
    return canonicalFonts(records);
  }
  throw new Error('system font inventory unsupported on this platform');
}

export async function probeWpsApplicationTarget({ platform, wpsApplication, wpsComposerRoot, profile, execFile: execute = exec }) {
  if (!path.isAbsolute(wpsApplication ?? '') || !path.isAbsolute(wpsComposerRoot ?? '')) throw new Error('WPS application probe paths must be absolute');
  if (!profile || typeof profile.exact_version !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(profile.bridge_identity ?? '')
    || typeof profile.bridge_relative_path !== 'string') throw new Error('WPS application probe profile invalid');
  const bridge = await containedRegularFile(wpsComposerRoot, profile.bridge_relative_path, 'WPS bridge');
  const bridgeSha256 = sha(await readFile(bridge));
  if (profile.bridge_identity !== `sha256:${bridgeSha256}`) throw new Error('declared WPS bridge identity mismatch');
  let targetKind;
  let executable;
  let exactVersion;
  let manifestRecords;
  if (platform.startsWith('macos-')) {
    if (path.extname(wpsApplication) !== '.app' || typeof profile.executable_relative_path !== 'string') throw new Error('macOS WPS application bundle profile invalid');
    const metadata = await lstat(wpsApplication);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('macOS WPS application must be a non-symlink bundle');
    executable = await containedRegularFile(wpsApplication, profile.executable_relative_path, 'WPS executable');
    const info = await containedRegularFile(wpsApplication, 'Contents/Info.plist', 'WPS Info.plist');
    exactVersion = await macPlistString(info, 'CFBundleShortVersionString', execute);
    manifestRecords = await macBundleManifest(wpsApplication);
    targetKind = 'macos-app-bundle';
  } else if (platform === 'windows-11-x64') {
    const metadata = await lstat(wpsApplication);
    if (metadata.isSymbolicLink() || !metadata.isFile() || path.extname(wpsApplication).toLowerCase() !== '.exe') throw new Error('Windows WPS application must be an explicit executable');
    executable = await realpath(wpsApplication);
    const script = '(Get-Item -LiteralPath $args[0]).VersionInfo.ProductVersion';
    const { stdout } = await execute(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', script, wpsApplication]);
    exactVersion = stdout.trim();
    manifestRecords = [{ identity: 'application-executable', sha256: sha(await readFile(executable)) }];
    targetKind = 'windows-executable';
  } else {
    throw new Error('WPS application probe unsupported on this platform');
  }
  if (!exactVersion || exactVersion !== profile.exact_version) throw new Error('declared WPS exact version mismatch');
  const executableSha256 = sha(await readFile(executable));
  return {
    target_kind: targetKind,
    executable_sha256: executableSha256,
    bundle_manifest_sha256: sha(JSON.stringify(manifestRecords)),
    bridge_sha256: bridgeSha256
  };
}

async function macBundleManifest(bundleRoot) {
  const canonicalRoot = await realpath(bundleRoot);
  const records = [];
  const state = { active: new Set(), cache: new Map() };
  for (const relative of ['Contents/Info.plist', 'Contents/MacOS', 'Contents/Frameworks', 'Contents/PlugIns', 'Contents/Resources']) {
    const candidate = path.join(canonicalRoot, relative);
    try { await collectBundleEntry(canonicalRoot, candidate, records, state); } catch (error) {
      if (relative === 'Contents/Info.plist' || relative === 'Contents/MacOS' || error?.code !== 'ENOENT') throw error;
    }
  }
  return records.sort((left, right) => compareUtf8(left.identity, right.identity));
}

async function collectBundleEntry(root, candidate, output, state) {
  const name = path.basename(candidate);
  if (name === '.DS_Store' || name === 'Caches' || name === 'Logs' || name.endsWith('.log')) return;
  const metadata = await lstat(candidate);
  const identity = path.relative(root, candidate).split(path.sep).join('/');
  const mode = metadata.mode & 0o7777;
  if (metadata.isSymbolicLink()) {
    const target = await readlink(candidate);
    const canonical = await realpath(candidate);
    if (canonical !== root && !canonical.startsWith(`${root}${path.sep}`)) throw new Error('WPS bundle symlink escaped application root');
    const bytes = Buffer.from(target);
    const targetIdentity = await canonicalBundleTargetIdentity(root, canonical, state);
    output.push({
      identity, type: 'symlink', mode, size: bytes.length, sha256: sha(bytes),
      target_type: targetIdentity.type, target_mode: targetIdentity.mode,
      target_size: targetIdentity.size, target_sha256: targetIdentity.sha256
    });
    return;
  }
  if (metadata.isDirectory()) {
    output.push({ identity, type: 'directory', mode, size: 0, sha256: sha(Buffer.alloc(0)) });
    for (const entry of (await readdir(candidate, { withFileTypes: true })).sort((left, right) => compareUtf8(left.name, right.name))) {
      await collectBundleEntry(root, path.join(candidate, entry.name), output, state);
    }
    return;
  }
  if (!metadata.isFile()) throw new Error('WPS bundle contains unsupported special file');
  const bytes = await readFile(candidate);
  output.push({ identity, type: 'file', mode, size: metadata.size, sha256: sha(bytes) });
}

async function canonicalBundleTargetIdentity(root, canonical, state) {
  if (state.cache.has(canonical)) return state.cache.get(canonical);
  if (state.active.has(canonical)) throw new Error('WPS bundle symlink cycle detected');
  const metadata = await lstat(canonical);
  const mode = metadata.mode & 0o7777;
  if (metadata.isFile()) {
    const bytes = await readFile(canonical);
    const identity = { type: 'file', mode, size: metadata.size, sha256: sha(bytes) };
    state.cache.set(canonical, identity);
    return identity;
  }
  if (!metadata.isDirectory()) throw new Error('WPS bundle symlink target contains unsupported special file');
  state.active.add(canonical);
  try {
    const children = [];
    for (const entry of (await readdir(canonical, { withFileTypes: true })).sort((left, right) => compareUtf8(left.name, right.name))) {
      if (entry.name === '.DS_Store' || entry.name === 'Caches' || entry.name === 'Logs' || entry.name.endsWith('.log')) continue;
      const candidate = path.join(canonical, entry.name);
      const childMetadata = await lstat(candidate);
      const childMode = childMetadata.mode & 0o7777;
      if (childMetadata.isSymbolicLink()) {
        const linkText = await readlink(candidate);
        const target = await realpath(candidate);
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('WPS bundle symlink escaped application root');
        const bytes = Buffer.from(linkText);
        const targetIdentity = await canonicalBundleTargetIdentity(root, target, state);
        children.push({
          name: entry.name, type: 'symlink', mode: childMode, size: bytes.length, sha256: sha(bytes),
          target_type: targetIdentity.type, target_mode: targetIdentity.mode,
          target_size: targetIdentity.size, target_sha256: targetIdentity.sha256
        });
      } else {
        const childIdentity = await canonicalBundleTargetIdentity(root, await realpath(candidate), state);
        children.push({ name: entry.name, ...childIdentity });
      }
    }
    const identity = { type: 'directory', mode, size: 0, sha256: sha(JSON.stringify(children)) };
    state.cache.set(canonical, identity);
    return identity;
  } finally {
    state.active.delete(canonical);
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function windowsPowerShell() {
  const windowsRoot = process.env.WINDIR || 'C:\\Windows';
  return path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function containedRegularFile(root, relative, label) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`${label} relative path invalid`);
  const canonicalRoot = await realpath(root);
  const requested = path.resolve(canonicalRoot, relative);
  const metadata = await lstat(requested);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  const canonical = await realpath(requested);
  if (!canonical.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error(`${label} escaped its explicit root`);
  return canonical;
}

async function macPlistString(plist, key, execute) {
  try {
    const { stdout } = await execute(
      '/usr/bin/plutil', ['-extract', key, 'raw', '--', plist],
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL', shell: false }
    );
    const value = typeof stdout === 'string' ? stdout.trim() : '';
    if (!value || value.length > 256 || /[\r\n\0]/.test(value)) throw new Error('plist value invalid');
    return value;
  } catch (cause) {
    throw new Error(`WPS bundle version key unavailable: ${key}`, { cause });
  }
}

function canonicalFonts(records) {
  const normalized = records.map(({ family, style, version }) => ({ family, style, version }));
  if (normalized.some((font) => !font.family || !font.style || !font.version || Object.values(font).some(pathBearing))) throw new Error('font record invalid');
  return normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function extractFontRecords(value, output) {
  if (Array.isArray(value)) { for (const entry of value) extractFontRecords(entry, output); return; }
  if (!value || typeof value !== 'object') return;
  const family = value.family ?? value.family_name ?? value._name;
  const version = value.version ?? value.version_string;
  const style = value.style ?? value.typeface ?? 'Regular';
  if (typeof family === 'string' && typeof version === 'string' && typeof style === 'string'
    && ![family, version, style].some(pathBearing)) output.push({ family, version, style });
  for (const nested of Object.values(value)) extractFontRecords(nested, output);
}

function pathBearing(value) {
  return typeof value === 'string' && (/^(?:\/|[A-Za-z]:[\\/])/.test(value) || value.includes('..'));
}

function assertPathFreeValue(value, label) {
  if (typeof value === 'string') {
    if (pathBearing(value)) throw new Error(`${label} contains a path`);
    return;
  }
  if (Array.isArray(value)) { for (const entry of value) assertPathFreeValue(entry, label); return; }
  if (value && typeof value === 'object') for (const entry of Object.values(value)) assertPathFreeValue(entry, label);
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
