import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';

import { isSupportedOpenCodeVersion, readOpenCodeCliVersion } from './compatibility.js';

const OPENCODE_NPM_REGISTRY = 'https://registry.npmjs.org';
const RELEASE_CHECK_MS = 6 * 60 * 60_000;
const INITIAL_DELAY_MS = 10_000;
const ACTIVATION_POLL_MS = 30_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const FAILED_MARKER = 'failed.json';
const versionSchema = z.string().regex(/^2\.\d+\.\d+$/);
const releaseSchema = z.object({ version: z.string() });
const packageDistSchema = z.object({
  dist: z.object({
    tarball: z.string().url(),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
  }),
});
const manifestSchema = z.object({
  version: versionSchema,
  platform: z.string(),
  arch: z.string(),
  binary: z.string(),
  integrity: z.string(),
  installedAt: z.string().datetime(),
});

export const managedOpenCodeRuntimeRoot = (dataDir) => path.join(dataDir, 'opencode-runtime');

const artifactFor = (platform, arch) => {
  if (platform === 'darwin' && arch === 'arm64') return { target: 'darwin-arm64', binary: 'opencode' };
  if (platform === 'darwin' && arch === 'x64') return { target: 'darwin-x64-baseline', binary: 'opencode' };
  if (platform === 'win32' && arch === 'x64') return { target: 'windows-x64-baseline', binary: 'opencode.exe' };
  if (platform === 'win32' && arch === 'arm64') return { target: 'windows-arm64', binary: 'opencode.exe' };
  if (platform === 'linux' && arch === 'arm64') return { target: 'linux-arm64', binary: 'opencode' };
  if (platform === 'linux' && arch === 'x64') return { target: 'linux-x64-baseline', binary: 'opencode' };
  throw new Error(`No managed OpenCode runtime for ${platform}/${arch}`);
};

const packageName = (artifact) => `@opencode/cli-${artifact.target}`;
const packageMetadataUrl = (artifact, version) =>
  `${OPENCODE_NPM_REGISTRY}/${packageName(artifact).replace('/', '%2F')}/${version}`;

const versionParts = (version) => version.replace(/^v/, '').split(/[-+]/, 1)[0].split('.').map(Number);

export const compareOpenCodeVersions = (left, right) => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

const findBinary = (root, binaryName) => {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === binaryName.toLowerCase()) return fullPath;
    if (entry.isDirectory()) {
      const found = findBinary(fullPath, binaryName);
      if (found) return found;
    }
  }
  return null;
};

const extractArchive = (tarCommand, archive, destination) => new Promise((resolve, reject) => {
  const child = spawn(tarCommand, ['-xzf', archive, '-C', destination], {
    stdio: 'ignore', windowsHide: true, timeout: INSTALL_TIMEOUT_MS,
  });
  child.once('error', () => reject(new Error('Could not unpack the OpenCode runtime.')));
  child.once('close', (code) => {
    if (code === 0) resolve();
    else reject(new Error('Could not unpack the OpenCode runtime.'));
  });
});

export const listManagedOpenCodeRuntimes = ({ root, platform, arch, fsImpl = fs }) => {
  let entries;
  try {
    entries = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const runtimes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = path.join(root, entry.name);
    try {
      if (fsImpl.existsSync(path.join(directory, FAILED_MARKER))) continue;
      const manifest = manifestSchema.parse(JSON.parse(fsImpl.readFileSync(path.join(directory, 'manifest.json'), 'utf8')));
      if (manifest.platform !== platform || manifest.arch !== arch) continue;
      const binary = path.join(directory, manifest.binary);
      const stat = fsImpl.statSync(binary);
      if (!stat.isFile()) continue;
      runtimes.push({ ...manifest, binary, directory });
    } catch {
      // A partial install or a manifest for another architecture is invisible.
    }
  }
  return runtimes.sort((left, right) => compareOpenCodeVersions(right.version, left.version));
};

