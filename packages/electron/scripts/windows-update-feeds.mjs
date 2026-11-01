import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATION_NOTICES = {
  'zh-CN': 'Windows 更新使用 x64 安装包。旧版 Windows 客户端也可通过通用更新清单直接升级到当前版本。Windows ARM64 原生安装包停止支持。',
  en: 'Windows updates use the x64 installer. Older Windows clients can also upgrade to the current version through the generic update manifest. Native Windows ARM64 installers are no longer supported.',
};

export const withWindowsMigrationNotes = (notes) => {
  let result = notes;
  for (const [locale, notice] of Object.entries(MIGRATION_NOTICES)) {
    const block = new RegExp(`(<!-- release-notes:${locale} -->)([\\s\\S]*?)(<!-- /release-notes -->)`);
    result = block.test(result)
      ? result.replace(block, (_, opening, body, closing) => `${opening}${body.trimEnd()}\n\n${notice}\n${closing}`)
      : `${result}\n\n<!-- release-notes:${locale} -->\n${notice}\n<!-- /release-notes -->`;
  }
  return result;
};

export const readLegacyWindowsManifest = () => readFile(new URL('./windows-legacy-latest.yml', import.meta.url), 'utf8');

export const stageWindowsUpdateFeeds = async (directory, version) => {
  // Packaging already installs the workspace dependencies. Keep YAML out of
  // the manifest-combining job, which runs without node_modules.
  const { parse, stringify } = await import('yaml');
  version ??= JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid Windows installer version: ${version}`);
  const installerName = `SuperWagie-${version}-win-x64.exe`;
  const installers = (await readdir(directory, { withFileTypes: true })).filter(entry => /\.exe$/i.test(entry.name));
  if (installers.length !== 1 || installers[0].name !== installerName || !installers[0].isFile()) {
    throw new Error(`Expected exactly one Windows x64 installer named ${installerName}; found: ${installers.map(entry => entry.name).join(', ') || '(none)'}`);
  }

  let source = {};
  try {
    source = parse(await readFile(path.join(directory, 'latest.yml'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (source.version && source.version !== version) throw new Error(`Windows manifest version mismatch: expected ${version}, got ${source.version}`);
  const { releaseNotes = '', releaseDate = new Date().toISOString() } = source;
  if (typeof releaseNotes !== 'string') throw new Error('Windows release notes must be a string');
  const hash = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(path.join(directory, installerName))) {
    hash.update(chunk);
    size += chunk.length;
  }
  if (!size) throw new Error('The Windows installer is empty');
  const sha512 = hash.digest('base64');
  const current = { version, files: [{ url: installerName, sha512, size }], path: installerName, sha512, releaseDate };
  const notes = withWindowsMigrationNotes(releaseNotes);
  const manifest = `${stringify({ ...current, releaseNotes: notes })}`;
  await writeFile(path.join(directory, 'latest-x64.yml'), manifest);
  await writeFile(path.join(directory, 'latest.yml'), manifest);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node windows-update-feeds.mjs <dist-directory> [version]');
  await stageWindowsUpdateFeeds(path.resolve(process.argv[2]), process.argv[3]);
}
