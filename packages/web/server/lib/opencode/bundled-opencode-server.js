import fs from 'node:fs';
import path from 'node:path';

const ENTRY = 'serve.mjs';
const isText = (value) => Object.prototype.toString.call(value) === '[object String]';

const entries = (directories) => directories
  .map((directory) => (isText(directory) ? directory.trim() : ''))
  .filter(Boolean)
  .map((directory) => path.join(directory, ENTRY));

const canonicalPath = (candidate) => {
  try {
    return fs.realpathSync.native(candidate.trim());
  } catch {
    return path.resolve(candidate.trim());
  }
};

const isFile = (candidate) => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

export const resolveBundledOpenCodeServer = (directories) => entries(directories).find(isFile) ?? null;

export const isBundledOpenCodeServer = (candidate, directories) => {
  if (!isText(candidate) || !candidate.trim()) return false;
  const canonical = canonicalPath(candidate);
  return entries(directories).some((entry) => canonicalPath(entry) === canonical);
};

export const bundledOpenCodeServerLaunch = (entry, resolveNodeBinary) => ({
  binary: process.versions.bun ? (resolveNodeBinary() || 'node') : process.execPath,
  args: [entry],
  env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  wrapperType: 'bundled-server',
});

export const isRetiredBundledCliSetting = (configured) => {
  const candidate = configured.trim().replace(/^(['"])(.*)\1$/, '$2').trim().replace(/[\\/]+$/, '');
  const retired = /openchamber[^\\/]*(?:\.app[\\/]Contents)?[\\/]resources[\\/]opencode-cli(?:[\\/]opencode(?:\.exe)?)?$/i;
  if (!retired.test(candidate) || fs.existsSync(candidate)) return false;
  console.warn(`settings.opencodeBinary points at the CLI older desktop builds shipped, which no longer exists; using the default OpenCode server instead: ${candidate}`);
  return true;
};
