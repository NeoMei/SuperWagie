import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * macOS self-install without an Apple Developer identity.
 *
 * Squirrel.Mac refuses to replace an ad-hoc signed bundle, so SuperWagie
 * installs its own update: download the release ZIP, verify it, unpack it,
 * then swap the bundle after the app exits. Everything here is plain file work
 * plus one detached shell script; the caller owns IPC, progress and quitting.
 */

export const hashFile = async (file) => {
  const sha256 = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    size += chunk.length;
  }
  return { sha256: sha256.digest('hex'), size };
};

export const verifyDownload = async ({ file, sha256, size }) => {
  const actual = await hashFile(file);
  if (Number.isFinite(size) && size > 0 && actual.size !== size) {
    throw new Error(`E_UPDATE:size:${actual.size}/${size}`);
  }
  if (sha256 && actual.sha256 !== String(sha256).toLowerCase()) {
    throw new Error('E_UPDATE:checksum:');
  }
  return actual;
};

/** ditto keeps the bundle's resource forks and permissions intact. */
export const unpackZip = ({ zipPath, destDir, ditto = '/usr/bin/ditto' }) => new Promise((resolve, reject) => {
  const child = spawn(ditto, ['-x', '-k', zipPath, destDir], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(`E_UPDATE:unpack:ditto ${code}${stderr.trim() ? ` ${stderr.trim()}` : ''}`));
  });
});

/** The release ZIP holds exactly one app bundle at its root. */
export const findAppBundle = async (dir) => {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const bundles = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (bundles.length !== 1) {
    throw new Error(`E_UPDATE:bundle:${bundles.length}`);
  }
  return path.join(dir, bundles[0].name);
};

const readPlistJson = (plistPath) => new Promise((resolve, reject) => {
  const child = spawn('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code !== 0) {
      reject(new Error(`Could not read ${plistPath}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      return;
    }
    try {
      resolve(JSON.parse(stdout));
    } catch (error) {
      reject(new Error(`Could not parse ${plistPath}`, { cause: error }));
    }
  });
});

const BUNDLE_PLIST_SCHEMA = z.object({
  CFBundleIdentifier: z.string().optional(),
  CFBundleShortVersionString: z.string().optional(),
}).passthrough();

export const readBundleInfo = async ({ appPath, readPlist = readPlistJson }) => {
  const parsed = BUNDLE_PLIST_SCHEMA.safeParse(await readPlist(path.join(appPath, 'Contents', 'Info.plist')));
  if (!parsed.success) throw new Error('E_UPDATE:bundle:plist');
  return {
    bundleId: parsed.data.CFBundleIdentifier ?? '',
    version: parsed.data.CFBundleShortVersionString ?? '',
  };
};

/**
 * The staged bundle must be the same app at the version the feed promised.
 * Anything else means a truncated download or a feed that lies.
 */
export const validateStagedApp = async ({ stagedAppPath, expectedVersion, expectedBundleId, readPlist }) => {
  const info = await readBundleInfo({ appPath: stagedAppPath, readPlist });
  if (expectedBundleId && info.bundleId !== expectedBundleId) {
    throw new Error(`E_UPDATE:bundle:id`);
  }
  if (expectedVersion && info.version !== expectedVersion) {
    throw new Error(`E_UPDATE:bundle:${info.version || '?'}/${expectedVersion}`);
  }
  return info;
};

/**
 * The app cannot replace itself while it runs, so a detached script waits for
 * this process to exit, keeps the old bundle as a backup, swaps in the new one
 * and reopens the app. A failed swap restores the backup, so a broken update
 * never leaves the machine without a working app.
 */
export const buildSwapScript = ({
  appPath,
  stagedAppPath,
  backupPath,
  pid,
  logPath,
  openCommand = '/usr/bin/open',
}) => `#!/bin/sh
set -u
app=${JSON.stringify(appPath)}
staged=${JSON.stringify(stagedAppPath)}
backup=${JSON.stringify(backupPath)}
log=${JSON.stringify(logPath)}
open=${JSON.stringify(openCommand)}
pid=${Number(pid)}
{
  echo "[$(date)] waiting for pid $pid"
  while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
  rm -rf "$backup"
  if [ -e "$app" ] && ! mv "$app" "$backup"; then
    echo "could not move the current app aside"
    exit 1
  fi
  if /usr/bin/ditto "$staged" "$app"; then
    /usr/bin/xattr -dr com.apple.quarantine "$app" 2>/dev/null || true
    rm -rf "$backup"
    echo "installed"
    "$open" "$app"
  else
    echo "copy failed, restoring"
    rm -rf "$app"
    [ -e "$backup" ] && mv "$backup" "$app"
    "$open" "$app"
    exit 1
  fi
} >> "$log" 2>&1
`;

export const launchSwap = async ({ scriptPath, shebang = '/bin/sh' }) => {
  await fsp.chmod(scriptPath, 0o755);
  const child = spawn(shebang, [scriptPath], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
};