export const markManagedOpenCodeRuntimeFailed = async (runtime, error) => {
  const failure = {
    error: String(error?.code ?? error?.message ?? 'opencode_runtime_activation_failed').slice(0, 240),
    failedAt: new Date().toISOString(),
  };
  const target = path.join(runtime.directory, FAILED_MARKER);
  const temporary = `${target}.${process.pid}.tmp`;
  await fsPromises.writeFile(temporary, `${JSON.stringify(failure, null, 2)}\n`, { mode: 0o600 });
  await fsPromises.rename(temporary, target);
};

const fetchLatestOfficialOpenCodeVersion = async ({ fetchImpl = fetch } = {}) => {
  const response = await fetchImpl(`${OPENCODE_NPM_REGISTRY}/@opencode%2Fcli/latest`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw Object.assign(new Error('Could not read the official OpenCode release.'), { code: 'opencode_runtime_latest_failed' });
  const { version } = releaseSchema.parse(await response.json());
  if (!isSupportedOpenCodeVersion(version)) {
    throw Object.assign(new Error(`OpenCode ${version} is not compatible with this SuperWagie release.`), {
      code: 'opencode_runtime_incompatible_release',
      version,
    });
  }
  return version;
};

export const installManagedOpenCodeRuntime = async ({
  root,
  version,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
  tarCommand = platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar',
} = {}) => {
  const parsedVersion = versionSchema.parse(version);
  const artifact = artifactFor(platform, arch);
  await fsPromises.mkdir(root, { recursive: true });
  const finalDirectory = path.join(root, `${parsedVersion}-${artifact.target}`);
  if (fs.existsSync(path.join(finalDirectory, FAILED_MARKER))) {
    throw Object.assign(new Error(`OpenCode ${parsedVersion} was quarantined after a failed activation.`), {
      code: 'opencode_runtime_quarantined',
    });
  }
  const existing = listManagedOpenCodeRuntimes({ root, platform, arch })
    .find((runtime) => runtime.directory === finalDirectory);
  if (existing) return existing;

  const lock = path.join(root, '.install.lock');
  await fsPromises.mkdir(lock).catch(() => {
    throw Object.assign(new Error('Another OpenCode runtime update is already running.'), { code: 'opencode_runtime_update_busy' });
  });
  let temporary = null;
  try {
    const metadataResponse = await fetchImpl(packageMetadataUrl(artifact, parsedVersion), {
      signal: AbortSignal.timeout(15_000),
    });
    if (!metadataResponse.ok) throw new Error('Could not resolve the official OpenCode runtime package.');
    const { dist } = packageDistSchema.parse(await metadataResponse.json());
    if (new URL(dist.tarball).origin !== OPENCODE_NPM_REGISTRY) {
      throw new Error('The OpenCode runtime is not served by the official npm registry.');
    }
    const archiveResponse = await fetchImpl(dist.tarball, { signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) });
    if (!archiveResponse.ok) throw new Error('Could not download the official OpenCode runtime.');
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    if (`sha512-${crypto.createHash('sha512').update(archive).digest('base64')}` !== dist.integrity) {
      throw new Error('The OpenCode runtime failed its npm integrity check.');
    }

    temporary = await fsPromises.mkdtemp(path.join(root, '.install-'));
    const archivePath = path.join(temporary, 'runtime.tgz');
    const extractDirectory = path.join(temporary, 'extract');
    await fsPromises.writeFile(archivePath, archive);
    await fsPromises.mkdir(extractDirectory);
    await extractArchive(tarCommand, archivePath, extractDirectory);
    const extracted = findBinary(extractDirectory, artifact.binary);
    if (!extracted) throw new Error(`The OpenCode package does not contain ${artifact.binary}.`);
    const binary = path.join(temporary, artifact.binary);
    await fsPromises.copyFile(extracted, binary);
    if (platform !== 'win32') await fsPromises.chmod(binary, 0o755);
    const installedVersion = await readOpenCodeCliVersion({ binary, args: [] });
    if (installedVersion !== parsedVersion) throw new Error('The installed OpenCode runtime version does not match the official release.');
    const manifest = {
      version: parsedVersion,
      platform,
      arch,
      binary: artifact.binary,
      integrity: dist.integrity,
      installedAt: new Date().toISOString(),
    };
    await fsPromises.writeFile(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fsPromises.rm(extractDirectory, { recursive: true, force: true });
    await fsPromises.rm(archivePath, { force: true });
    try {
      await fsPromises.rename(temporary, finalDirectory);
      temporary = null;
    } catch (error) {
      const raced = listManagedOpenCodeRuntimes({ root, platform, arch })
        .find((runtime) => runtime.directory === finalDirectory);
      if (!raced) throw error;
    }
    return listManagedOpenCodeRuntimes({ root, platform, arch })
      .find((runtime) => runtime.directory === finalDirectory) ?? null;
  } finally {
    if (temporary) await fsPromises.rm(temporary, { recursive: true, force: true }).catch(() => {});
    await fsPromises.rm(lock, { recursive: true, force: true }).catch(() => {});
  }
};

export const createManagedOpenCodeRuntimeUpdater = ({
  dataDir,
  packagedBinary = null,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
  tarCommand,
  readVersion = (binary) => readOpenCodeCliVersion({ binary, args: [] }),
  onInstalled = () => {},
  shouldCheck = () => true,
  canActivate = () => false,
  activate = null,
  log = console,
  initialDelayMs = INITIAL_DELAY_MS,
  intervalMs = RELEASE_CHECK_MS,
  activationPollMs = ACTIVATION_POLL_MS,
} = {}) => {
  if (!dataDir) throw new Error('Managed OpenCode runtime requires a data directory');
  const root = managedOpenCodeRuntimeRoot(dataDir);
  let initialTimer = null;
  let intervalTimer = null;
  let activationTimer = null;
  let running = null;
  let activationRunning = null;
  let pendingActivation = null;
  let stopped = false;
  let packagedVersion = null;
  let state = {
    status: 'idle',
    latestVersion: null,
    installedVersion: null,
    restartRequired: false,
    error: null,
    checkedAt: null,
  };

  const readManagedVersion = () => listManagedOpenCodeRuntimes({ root, platform, arch })[0]?.version ?? null;

  const stopActivationTimer = () => {
    if (activationTimer) clearInterval(activationTimer);
    activationTimer = null;
  };

  const scheduleActivation = () => {
    if (!activate || !pendingActivation || activationTimer) return;
    activationTimer = setInterval(() => { void attemptActivation(); }, activationPollMs);
    activationTimer.unref?.();
  };

  const attemptActivation = async () => {
    if (stopped || !activate || !pendingActivation) return false;
    if (activationRunning) return activationRunning;
    activationRunning = (async () => {
      let eligible = false;
      try {
        eligible = Boolean(await shouldCheck());
      } catch (error) {
        log.warn?.('[OpenCode] could not confirm managed runtime ownership', error?.message ?? error);
      }
      if (!eligible) {
        pendingActivation = null;
        stopActivationTimer();
        state = {
          ...state,
          status: 'idle',
          restartRequired: false,
          error: null,
          checkedAt: new Date().toISOString(),
        };
        return false;
      }

      const canApplyNow = await Promise.resolve().then(canActivate).catch((error) => {
        log.warn?.('[OpenCode] could not confirm the engine is idle', error?.message ?? error);
        return false;
      });
      if (!canApplyNow || !pendingActivation) return false;

      const installed = pendingActivation;
      state = { ...state, status: 'activating', error: null };
      try {
        await activate(installed);
        pendingActivation = null;
        stopActivationTimer();
        state = {
          ...state,
          status: 'current',
          installedVersion: readManagedVersion(),
          restartRequired: false,
          error: null,
          checkedAt: new Date().toISOString(),
        };
        log.info?.(`[OpenCode] activated official runtime ${installed.version}`);
        return true;
      } catch (error) {
        pendingActivation = null;
        stopActivationTimer();
        state = {
          ...state,
          status: 'failed',
          error: error?.code ?? error?.message ?? 'opencode_runtime_activation_failed',
          restartRequired: true,
          checkedAt: new Date().toISOString(),
        };
        log.warn?.('[OpenCode] automatic runtime activation failed', state.error);
        return false;
      }
    })().finally(() => {
      activationRunning = null;
    });
    return activationRunning;
  };

  const ensurePackagedVersion = async () => {
    if (packagedVersion !== null || !packagedBinary) return packagedVersion;
    packagedVersion = await readVersion(packagedBinary).catch(() => null);
    return packagedVersion;
  };

  const checkNow = async () => {
    if (running) return running;
    running = (async () => {
      try {
        if (!(await shouldCheck())) {
          pendingActivation = null;
          stopActivationTimer();
          state = {
            ...state,
            status: 'idle',
            restartRequired: false,
            error: null,
            checkedAt: new Date().toISOString(),
          };
          return state;
        }
      } catch (error) {
        state = {
          ...state,
          status: 'failed',
          error: error?.code ?? error?.message ?? 'opencode_runtime_eligibility_failed',
          checkedAt: new Date().toISOString(),
        };
        log.warn?.('[OpenCode] automatic runtime ownership check failed', state.error);
        return state;
      }
      state = { ...state, status: 'checking', error: null };
      try {
        const latestVersion = await fetchLatestOfficialOpenCodeVersion({ fetchImpl });
        const managedVersion = readManagedVersion();
        const bundledVersion = await ensurePackagedVersion();
        const effectiveVersion = !bundledVersion || (managedVersion && compareOpenCodeVersions(managedVersion, bundledVersion) > 0)
          ? managedVersion : bundledVersion;
        state = { ...state, latestVersion };
        if (effectiveVersion && compareOpenCodeVersions(latestVersion, effectiveVersion) <= 0) {
          state = pendingActivation
            ? { ...state, status: 'installed', installedVersion: managedVersion, restartRequired: true, checkedAt: new Date().toISOString() }
            : state.status === 'failed' && state.restartRequired
              ? { ...state, installedVersion: managedVersion, checkedAt: new Date().toISOString() }
              : { ...state, status: 'current', installedVersion: managedVersion, restartRequired: false, checkedAt: new Date().toISOString() };
          if (pendingActivation) scheduleActivation();
          return state;
        }
        state = { ...state, status: 'downloading' };
        const installed = await installManagedOpenCodeRuntime({
          root, version: latestVersion, platform, arch, fetchImpl, tarCommand,
        });
        if (!installed) throw new Error('The official OpenCode runtime was not installed.');
        state = {
          ...state,
          status: 'installed',
          installedVersion: installed.version,
          restartRequired: true,
          checkedAt: new Date().toISOString(),
        };
        onInstalled(installed);
        pendingActivation = !stopped && activate ? installed : null;
        log.info?.(activate
          ? `[OpenCode] downloaded official runtime ${installed.version}; activation waits for the engine to become idle`
          : `[OpenCode] downloaded official runtime ${installed.version}; it applies after the engine restarts`);
        if (pendingActivation) {
          await attemptActivation();
          scheduleActivation();
        }
        return state;
      } catch (error) {
        state = {
          ...state,
          status: 'failed',
          error: error?.code ?? error?.message ?? 'opencode_runtime_update_failed',
          checkedAt: new Date().toISOString(),
        };
        log.warn?.('[OpenCode] automatic runtime update failed', state.error);
        return state;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const start = () => {
    if (process.env.OPENCHAMBER_RUNTIME !== 'desktop' || initialTimer || intervalTimer) return;
    stopped = false;
    initialTimer = setTimeout(() => {
      initialTimer = null;
      void checkNow();
    }, initialDelayMs);
    initialTimer.unref?.();
    intervalTimer = setInterval(() => { void checkNow(); }, intervalMs);
    intervalTimer.unref?.();
  };

  const stop = () => {
    stopped = true;
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
    pendingActivation = null;
    stopActivationTimer();
  };

  return {
    start,
    stop,
    checkNow,
    status: () => ({
      ...state,
      packagedVersion,
      installedVersion: readManagedVersion(),
      platform,
      arch,
    }),
  };
};
