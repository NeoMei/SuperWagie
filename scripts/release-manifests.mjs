#!/usr/bin/env node
// Writes the update feed for one SuperWagie release.
//
//   bun run release:manifests --version 2.7.3 --notes-file /tmp/notes.md
//
// Produces latest.yml (electron-updater, Windows x64) and latest.json (the
// app's own check, both platforms) next to the installers in
// packages/electron/dist. Upload them with gh release upload; the app reads
// them from https://github.com/NeoMei/SuperWagie-Open/releases/latest/download/.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const winExe = await requireFile(distDir, `SuperWagie-${version}-win-x64.exe`);
  const mac = await hashFile(macDmg);
  const win = await hashFile(winExe);

  const latestJson = {
    version,
    notes,
    publishedAt,
    mac: {
      url: downloadUrl(repo, version, macDmg),
      sha256: mac.sha256,
      size: mac.size,
    },
    win: {
      url: downloadUrl(repo, version, winExe),
      sha256: win.sha256,
      size: win.size,
    },
  };

  const latestYml = [
    `version: ${version}`,
    'files:',
    `  - url: ${path.basename(winExe)}`,
    `    sha512: ${win.sha512}`,
    `    size: ${win.size}`,
    `path: ${path.basename(winExe)}`,
    `sha512: ${win.sha512}`,
    `releaseDate: '${publishedAt}'`,
    '',
  ].join('\n');

  return {
    'latest.yml': latestYml,
    'latest.json': `${JSON.stringify(latestJson, null, 2)}\n`,
  };
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
    const notes = notesFile ? await fs.readFile(path.resolve(notesFile), 'utf8') : '';
    const manifests = await buildManifests({ version, distDir, notes, repo });
    await fs.mkdir(outDir, { recursive: true });
    for (const [name, content] of Object.entries(manifests)) {
      await fs.writeFile(path.join(outDir, name), content);
      console.log(`wrote ${path.join(outDir, name)}`);
    }
    console.log(`\nUpload with:\n  gh release upload v${version} ${path.join(outDir, 'latest.yml')} ${path.join(outDir, 'latest.json')} --clobber`);
    console.log('Then confirm the release is published and marked latest.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
