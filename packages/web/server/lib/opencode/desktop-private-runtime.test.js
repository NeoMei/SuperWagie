import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { desktopOpenCodeChildEnvironment, isDesktopOpenCodePrivateEnvironment, prepareDesktopOpenCodeEnvironment } from './desktop-private-runtime.js';

const roots = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-private-runtime-'));
  roots.push(root);
  return { root, dataDir: path.join(root, 'superwagie'), system: path.join(root, 'system') };
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('writes providers only into the desktop private root while system config and auth remain unchanged', () => {
  const { dataDir, system } = fixture();
  fs.mkdirSync(system, { recursive: true });
  const config = '{"model":"system/existing","providers":{"system":{"name":"System"}}}\n';
  const credential = 'system-credential-fixture';
  fs.writeFileSync(path.join(system, 'opencode.json'), config);
  fs.writeFileSync(path.join(system, 'auth.json'), credential);
  const env = prepareDesktopOpenCodeEnvironment({ env: {
    ...process.env, OPENCODE_CONFIG_DIR: system, OPENCODE_CONFIG: path.join(system, 'opencode.json'),
    OPENCODE_HOST: 'http://127.0.0.1:4096', OPENCODE_DB: path.join(system, 'opencode.db'),
  }, dataDir });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { upsertProviderConfig } = await import('./server/lib/opencode/providers.js');
    upsertProviderConfig('superwagie-account-test', {
      name: 'SuperWagie', package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: 'https://example.test/v1' },
      models: { chat: { name: 'Chat' } },
    }, null, 'user', { hasStoredAuth: true });
  `], { cwd: path.resolve(import.meta.dirname, '../../..'), env, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'opencode-private', 'config', 'opencode.json'), 'utf8'));
  expect(saved.providers['superwagie-account-test'].name).toBe('SuperWagie');
  expect(saved.providers.system).toBeUndefined();
  expect(fs.readFileSync(path.join(system, 'opencode.json'), 'utf8')).toBe(config);
  expect(fs.readFileSync(path.join(system, 'auth.json'), 'utf8')).toBe(credential);
});

it('keeps host home and XDG variables while clearing system OpenCode connection and config overrides', () => {
  const { dataDir } = fixture();
  const env = { HOME: '/host/home', XDG_DATA_HOME: '/host/data', OPENCODE_HOST: 'http://127.0.0.1:4096', OPENCODE_SKIP_START: 'true', OPENCODE_CONFIG_CONTENT: '{"model":"system/model"}' };
  prepareDesktopOpenCodeEnvironment({ env, dataDir });
  expect(env.HOME).toBe('/host/home');
  expect(env.XDG_DATA_HOME).toBe('/host/data');
  expect(env.OPENCODE_HOST).toBeUndefined();
  expect(env.OPENCODE_SKIP_START).toBeUndefined();
  expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  expect(isDesktopOpenCodePrivateEnvironment({ env, dataDir })).toBe(true);
  env.OPENCODE_CONFIG_DIR = '/host/config';
  expect(isDesktopOpenCodePrivateEnvironment({ env, dataDir })).toBe(false);
});

it('rejects system managed-config paths and ignores shell storage overrides for the child', () => {
  const { dataDir } = fixture();
  const env = { HOME: '/host/home', XDG_DATA_HOME: '/host/data', XDG_CONFIG_HOME: '/host/config', XDG_RUNTIME_DIR: '/host/runtime', OPENCODE_CONFIG_DIR: '/host/config', OPENCODE_DB: '/host/db' };
  expect(() => desktopOpenCodeChildEnvironment({ env, dataDir, managedEnv: { OPENCODE_CONFIG: '/host/opencode.json' } })).toThrow('owned managed config');
  const child = desktopOpenCodeChildEnvironment({ env, dataDir, managedEnv: { OPENCODE_CONFIG: path.join(dataDir, 'run', 'instances', String(process.pid), 'opencode.managed.json'), OPENCODE_PASSWORD: 'test-private-password' } });
  expect(child.HOME).toBe(path.join(dataDir, 'opencode-private', 'home'));
  expect(child.XDG_DATA_HOME).toBe(path.join(dataDir, 'opencode-private', 'data'));
  expect(child.XDG_RUNTIME_DIR).toBeUndefined();
  expect(child.OPENCODE_PASSWORD).toBe('test-private-password');
  expect(isDesktopOpenCodePrivateEnvironment({ env: child, dataDir, child: true })).toBe(true);
});

it('refuses private storage symlinks before touching the system target', () => {
  const { dataDir, system } = fixture();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(system);
  fs.symlinkSync(system, path.join(dataDir, 'opencode-private'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => prepareDesktopOpenCodeEnvironment({ env: {}, dataDir })).toThrow('symbolic links');
  expect(fs.readdirSync(system)).toEqual([]);
});

it('drops inherited model credentials and credential-file variables but permits explicit app variables', () => {
  const { dataDir } = fixture();
  const child = desktopOpenCodeChildEnvironment({
    env: { PATH: '/usr/bin', LANG: 'en_US.UTF-8', OPENAI_API_KEY: 'system-fixture', GOOGLE_APPLICATION_CREDENTIALS: '/system/credential.json', UNKNOWN_PROVIDER_SECRET: 'system-fixture' },
    userEnv: { OPENAI_API_KEY: 'app-fixture', MY_WORKFLOW_VALUE: 'saved-in-app' },
    dataDir,
    managedEnv: { OPENCODE_CONFIG: path.join(dataDir, 'run', 'instances', String(process.pid), 'opencode.managed.json') },
  });
  expect(child.OPENAI_API_KEY).toBe('app-fixture');
  expect(child.MY_WORKFLOW_VALUE).toBe('saved-in-app');
  expect(child.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  expect(child.UNKNOWN_PROVIDER_SECRET).toBeUndefined();
  expect(child.PATH).toBe('/usr/bin');
  expect(child.LANG).toBe('en_US.UTF-8');
});

it('rejects hardlinked private config files without importing their contents', () => {
  const { dataDir, system } = fixture();
  const env = prepareDesktopOpenCodeEnvironment({ env: {}, dataDir });
  fs.writeFileSync(system, '{"providers":{"system":{"name":"System"}}}');
  fs.linkSync(system, path.join(dataDir, 'opencode-private', 'config', 'opencode.json'));
  expect(isDesktopOpenCodePrivateEnvironment({ env, dataDir })).toBe(false);
  expect(() => prepareDesktopOpenCodeEnvironment({ env: {}, dataDir })).toThrow('linked files');
  expect(fs.readFileSync(system, 'utf8')).toBe('{"providers":{"system":{"name":"System"}}}');
});

it.each(['symlink', 'hardlink'])('rejects a %s to system service credentials on every private environment check', (linkType) => {
  const { dataDir, system } = fixture();
  const env = prepareDesktopOpenCodeEnvironment({ env: {}, dataDir });
  fs.writeFileSync(system, '{"env":{"OPENAI_API_KEY":"system-fixture"}}');
  const service = path.join(dataDir, 'opencode-private', 'config', 'service.json');
  if (linkType === 'symlink') fs.symlinkSync(system, service);
  else fs.linkSync(system, service);
  expect(isDesktopOpenCodePrivateEnvironment({ env, dataDir })).toBe(false);
  expect(fs.readFileSync(system, 'utf8')).toBe('{"env":{"OPENAI_API_KEY":"system-fixture"}}');
});
