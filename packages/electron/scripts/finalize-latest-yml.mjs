#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { readLegacyWindowsManifest, withWindowsMigrationNotes } from './windows-update-feeds.mjs';

const dir = process.env.LATEST_YML_DIR;
const repo = process.env.GH_REPO;
const version = process.env.OPENCHAMBER_VERSION;

if (!dir) throw new Error('LATEST_YML_DIR is required');
if (!repo) throw new Error('GH_REPO is required');
if (!version) throw new Error('OPENCHAMBER_VERSION is required');

const parse = (content, includeWindowsNotes = false) => {
  const lines = content.split('\n');
  let releaseDate = '';
  let parsedVersion = '';
  let releaseNotes = '';
  const files = [];
  let current;

  const flush = () => {
    if (current?.url && current?.sha512 && current?.size) files.push(current);
    current = undefined;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    const indented = line.startsWith('    ') || line.startsWith('  -');
    if (line.startsWith('version:')) parsedVersion = line.slice('version:'.length).trim();
    else if (line.startsWith('releaseDate:')) releaseDate = line.slice('releaseDate:'.length).trim().replace(/^'|'$/g, '');
    else if (includeWindowsNotes && line.startsWith('releaseNotes:')) releaseNotes = JSON.parse(line.slice('releaseNotes:'.length).trim());
    else if (trimmed.startsWith('- url:')) {
      flush();
      current = { url: trimmed.slice('- url:'.length).trim() };
    } else if (indented && current && trimmed.startsWith('sha512:')) current.sha512 = trimmed.slice('sha512:'.length).trim();
    else if (indented && current && trimmed.startsWith('size:')) current.size = Number(trimmed.slice('size:'.length).trim());
    else if (indented && current && trimmed.startsWith('blockMapSize:')) current.blockMapSize = Number(trimmed.slice('blockMapSize:'.length).trim());
    else if (!indented && current) flush();
  }
  flush();
  return { version: parsedVersion, releaseDate, files, releaseNotes };
};

// electron-updater compares a manifest's minimumSystemVersion with
// os.release(), the Darwin kernel version. Darwin 22 is macOS 13, the oldest
// macOS Electron 44 runs on, so an older Mac keeps the version it has instead
// of updating into an app macOS refuses to open.
const MAC_MINIMUM_DARWIN_VERSION = '22.0.0';

const serialize = (data) => {
  const lines = [`version: ${data.version}`];
  if (data.minimumSystemVersion) {
    lines.push(`minimumSystemVersion: ${data.minimumSystemVersion}`);
  }
  lines.push('files:');
  for (const file of data.files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
    if (file.blockMapSize) {
      lines.push(`    blockMapSize: ${file.blockMapSize}`);
    }
  }
  lines.push(`releaseDate: '${data.releaseDate}'`);
  if (data.releaseNotes) lines.push(`releaseNotes: ${JSON.stringify(data.releaseNotes)}`);
  return `${lines.join('\n')}\n`;
};

const read = async (subdir, filename) => {
  const filePath = path.join(dir, subdir, filename);
  try {
    return parse(await fs.readFile(filePath, 'utf8'), filename === 'latest-x64.yml');
  } catch {
    return null;
  }
};

const output = {};

// A macOS-only finish has no new Windows offer. It repeats the last known
// Windows x64 feed; a full release replaces both Windows manifests together.
const macOnly = process.env.MAC_ONLY === '1';

let winX64 = null;
if (!macOnly) {
  winX64 = await read('latest-yml-x86_64-pc-windows-msvc', 'latest-x64.yml');
  if (!winX64) {
    throw new Error('The x64 Windows update manifest is required');
  }
  output['latest-x64.yml'] = serialize({ ...winX64, releaseNotes: winX64.releaseNotes || withWindowsMigrationNotes('') });
}

// One manifest serves both Mac architectures. The updater falls back to x64
// files when it lists no arm64 ones, so a manifest missing an architecture
// moves Apple Silicon users onto the Intel build under Rosetta.
const macX64 = await read('latest-yml-x86_64-apple-darwin', 'latest-mac.yml');
const macArm64 = await read('latest-yml-aarch64-apple-darwin', 'latest-mac.yml');
if (!macX64 || !macArm64) {
  throw new Error('Both x64 and arm64 macOS update manifests are required');
}
output['latest-mac.yml'] = serialize({
  version: macArm64.version,
  minimumSystemVersion: MAC_MINIMUM_DARWIN_VERSION,
  files: [...macArm64.files, ...macX64.files],
  releaseDate: macArm64.releaseDate,
});
output['latest.yml'] = macOnly
  ? await readLegacyWindowsManifest()
  : serialize({ ...winX64, releaseNotes: winX64.releaseNotes || withWindowsMigrationNotes('') });

const tag = `v${version}`;
const tmp = process.env.RUNNER_TEMP || '/tmp';
for (const [filename, content] of Object.entries(output)) {
  const outputPath = path.join(tmp, filename);
  await fs.writeFile(outputPath, content);
  console.log(`prepared ${outputPath} for upload to ${repo} release ${tag}`);
}

console.log('finalized latest yml files');
