import os from 'node:os';
import path from 'node:path';
import { lstatSync, mkdirSync } from 'node:fs';
import { assignInjectedEnv } from '../injected-env.js';
import { overlayEnvironment } from '../environment/variables.js';

export const desktopOpenCodePrivatePaths = (dataDir) => {
  const root = path.join(path.resolve(dataDir), 'opencode-private');
  return {
    root,
    config: path.join(root, 'config'),
    data: path.join(root, 'data'),
    cache: path.join(root, 'cache'),
    state: path.join(root, 'state'),
    home: path.join(root, 'home'),
    database: path.join(root, 'data', 'opencode', 'opencode.db'),
  };
};

const connectionKeys = new Set(['OPENCHAMBER_SKIP_OPENCODE_START', 'OPENCHAMBER_OPENCODE_HOSTNAME', 'OPENCHAMBER_API_PREFIX']);
const clearOpenCodeEnvironment = (env) => {
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith('OPENCODE_') || connectionKeys.has(name.toUpperCase())) delete env[name];
  }
};
const parentPaths = (dataDir) => {
  const paths = desktopOpenCodePrivatePaths(dataDir);
  return { OPENCHAMBER_RUNTIME: 'desktop', OPENCHAMBER_DATA_DIR: path.resolve(dataDir), OPENCODE_CONFIG_DIR: paths.config, OPENCODE_DB: paths.database };
};
const managedConfigPath = (dataDir) => path.join(path.resolve(dataDir), 'run', 'instances', String(process.pid), 'opencode.managed.json');
const privateDirectoryPaths = (paths) => [paths.root, paths.config, paths.data, path.dirname(paths.database), paths.cache, path.join(paths.cache, 'opencode'), paths.state, path.join(paths.state, 'opencode'), paths.home];
const isLinkedFile = (file) => {
  try { const stat = lstatSync(file); return stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const privatePathsAreOwned = (dataDir) => {
  const paths = desktopOpenCodePrivatePaths(dataDir);
  const run = path.join(path.resolve(dataDir), 'run');
  const managed = managedConfigPath(dataDir);
  return [...privateDirectoryPaths(paths), paths.database, `${paths.database}-wal`, `${paths.database}-shm`, path.join(paths.data, 'opencode', 'auth.json'), path.join(paths.config, 'opencode.json'), path.join(paths.config, 'opencode.jsonc'), path.join(paths.config, 'service.json'), run, path.join(run, 'instances'), path.dirname(managed), managed].every((file) => !isLinkedFile(file));
};
const ensurePrivateDirectories = (dataDir) => {
  if (!privatePathsAreOwned(dataDir)) throw Object.assign(new Error('Desktop OpenCode private storage cannot use symbolic links or hardlinked files'), { code: 'OPENCODE_PRIVATE_RUNTIME_REQUIRED' });
  for (const directory of privateDirectoryPaths(desktopOpenCodePrivatePaths(dataDir))) mkdirSync(directory, { recursive: true, mode: 0o700 });
};

/** Called before importing server modules whose config paths are module constants. */
export const prepareDesktopOpenCodeEnvironment = ({ env, dataDir = env.OPENCHAMBER_DATA_DIR?.trim() || path.join(os.homedir(), '.config', 'openchamber') }) => {
  ensurePrivateDirectories(dataDir);
  clearOpenCodeEnvironment(env);
  return assignInjectedEnv(env, parentPaths(dataDir));
};

const inheritedRuntimeKeys = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'COLORFGBG', 'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE',
  'SHELL', 'USER', 'USERNAME', 'LOGNAME', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'PROGRAMDATA',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
]);

/** Inherited model keys and credential-file settings never enter an OpenCode child. */
const privateChildEnvironment = ({ env, dataDir, managedEnv, userEnv = {} }) => {
  ensurePrivateDirectories(dataDir);
  const inherited = Object.fromEntries(Object.entries(env).filter(([name]) => inheritedRuntimeKeys.has(name.toUpperCase()) || name.toUpperCase().startsWith('LC_')));
  const child = overlayEnvironment(inherited, userEnv);
  clearOpenCodeEnvironment(child);
  for (const name of Object.keys(child)) {
    if (name.toUpperCase().startsWith('XDG_') || ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'].includes(name.toUpperCase())) delete child[name];
  }
  const paths = desktopOpenCodePrivatePaths(dataDir);
  return assignInjectedEnv(child, {
    ...managedEnv,
    ...parentPaths(dataDir),
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.config,
    LOCALAPPDATA: paths.data,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_CACHE_HOME: paths.cache,
    XDG_STATE_HOME: paths.state,
  });
};

export const desktopOpenCodeChildEnvironment = (options) => {
  if (options.managedEnv.OPENCODE_CONFIG !== managedConfigPath(options.dataDir) || options.managedEnv.OPENCODE_CONFIG_CONTENT !== undefined) {
    throw Object.assign(new Error('Desktop OpenCode requires its owned managed config'), { code: 'OPENCODE_PRIVATE_RUNTIME_REQUIRED' });
  }
  return privateChildEnvironment(options);
};

/** Version probes also initialize OpenCode's storage, before managed config exists. */
export const desktopOpenCodeProbeEnvironment = (env = process.env) => {
  const dataDir = process.env.OPENCHAMBER_DATA_DIR?.trim();
  if (!dataDir) throw Object.assign(new Error('Desktop OpenCode requires its private data directory'), { code: 'OPENCODE_PRIVATE_RUNTIME_REQUIRED' });
  return privateChildEnvironment({ env, dataDir, managedEnv: {} });
};

export const isDesktopOpenCodePrivateEnvironment = ({ env, dataDir, child = false }) => {
  if (!env || !dataDir) return false;
  try { if (!privatePathsAreOwned(dataDir)) return false; } catch { return false; }
  if (!Object.entries(parentPaths(dataDir)).every(([name, value]) => env[name] === value)) return false;
  if ([...connectionKeys, 'OPENCODE_HOST', 'OPENCODE_PORT', 'OPENCODE_SKIP_START', 'OPENCODE_CONFIG_CONTENT'].some((name) => env[name] !== undefined)) return false;
  if (!child) return env.OPENCODE_CONFIG === undefined;
  const paths = desktopOpenCodePrivatePaths(dataDir);
  return env.OPENCODE_CONFIG === managedConfigPath(dataDir)
    && env.HOME === paths.home && env.USERPROFILE === paths.home
    && env.XDG_CONFIG_HOME === paths.config && env.XDG_DATA_HOME === paths.data
    && env.XDG_CACHE_HOME === paths.cache && env.XDG_STATE_HOME === paths.state
    && env.APPDATA === paths.config && env.LOCALAPPDATA === paths.data;
};
