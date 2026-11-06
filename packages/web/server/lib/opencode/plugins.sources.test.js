import { afterAll, beforeEach, beforeAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
const savedConfig = process.env.OPENCODE_CONFIG;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-plugin-sources-'));
const globalDir = path.join(root, 'global');
process.env.OPENCODE_CONFIG_DIR = globalDir;
delete process.env.OPENCODE_CONFIG;
let plugins;
beforeAll(async () => { plugins = await import('./plugins.js'); });
let projectDir;
const write = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
};
const read = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const id = (scope, spec) => Buffer.from(`config:${scope}:${spec}`).toString('base64url');

beforeEach(() => {
  fs.rmSync(globalDir, { recursive: true, force: true });
  projectDir = fs.mkdtempSync(path.join(root, 'project-'));
  delete process.env.OPENCODE_CONFIG;
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (savedConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
  if (savedConfig === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = savedConfig;
});

test('lists both global files and mutates the winning JSONC source', () => {
  const json = path.join(globalDir, 'opencode.json');
  const jsonc = path.join(globalDir, 'opencode.jsonc');
  write(json, { plugins: ['json-only', { package: 'shared', options: { owner: 'json' } }] });
  write(jsonc, { plugin: ['jsonc-only', ['shared', { owner: 'jsonc' }], '-hooks'] });
  const original = fs.readFileSync(json, 'utf8');
  expect(plugins.listPluginEntries(projectDir).map(entry => [entry.spec, entry.options])).toEqual([
    ['json-only', undefined], ['shared', { owner: 'jsonc' }], ['jsonc-only', undefined], ['-hooks', undefined],
  ]);
  expect(() => plugins.createPluginEntry({ spec: 'jsonc-only', scope: 'user' }, projectDir)).toThrow('already exists');
  plugins.updatePluginEntry(id('user', 'shared'), { options: { changed: true } }, projectDir);
  expect(read(jsonc).plugins).toEqual(['jsonc-only', { package: 'shared', options: { changed: true } }, '-hooks']);
  plugins.deletePluginEntry(id('user', 'jsonc-only'), projectDir);
  expect(read(jsonc).plugins).toEqual([{ package: 'shared', options: { changed: true } }, '-hooks']);
  expect(fs.readFileSync(json, 'utf8')).toBe(original);
});

test('uses custom options and writes new user declarations to the custom source', () => {
  const global = path.join(globalDir, 'opencode.json');
  const custom = path.join(projectDir, 'custom.jsonc');
  write(global, { plugins: ['global-only', { package: 'shared', options: { owner: 'global' } }] });
  write(custom, { plugin: [['shared', { owner: 'custom' }]] });
  process.env.OPENCODE_CONFIG = custom;
  const original = fs.readFileSync(global, 'utf8');
  expect(plugins.listPluginEntries(projectDir).map(entry => [entry.spec, entry.options])).toEqual([
    ['global-only', undefined], ['shared', { owner: 'custom' }],
  ]);
  plugins.updatePluginEntry(id('user', 'shared'), { options: { changed: true } }, projectDir);
  plugins.createPluginEntry({ spec: 'new-plugin', scope: 'user' }, projectDir);
  expect(read(custom).plugins).toEqual([{ package: 'shared', options: { changed: true } }, 'new-plugin']);
  plugins.deletePluginEntry(id('user', 'shared'), projectDir);
  expect(read(custom).plugins).toEqual(['new-plugin']);
  expect(fs.readFileSync(global, 'utf8')).toBe(original);
});

test('lists every ancestor and exact-project config in OpenCode order', () => {
  const child = path.join(projectDir, 'child');
  fs.mkdirSync(child);
  const custom = path.join(projectDir, 'custom.json');
  process.env.OPENCODE_CONFIG = custom;
  const files = [
    [path.join(globalDir, 'opencode.json'), 'global'],
    [path.join(globalDir, 'opencode.jsonc'), 'globalc'],
    [custom, 'custom'],
    [path.join(projectDir, 'opencode.json'), 'parent'],
    [path.join(projectDir, 'opencode.jsonc'), 'parentc'],
    [path.join(child, 'opencode.json'), 'project'],
    [path.join(child, 'opencode.jsonc'), 'projectc'],
    [path.join(projectDir, '.opencode', 'opencode.json'), 'parentdot'],
    [path.join(projectDir, '.opencode', 'opencode.jsonc'), 'parentdotc'],
    [path.join(child, '.opencode', 'opencode.json'), 'projectdot'],
    [path.join(child, '.opencode', 'opencode.jsonc'), 'projectdotc'],
  ];
  for (const [file, spec] of files) write(file, { plugins: [spec] });
  expect(plugins.listPluginEntries(child).map(entry => [entry.spec, entry.scope])).toEqual([
    ['global', 'user'], ['globalc', 'user'], ['custom', 'user'], ['parent', 'user'], ['parentc', 'user'],
    ['project', 'project'], ['projectc', 'project'], ['parentdot', 'user'], ['parentdotc', 'user'],
    ['projectdot', 'project'], ['projectdotc', 'project'],
  ]);
  plugins.updatePluginEntry(id('user', 'parent'), { options: { a: 1 } }, child);
  plugins.deletePluginEntry(id('project', 'projectc'), child);
  expect(read(path.join(projectDir, 'opencode.json')).plugins).toEqual([{ package: 'parent', options: { a: 1 } }]);
  expect(read(path.join(child, 'opencode.jsonc')).plugins).toBeUndefined();
  expect(read(path.join(child, '.opencode', 'opencode.jsonc')).plugins).toEqual(['projectdotc']);
});

test('uses the winning ancestor and exact-project duplicate for mutations', () => {
  const child = path.join(projectDir, 'child');
  fs.mkdirSync(child);
  const global = path.join(globalDir, 'opencode.json');
  const custom = path.join(projectDir, 'custom.json');
  const parent = path.join(projectDir, '.opencode', 'opencode.jsonc');
  const exact = path.join(child, '.opencode', 'opencode.jsonc');
  const lower = path.join(child, 'opencode.json');
  process.env.OPENCODE_CONFIG = custom;
  for (const [file, owner] of [[global, 'global'], [custom, 'custom'], [parent, 'parent'], [lower, 'lower'], [exact, 'exact']]) {
    write(file, { plugins: [{ package: 'shared', options: { owner } }] });
  }
  const unchanged = [global, custom, lower].map(file => fs.readFileSync(file, 'utf8'));
  expect(plugins.listPluginEntries(child).map(entry => [entry.scope, entry.options])).toEqual([
    ['user', { owner: 'parent' }], ['project', { owner: 'exact' }],
  ]);
  plugins.updatePluginEntry(id('user', 'shared'), { options: { updated: true } }, child);
  plugins.deletePluginEntry(id('project', 'shared'), child);
  expect(read(parent).plugins).toEqual([{ package: 'shared', options: { updated: true } }]);
  expect(read(exact).plugins).toBeUndefined();
  expect([global, custom, lower].map(file => fs.readFileSync(file, 'utf8'))).toEqual(unchanged);
});

test('keeps a custom file at user scope when it is also a project config', () => {
  const custom = path.join(projectDir, '.opencode', 'opencode.json');
  const exact = path.join(projectDir, 'opencode.json');
  write(custom, { plugins: ['shared', 'custom-only'] });
  write(exact, { plugins: ['shared', 'exact-only'] });
  process.env.OPENCODE_CONFIG = custom;
  expect(plugins.listPluginEntries(projectDir).map(entry => [entry.spec, entry.scope])).toEqual([
    ['shared', 'user'], ['custom-only', 'user'], ['shared', 'project'], ['exact-only', 'project'],
  ]);
  const original = fs.readFileSync(custom, 'utf8');
  plugins.deletePluginEntry(id('project', 'shared'), projectDir);
  expect(read(exact).plugins).toEqual(['exact-only']);
  expect(fs.readFileSync(custom, 'utf8')).toBe(original);
});

test('preserves custom symlink relative targets and canonical overlap deduplication', () => {
  const physical = path.join(projectDir, '.opencode', 'opencode.json');
  const customFolder = path.join(projectDir, 'custom');
  const alias = path.join(customFolder, 'alias.json');
  const local = path.join(customFolder, 'plugins', 'local');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(customFolder, 'plugins', 'ignored.js'), 'export default {};');
  write(physical, { plugin: [['./plugins/local', { owner: 'custom' }]] });
  fs.symlinkSync(physical, alias);
  process.env.OPENCODE_CONFIG = alias;
  expect(plugins.listPluginEntries(projectDir).map(entry => [entry.spec, entry.scope, entry.resolvedPath, entry.options])).toEqual([
    ['./plugins/local', 'user', fs.realpathSync(local), { owner: 'custom' }],
  ]);
  expect(plugins.listPluginDirFiles(projectDir)).toEqual([]);
});

test('keeps custom relative targets when a global config aliases the same file', () => {
  const custom = path.join(projectDir, 'custom', 'config.json');
  const local = path.join(projectDir, 'custom', 'plugins', 'local');
  fs.mkdirSync(local, { recursive: true });
  write(custom, { plugins: [{ package: './plugins/local', options: { owner: 'custom' } }] });
  fs.mkdirSync(globalDir, { recursive: true });
  fs.symlinkSync(custom, path.join(globalDir, 'opencode.json'));
  process.env.OPENCODE_CONFIG = custom;
  expect(plugins.listPluginEntries(projectDir).map(entry => [entry.scope, entry.resolvedPath, entry.options])).toEqual([
    ['user', fs.realpathSync(local), { owner: 'custom' }],
  ]);
});

test('keeps valid siblings writable and refuses to overwrite malformed targets', () => {
  const child = path.join(projectDir, 'child');
  fs.mkdirSync(child);
  const brokenFiles = [path.join(globalDir, 'opencode.jsonc'), path.join(projectDir, 'opencode.jsonc'), path.join(child, 'opencode.jsonc')];
  for (const file of brokenFiles) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "plugins": [');
  }
  const parent = path.join(projectDir, 'opencode.json');
  write(parent, { plugin: [['valid', { a: 1 }], '-hooks'] });
  expect(plugins.listPluginEntries(child).map(entry => entry.spec)).toEqual(['valid', '-hooks']);
  plugins.updatePluginEntry(id('user', 'valid'), { options: { a: 2 } }, child);
  expect(read(parent).plugins).toEqual([{ package: 'valid', options: { a: 2 } }, '-hooks']);
  for (const file of brokenFiles) {
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "plugins": [');
    expect(fs.existsSync(`${file}.openchamber.backup`)).toBe(false);
  }
  process.env.OPENCODE_CONFIG = brokenFiles[1];
  expect(() => plugins.createPluginEntry({ spec: 'new-plugin', scope: 'user' }, child)).toThrow('cannot be loaded safely');
  expect(fs.readFileSync(brokenFiles[1], 'utf8')).toBe('{ "plugins": [');
});

for (const format of ['native', 'legacy', 'mixed']) {
  for (const operation of ['options', 'spec', 'delete']) {
    test(`${operation} targets the last ${format} declaration and preserves earlier records`, () => {
      const lower = path.join(globalDir, 'opencode.json');
      const winner = path.join(globalDir, 'opencode.jsonc');
      const first = { package: 'shared', options: { owner: 'first', nested: { keep: true } } };
      const last = { package: 'shared', options: { owner: 'last' } };
      const unrelated = { settings: { keep: ['original'] }, description: 'preserved' };
      write(lower, { plugins: [{ package: 'shared', options: { owner: 'lower' } }] });
      const originalLower = fs.readFileSync(lower, 'utf8');
      const sections = format === 'native'
        ? { plugins: [first, 'between', last] }
        : format === 'legacy'
          ? { plugin: [['shared', first.options], 'between', ['shared', last.options]] }
          : { plugin: [['shared', first.options], 'between'], plugins: [last] };
      write(winner, { ...unrelated, ...sections });
      expect(plugins.getPluginEntry(id('user', 'shared'), projectDir)?.options).toEqual({ owner: 'last' });

      if (operation === 'delete') plugins.deletePluginEntry(id('user', 'shared'), projectDir);
      else plugins.updatePluginEntry(id('user', 'shared'), operation === 'options'
        ? { options: { changed: true } } : { spec: 'renamed-plugin' }, projectDir);

      const expected = operation === 'delete' ? [first, 'between']
        : operation === 'options' ? [first, 'between', { package: 'shared', options: { changed: true } }]
          : [first, 'between', { package: 'renamed-plugin', options: { owner: 'last' } }];
      expect(read(winner)).toEqual({ ...unrelated, plugins: expected });
      expect(fs.readFileSync(lower, 'utf8')).toBe(originalLower);
      expect(plugins.getPluginEntry(id('user', operation === 'spec' ? 'renamed-plugin' : 'shared'), projectDir)?.options)
        .toEqual(operation === 'delete' ? first.options : operation === 'options' ? { changed: true } : last.options);
    });
  }
}

for (const operation of ['options', 'spec', 'delete']) {
  test(`${operation} skips and preserves malformed records around the winning declaration`, () => {
    const winner = path.join(globalDir, 'opencode.json');
    const first = { package: 'shared', options: { owner: 'first' } };
    const last = { package: 'shared', options: { owner: 'last' } };
    write(winner, { marker: true, plugins: [null, first, 42, last, { invalid: true }] });
    expect(plugins.getPluginEntry(id('user', 'shared'), projectDir)?.options).toEqual(last.options);

    if (operation === 'delete') plugins.deletePluginEntry(id('user', 'shared'), projectDir);
    else plugins.updatePluginEntry(id('user', 'shared'), operation === 'options'
      ? { options: { changed: true } } : { spec: 'renamed-plugin' }, projectDir);

    const expected = operation === 'delete' ? [null, first, 42, { invalid: true }]
      : operation === 'options' ? [null, first, 42, { package: 'shared', options: { changed: true } }, { invalid: true }]
        : [null, first, 42, { package: 'renamed-plugin', options: { owner: 'last' } }, { invalid: true }];
    expect(read(winner)).toEqual({ marker: true, plugins: expected });
  });
}
