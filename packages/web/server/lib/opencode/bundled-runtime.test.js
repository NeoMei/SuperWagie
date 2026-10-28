import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createManagedOpenCodeRuntimeUpdater,
  installManagedOpenCodeRuntime,
  listManagedOpenCodeRuntimes,
  markManagedOpenCodeRuntimeFailed,
  managedOpenCodeRuntimeRoot,
} from './bundled-runtime.js';
import { readOpenCodeCliVersion } from './compatibility.js';

const directories = [];
const itPosix = process.platform === 'win32' ? it.skip : it;
const makeDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-oc-runtime-'));
  directories.push(directory);
  return directory;
};

const makePackage = async (version, target = 'darwin-arm64') => {
  const root = await makeDirectory();
  await fs.mkdir(path.join(root, 'package/bin'), { recursive: true });
  await fs.writeFile(path.join(root, 'package/bin/opencode'), `#!/bin/sh\necho 'opencode v${version}'\n`, { mode: 0o755 });
  execFileSync('tar', ['-czf', path.join(root, 'package.tgz'), '-C', root, 'package']);
  const bytes = await fs.readFile(path.join(root, 'package.tgz'));
  return {
    bytes,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    url: `https://registry.npmjs.org/@opencode/${target}/-/${target}-${version}.tgz`,
  };
};

const packageFetch = (packageFixture, version = '2.1.5') => async (url) => {
  if (String(url).endsWith('/@opencode%2Fcli/latest')) return Response.json({ version });
  if (String(url).endsWith('/@opencode%2Fcli-darwin-arm64/2.1.5')) {
    return Response.json({ dist: { tarball: packageFixture.url, integrity: packageFixture.integrity } });
  }
  if (String(url) === packageFixture.url) return new Response(packageFixture.bytes);
  return new Response(null, { status: 404 });
};

afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe('managed OpenCode runtime', () => {
  itPosix('installs the verified official package in the app data directory', async () => {
    const dataDir = await makeDirectory();
    const packageFixture = await makePackage('2.1.5');
    const installed = await installManagedOpenCodeRuntime({
      root: managedOpenCodeRuntimeRoot(dataDir),
      version: '2.1.5',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: packageFetch(packageFixture),
      tarCommand: 'tar',
    });

    expect(installed.version).toBe('2.1.5');
    expect(await readOpenCodeCliVersion({ binary: installed.binary, args: [] })).toBe('2.1.5');
    expect(listManagedOpenCodeRuntimes({
      root: managedOpenCodeRuntimeRoot(dataDir), platform: 'darwin', arch: 'arm64',
    })).toHaveLength(1);
  });

  itPosix('rejects a package that fails npm integrity before creating a runtime', async () => {
    const dataDir = await makeDirectory();
    const packageFixture = await makePackage('2.1.5');
    await expect(installManagedOpenCodeRuntime({
      root: managedOpenCodeRuntimeRoot(dataDir),
      version: '2.1.5',
      platform: 'darwin',
      arch: 'arm64',
      tarCommand: 'tar',
      fetchImpl: async (url) => {
        if (String(url).endsWith('/@opencode%2Fcli/latest')) return Response.json({ version: '2.1.5' });
        if (String(url).endsWith('/@opencode%2Fcli-darwin-arm64/2.1.5')) {
          return Response.json({ dist: { tarball: packageFixture.url, integrity: packageFixture.integrity } });
        }
        return new Response(Buffer.from('tampered'));
      },
    })).rejects.toThrow('integrity');
    expect(listManagedOpenCodeRuntimes({
      root: managedOpenCodeRuntimeRoot(dataDir), platform: 'darwin', arch: 'arm64',
    })).toEqual([]);
  });

  itPosix('quarantines a runtime that fails activation', async () => {
    const dataDir = await makeDirectory();
    const packageFixture = await makePackage('2.1.5');
    const installed = await installManagedOpenCodeRuntime({
      root: managedOpenCodeRuntimeRoot(dataDir),
      version: '2.1.5',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: packageFetch(packageFixture),
      tarCommand: 'tar',
    });

    await markManagedOpenCodeRuntimeFailed(installed, Object.assign(new Error('startup failed'), {
      code: 'test_activation_failed',
    }));
    expect(listManagedOpenCodeRuntimes({
      root: managedOpenCodeRuntimeRoot(dataDir), platform: 'darwin', arch: 'arm64',
    })).toEqual([]);
    await expect(installManagedOpenCodeRuntime({
      root: managedOpenCodeRuntimeRoot(dataDir),
      version: '2.1.5',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: packageFetch(packageFixture),
      tarCommand: 'tar',
    })).rejects.toMatchObject({ code: 'opencode_runtime_quarantined' });
  });

  itPosix('downloads a newer official runtime and retains the installed version for the next restart', async () => {
    const dataDir = await makeDirectory();
    const packageFixture = await makePackage('2.1.5');
    const installed = vi.fn();
    const updater = createManagedOpenCodeRuntimeUpdater({
      dataDir,
      packagedBinary: '/packaged/opencode',
      platform: 'darwin',
      arch: 'arm64',
      tarCommand: 'tar',
      fetchImpl: packageFetch(packageFixture),
      readVersion: async () => '2.1.4',
      onInstalled: installed,
      log: { info() {}, warn() {} },
    });

    const status = await updater.checkNow();
    expect(status).toMatchObject({
      status: 'installed',
      latestVersion: '2.1.5',
      installedVersion: '2.1.5',
      restartRequired: true,
    });
    expect(installed).toHaveBeenCalledTimes(1);
  });

  itPosix('activates a downloaded runtime when the managed engine is idle', async () => {
    const dataDir = await makeDirectory();
    const packageFixture = await makePackage('2.1.5');
    const activate = vi.fn(async () => {});
    const updater = createManagedOpenCodeRuntimeUpdater({
      dataDir,
      packagedBinary: '/packaged/opencode',
      platform: 'darwin',
      arch: 'arm64',
      tarCommand: 'tar',
      fetchImpl: packageFetch(packageFixture),
      readVersion: async () => '2.1.4',
      canActivate: async () => true,
      activate,
      log: { info() {}, warn() {} },
    });

    expect(await updater.checkNow()).toMatchObject({
      status: 'current',
      installedVersion: '2.1.5',
      restartRequired: false,
    });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ version: '2.1.5' }));
  });

  itPosix('waits for running work to finish before activating the downloaded runtime', async () => {
    const dataDir = await makeDirectory();
    const packageFixture = await makePackage('2.1.5');
    let idle = false;
    const activate = vi.fn(async () => {});
    const updater = createManagedOpenCodeRuntimeUpdater({
      dataDir,
      packagedBinary: '/packaged/opencode',
      platform: 'darwin',
      arch: 'arm64',
      tarCommand: 'tar',
      fetchImpl: packageFetch(packageFixture),
      readVersion: async () => '2.1.4',
      canActivate: async () => idle,
      activate,
      activationPollMs: 5,
      log: { info() {}, warn() {} },
    });

    expect(await updater.checkNow()).toMatchObject({ status: 'installed', restartRequired: true });
    expect(activate).not.toHaveBeenCalled();

    idle = true;
    await vi.waitFor(() => {
      expect(updater.status()).toMatchObject({ status: 'current', restartRequired: false });
    }, { timeout: 1000, interval: 10 });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ version: '2.1.5' }));
  });

  itPosix('keeps the verified runtime installed when automatic activation fails', async () => {
    const dataDir = await makeDirectory();
    const packageFixture = await makePackage('2.1.5');
    const activate = vi.fn(async () => {
      const error = new Error('restart failed');
      error.code = 'opencode_runtime_activation_mismatch';
      throw error;
    });
    const updater = createManagedOpenCodeRuntimeUpdater({
      dataDir,
      packagedBinary: '/packaged/opencode',
      platform: 'darwin',
      arch: 'arm64',
      tarCommand: 'tar',
      fetchImpl: packageFetch(packageFixture),
      readVersion: async () => '2.1.4',
      canActivate: async () => true,
      activate,
      log: { info() {}, warn() {} },
    });

    expect(await updater.checkNow()).toMatchObject({
      status: 'failed',
      error: 'opencode_runtime_activation_mismatch',
      installedVersion: '2.1.5',
      restartRequired: true,
    });
    expect(listManagedOpenCodeRuntimes({
      root: managedOpenCodeRuntimeRoot(dataDir), platform: 'darwin', arch: 'arm64',
    })).toHaveLength(1);
  });

  itPosix('does not activate a pending runtime after the updater stops for shutdown', async () => {
    const dataDir = await makeDirectory();
    const packageFixture = await makePackage('2.1.5');
    let idle = false;
    const activate = vi.fn(async () => {});
    const updater = createManagedOpenCodeRuntimeUpdater({
      dataDir,
      packagedBinary: '/packaged/opencode',
      platform: 'darwin',
      arch: 'arm64',
      tarCommand: 'tar',
      fetchImpl: packageFetch(packageFixture),
      readVersion: async () => '2.1.4',
      canActivate: async () => idle,
      activate,
      activationPollMs: 5,
      log: { info() {}, warn() {} },
    });

    expect(await updater.checkNow()).toMatchObject({ status: 'installed' });
    updater.stop();
    idle = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(activate).not.toHaveBeenCalled();
  });

  it('skips the official release entirely when the managed runtime is not owned', async () => {
    const dataDir = await makeDirectory();
    const fetchImpl = vi.fn();
    const updater = createManagedOpenCodeRuntimeUpdater({
      dataDir,
      shouldCheck: async () => false,
      fetchImpl,
      log: { info() {}, warn() {} },
    });

    expect(await updater.checkNow()).toMatchObject({ status: 'idle', restartRequired: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not replace the runtime with an incompatible official major release', async () => {
    const dataDir = await makeDirectory();
    const updater = createManagedOpenCodeRuntimeUpdater({
      dataDir,
      packagedBinary: '/packaged/opencode',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: async () => Response.json({ version: '3.0.0' }),
      readVersion: async () => '2.1.4',
      log: { info() {}, warn() {} },
    });

    expect(await updater.checkNow()).toMatchObject({
      status: 'failed',
      error: 'opencode_runtime_incompatible_release',
    });
    expect(listManagedOpenCodeRuntimes({
      root: managedOpenCodeRuntimeRoot(dataDir), platform: 'darwin', arch: 'arm64',
    })).toEqual([]);
  });
});
