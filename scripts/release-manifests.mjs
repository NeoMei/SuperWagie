#!/usr/bin/env node
// Writes the update feed for one SuperWagie release.
//
//   bun run release:manifests --version 2.7.3 --notes-file /tmp/notes.md
//
// Produces latest-x64.yml for current Windows x64 clients, a frozen legacy
// latest.yml, and latest.json for the app's own check next to the installers in
// packages/electron/dist. Upload them with gh release upload; the app reads
// them from https://github.com/NeoMei/SuperWagie-Open/releases/latest/download/.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLegacyWindowsManifest, withWindowsMigrationNotes } from '../packages/electron/scripts/windows-update-feeds.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIST = path.join(ROOT, 'packages/electron/dist');
const DEFAULT_REPO = 'NeoMei/SuperWagie-Open';

const hashFile = async (file) => {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    sha512.update(chunk);
    size += chunk.length;
  }
  return {
    sha256: sha256.digest('hex'),
    sha512: sha512.digest('base64'),
    size,
  };
};

const optionalFile = async (dir, name) => {
  const file = path.join(dir, name);
  try {
    const info = await fs.stat(file);
    return info.isFile() ? file : null;
  } catch {
    return null;
  }
};

const requireFile = async (dir, name) => {
  const file = path.join(dir, name);
  try {
    const info = await fs.stat(file);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`Missing release asset: ${file}`);
  }
  return file;
};

const downloadUrl = (repo, version, file) =>
  `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(path.basename(file))}`;

export const buildManifests = async ({
  version,
  distDir = DEFAULT_DIST,
  notes = '',
  repo = DEFAULT_REPO,
  publishedAt = new Date().toISOString(),
} = {}) => {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version || ''))) {
    throw new Error('version must be a semver string, e.g. 2.7.3');
  }

  const macDmg = await requireFile(distDir, `SuperWagie-${version}-mac-arm64.dmg`);
  const macZip = await requireFile(distDir, `SuperWagie-${version}-mac-arm64.zip`);
  const mac = await hashFile(macDmg);
  const macPackage = await hashFile(macZip);

  // A macOS-only release retains the retired Windows channel but cannot offer
  // a new x64 installer until that release's Windows build is available.
  const winExe = await optionalFile(distDir, `SuperWagie-${version}-win-x64.exe`);
  const win = winExe ? await hashFile(winExe) : null;
  const releaseNotes = win ? withWindowsMigrationNotes(notes) : notes;

  const latestJson = {
    version,
    notes: releaseNotes,
    publishedAt,
    mac: {
      // The DMG is the manual fallback; the ZIP is what the app installs
      // itself from, because it can replace its own bundle from an unpacked
      // copy without a mounted volume.
      url: downloadUrl(repo, version, macDmg),
      sha256: mac.sha256,
      size: mac.size,
      zip: {
        url: downloadUrl(repo, version, macZip),
        sha256: macPackage.sha256,
        size: macPackage.size,
      },
    },
    ...(winExe && win
      ? {
          win: {
            url: downloadUrl(repo, version, winExe),
            sha256: win.sha256,
            size: win.size,
          },
        }
      : {}),
  };

  const manifests = {
    'latest.json': `${JSON.stringify(latestJson, null, 2)}\n`,
    'latest.yml': await readLegacyWindowsManifest(),
  };
  if (winExe && win) {
    manifests['latest-x64.yml'] = [
      `version: ${version}`,
      'files:',
      `  - url: ${path.basename(winExe)}`,
      `    sha512: ${win.sha512}`,
      `    size: ${win.size}`,
      `path: ${path.basename(winExe)}`,
      `sha512: ${win.sha512}`,
      `releaseDate: '${publishedAt}'`,
      `releaseNotes: ${JSON.stringify(releaseNotes)}`,
      '',
    ].join('\n');
  }
  return manifests;
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const args = process.argv.slice(2);
  const readArg = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const version = readArg('--version', '');
  const distDir = path.resolve(readArg('--dist', DEFAULT_DIST));
  const repo = readArg('--repo', DEFAULT_REPO);
  const notesFile = readArg('--notes-file', '');
  const outDir = path.resolve(readArg('--out', distDir));

  try {
    if (!version) throw new Error('--version is required');
    if (!notesFile) throw new Error('--notes-file is required and must contain Chinese and English release notes');
    const notes = await fs.readFile(path.resolve(notesFile), 'utf8');
    const localeBlocks = [...notes.matchAll(/<!-- release-notes:(zh-CN|en) -->\s*([\s\S]*?)\s*<!-- \/release-notes -->/g)];
    for (const locale of ['zh-CN', 'en']) {
      if (!localeBlocks.some((block) => block[1] === locale && block[2]?.trim())) {
        throw new Error(`Release notes require a non-empty ${locale} block: <!-- release-notes:${locale} --> ... <!-- /release-notes -->`);
      }
    }
    const manifests = await buildManifests({ version, distDir, notes, repo });
    await fs.mkdir(outDir, { recursive: true });
    for (const [name, content] of Object.entries(manifests)) {
      await fs.writeFile(path.join(outDir, name), content);
      console.log(`wrote ${path.join(outDir, name)}`);
    }
    const names = Object.keys(manifests).map((name) => path.join(outDir, name)).join(' ');
    console.log(`\nUpload with:\n  gh release upload v${version} ${names} --clobber`);
    console.log('Then confirm the release is published and marked latest.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
