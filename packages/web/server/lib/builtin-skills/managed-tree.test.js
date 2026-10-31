import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUNDLE, RECEIPT, inventory, refreshManagedTree } from './managed-tree.js';

let root;
let source;
let destination;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function write(relative, value, directory = source) {
  await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
  await fs.writeFile(path.join(directory, relative), value);
}
async function bundle(version = '1.0.0', closure = 'dependencies') {
  const entries = (await inventory(source, { ignoreBundle: true })).entries;
  const value = { schema: 1, id: digest(entries), closure, version };
  await write(BUNDLE, JSON.stringify(value));
  return value;
}
const run = (options = {}) => refreshManagedTree({ name: 'superweb', source, destination, root, ...options });
const contents = () => fs.readFile(path.join(destination, 'SKILL.md'), 'utf8');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-skills-'));
  source = path.join(root, 'source');
  destination = path.join(root, 'installed');
  await write('SKILL.md', 'old');
  await write('obsolete.txt', 'obsolete');
  await bundle();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('managed payload replacement', () => {
  it('records identity, replaces complete untouched trees, and skips without walking or writing', async () => {
    expect(await run()).toBe('installed');
    await fs.unlink(path.join(source, 'obsolete.txt'));
    await write('SKILL.md', 'new');
    await bundle('1.1.0');
    expect(await run()).toBe('updated');
    expect(await contents()).toBe('new');
    await expect(fs.stat(path.join(destination, 'obsolete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    let reads = 0;
    const io = { ...fs,
      readdir: async () => { throw new Error('unexpected tree walk'); },
      open: async () => { throw new Error('unexpected write/lock'); },
      readFile: async (...args) => { reads++; return fs.readFile(...args); },
    };
    expect(await run({ io })).toBe('skipped');
    expect(reads).toBe(2);
  });

  for (const mutation of ['edit', 'extra', 'missing', 'mode', 'link', 'empty-directory', 'bundle-file']) {
    it(`preserves ${mutation} before an upgrade`, async () => {
      await run();
      if (mutation === 'edit') await write('SKILL.md', 'mine', destination);
      if (mutation === 'extra') await write('mine.txt', 'mine', destination);
      if (mutation === 'missing') await fs.unlink(path.join(destination, 'SKILL.md'));
      if (mutation === 'mode') await fs.chmod(path.join(destination, 'SKILL.md'), 0o755);
      if (mutation === 'link') { await fs.unlink(path.join(destination, 'SKILL.md')); await fs.symlink(path.join(source, 'SKILL.md'), path.join(destination, 'SKILL.md')); }
      if (mutation === 'empty-directory') await fs.mkdir(path.join(destination, 'custom'));
      if (mutation === 'bundle-file') await write(BUNDLE, 'custom', destination);
      const before = await fs.readdir(destination);
      await write('SKILL.md', 'new'); await bundle('1.1.0');
      await expect(run()).rejects.toMatchObject({ preserved: true });
      expect(await fs.readdir(destination)).toEqual(before);
    });
  }

  it('preserves a newer receipt when started by an older bundle', async () => {
    await bundle('2.0.0'); await run();
    await write('SKILL.md', 'older'); await bundle('1.0.0');
    await expect(run()).rejects.toMatchObject({ preserved: true });
    expect(await contents()).toBe('old');
  });

  for (const corrupt of ['invalid-json', 'owner', 'schema', 'digest', 'path']) {
    it(`preserves a receipt with ${corrupt}`, async () => {
      await run();
      const receipt = JSON.parse(await fs.readFile(path.join(destination, RECEIPT), 'utf8'));
      if (corrupt === 'owner') receipt.owner = 'other';
      if (corrupt === 'schema') receipt.schema = 9;
      if (corrupt === 'digest') receipt.digest = 'wrong';
      if (corrupt === 'path') { receipt.entries[0][0] = '../outside'; receipt.digest = digest(receipt.entries); }
      await write(RECEIPT, corrupt === 'invalid-json' ? '{' : JSON.stringify(receipt), destination);
      await expect(run()).rejects.toMatchObject({ preserved: true });
      expect(await contents()).toBe('old');
    });
  }

  it('refuses linked intermediate destination directories', async () => {
    const outside = path.join(root, 'outside'); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, 'linked'));
    await expect(run({ destination: path.join(root, 'linked', 'skill') })).rejects.toMatchObject({ preserved: true });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('normalizes packaged vendor dependencies and internal bin links', async () => {
    await write('vendor/node_modules/dep/cli.js', 'console.log(1)');
    await fs.mkdir(path.join(source, 'vendor/node_modules/.bin'));
    await fs.symlink('../dep/cli.js', path.join(source, 'vendor/node_modules/.bin/dep'));
    await bundle();
    expect(await run()).toBe('installed');
    expect(await fs.readlink(path.join(destination, 'node_modules/.bin/dep'))).toBe('../dep/cli.js');
    await expect(fs.stat(path.join(destination, 'vendor'))).rejects.toMatchObject({ code: 'ENOENT' });
    const first = (await inventory(destination)).entries;
    await fs.rename(path.join(source, 'vendor/node_modules'), path.join(source, 'node_modules'));
    await fs.rmdir(path.join(source, 'vendor')); await bundle();
    const second = path.join(root, 'second'); await run({ destination: second });
    expect((await inventory(second)).entries).toEqual(first);
  });

  it('refuses source dependency links escaping the bundle', async () => {
    await write('node_modules/dep/index.js', 'x');
    await fs.symlink(path.join(root, 'source/SKILL.md'), path.join(source, 'node_modules/external'));
    await bundle();
    await expect(run()).rejects.toMatchObject({ preserved: true });
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adopts only an exact finite legacy identity and carries opaque dependency inodes', async () => {
    await fs.cp(source, destination, { recursive: true }); await fs.unlink(path.join(destination, BUNDLE));
    const legacy = [{ entries: (await inventory(destination)).entries, closure: 'same' }];
    await write('node_modules/dep/custom.js', 'user dependency', destination);
    await fs.symlink('/unrelated/host', path.join(destination, 'node_modules/foreign'));
    const inode = (await fs.stat(path.join(destination, 'node_modules/dep/custom.js'))).ino;
    await write('SKILL.md', 'new'); await write('node_modules/dep/custom.js', 'vendor dependency'); await bundle('1.1.0', 'same');
    expect(await run({ legacy })).toBe('updated');
    expect((await fs.stat(path.join(destination, 'node_modules/dep/custom.js'))).ino).toBe(inode);
    expect(await fs.readFile(path.join(destination, 'node_modules/dep/custom.js'), 'utf8')).toBe('user dependency');
    expect(await fs.readlink(path.join(destination, 'node_modules/foreign'))).toBe('/unrelated/host');
    await write('SKILL.md', 'next'); await bundle('1.2.0', 'different');
    await expect(run({ legacy })).rejects.toMatchObject({ preserved: true });
    expect(await contents()).toBe('new');
  });

  it('preserves modified tracked dependencies when their replacement is proposed', async () => {
    await write('node_modules/dep/index.js', 'original'); await bundle(); await run();
    await write('node_modules/dep/index.js', 'edited', destination);
    await write('SKILL.md', 'new'); await bundle('1.1.0');
    await expect(run()).rejects.toMatchObject({ preserved: true });
  });

  it('carries Python caches unchanged during an exact legacy migration', async () => {
    await fs.cp(source, destination, { recursive: true }); await fs.unlink(path.join(destination, BUNDLE));
    const legacy = [{ entries: (await inventory(destination)).entries, closure: null }];
    await write('__pycache__/state.pyc', 'local cache', destination);
    await write('SKILL.md', 'new'); await bundle('1.1.0');
    expect(await run({ name: 'WPSComposer', legacy })).toBe('updated');
    expect(await fs.readFile(path.join(destination, '__pycache__/state.pyc'), 'utf8')).toBe('local cache');
  });

  for (const failure of ['read', 'chmod', 'first-rename', 'second-rename', 'rollback']) {
    it(`keeps a valid old copy after ${failure} failure and retries recovery`, async () => {
      await run();
      const oldReceipt = await fs.readFile(path.join(destination, RECEIPT), 'utf8');
      await write('SKILL.md', 'new'); await bundle('1.1.0');
      let failed = false;
      const io = { ...fs,
        readFile: async (filename, ...args) => {
          if (failure === 'read' && filename === path.join(source, 'SKILL.md')) throw new Error('read failure');
          return fs.readFile(filename, ...args);
        },
        chmod: async (...args) => { if (failure === 'chmod') throw new Error('mode failure'); return fs.chmod(...args); },
        rename: async (from, to) => {
          if ((failure === 'first-rename' && from === destination) ||
            (['second-rename', 'rollback'].includes(failure) && from.endsWith('.stage')) ||
            (failure === 'rollback' && from.endsWith('.backup'))) { failed = true; throw new Error('rename failure'); }
          return fs.rename(from, to);
        },
      };
      await expect(run({ io })).rejects.toThrow();
      if (failure === 'rollback') {
        expect(failed).toBe(true);
        expect((await fs.readdir(root)).some((name) => name.endsWith('.backup'))).toBe(true);
      } else {
        expect(await contents()).toBe('old');
        expect(await fs.readFile(path.join(destination, RECEIPT), 'utf8')).toBe(oldReceipt);
      }
      expect(await run()).toBe('updated');
      expect(await contents()).toBe('new');
      expect((await fs.readdir(root)).some((name) => /\.(stage|backup)$/.test(name))).toBe(false);
    });
  }

  it('detects a live edit made while staging', async () => {
    await run(); await write('SKILL.md', 'new'); await bundle('1.1.0');
    const io = { ...fs, chmod: async (...args) => { await fs.chmod(...args); await write('SKILL.md', 'late edit', destination); } };
    await expect(run({ io })).rejects.toMatchObject({ preserved: true });
    expect(await contents()).toBe('late edit');
  });
});

async function childWorker(body) {
  const filename = path.join(root, `worker-${Math.random()}.mjs`);
  await fs.writeFile(filename, `import fs from 'node:fs/promises';\nimport { refreshManagedTree } from ${JSON.stringify(new URL('./managed-tree.js', import.meta.url).href)};\nconst options = ${JSON.stringify({ name: 'superweb', source, destination, root })};\n${body}`);
  const child = spawn(process.execPath, [filename], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  return child;
}
async function ready(child) {
  for await (const bytes of child.stdout) { if (String(bytes).includes('READY')) return; }
  throw new Error('worker exited before reaching transaction');
}

describe('process lifetime', () => {
  it('skips a concurrent writer and resumes after its process is killed', async () => {
    await run(); await write('SKILL.md', 'new'); await bundle('1.1.0');
    const child = await childWorker(`await refreshManagedTree({...options,io:{...fs,chmod:async()=>{process.stdout.write('READY');await new Promise(()=>{setInterval(()=>{},1000);});}}});`);
    try {
      await ready(child);
      await expect(run()).rejects.toMatchObject({ preserved: true });
    } finally { child.kill('SIGKILL'); await once(child, 'exit'); }
    expect(await run()).toBe('updated');
  });

  for (const boundary of ['journal', 'backup', 'live']) {
    it(`recovers a process crash after the ${boundary} boundary`, async () => {
      await run(); await write('SKILL.md', 'new'); await bundle('1.1.0');
      const body = boundary === 'journal'
        ? `await refreshManagedTree({...options,io:{...fs,rename:async(from,to)=>{if(from===options.destination){process.stdout.write('READY');await new Promise(()=>{setInterval(()=>{},1000);});}return fs.rename(from,to);}}});`
        : `await refreshManagedTree({...options,io:{...fs,rename:async(from,to)=>{await fs.rename(from,to);if(${boundary === 'backup' ? 'from===options.destination' : "from.endsWith('.stage')"}){process.stdout.write('READY');await new Promise(()=>{setInterval(()=>{},1000);});}}}});`;
      const child = await childWorker(body);
      await ready(child); child.kill('SIGKILL'); await once(child, 'exit');
      expect(['updated', 'skipped']).toContain(await run());
      expect(await contents()).toBe('new');
      expect((await fs.readdir(root)).some((name) => /\.(stage|backup)$/.test(name))).toBe(false);
    });
  }
});

it('refuses a dependency link into a bundle core file before vendor normalization', async () => {
  await fs.mkdir(path.join(source, 'vendor/node_modules'), { recursive: true });
  await fs.symlink('../../SKILL.md', path.join(source, 'vendor/node_modules/core'));
  await bundle();
  await expect(run()).rejects.toMatchObject({ preserved: true });
});

it('retains an edited receipt in recovery data', async () => {
  await run(); await write('SKILL.md', 'new'); await bundle('1.1.0');
  const io = { ...fs, rename: async (from, to) => {
    if (from.endsWith('.stage')) {
      const backup = (await fs.readdir(root)).find((name) => name.endsWith('.backup'));
      await fs.writeFile(path.join(root, backup, RECEIPT), '{broken');
      throw new Error('interrupted with edited recovery data');
    }
    return fs.rename(from, to);
  } };
  await expect(run({ io })).rejects.toThrow();
  await expect(run()).rejects.toMatchObject({ preserved: true });
  expect((await fs.readdir(root)).some((name) => name.endsWith('.backup'))).toBe(true);
});

for (const dependencyPath of ['node_modules', 'vendor/node_modules']) {
  it(`refuses a linked ${dependencyPath} dependency root`, async () => {
    const external = path.join(root, 'external');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'custom.js'), 'external bytes');
    const link = path.join(source, dependencyPath);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(path.relative(path.dirname(link), external), link);
    await bundle();
    await expect(run()).rejects.toMatchObject({ preserved: true });
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(external, 'custom.js'), 'utf8')).toBe('external bytes');
    expect(await fs.readdir(external)).toEqual(['custom.js']);
  });
}

it('receipts retained cache ancestors before removing the shipped script directory', async () => {
  await write('obsolete/script.py', '# old script');
  await bundle();
  await run({ name: 'WPSComposer' });
  const cache = 'obsolete/__pycache__/user.pyc';
  await write(cache, 'user cache bytes', destination);
  const inode = (await fs.stat(path.join(destination, cache))).ino;
  await fs.rm(path.join(source, 'obsolete'), { recursive: true });
  await bundle('1.1.0');
  const warnings = [];
  expect(await run({ name: 'WPSComposer', warn: (message) => warnings.push(message) })).toBe('updated');
  expect(warnings).toEqual([]);
  expect(await fs.readFile(path.join(destination, cache), 'utf8')).toBe('user cache bytes');
  expect((await fs.stat(path.join(destination, cache))).ino).toBe(inode);
  await expect(fs.stat(path.join(destination, 'obsolete/script.py'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.readdir(root)).filter((name) => /\.(stage|backup)$/.test(name) || name.endsWith('superwagie-transaction.json'))).toEqual([]);
  const receipt = JSON.parse(await fs.readFile(path.join(destination, RECEIPT), 'utf8'));
  expect(receipt.entries).toContainEqual(['obsolete', 'directory']);
  expect(await run({ name: 'WPSComposer' })).toBe('skipped');
  expect((await fs.stat(path.join(destination, cache))).ino).toBe(inode);
});

it('source identities ignore local build output while prepared identities include dependency bytes', async () => {
  const { writeBundleIdentity } = await import('./managed-tree.js');
  await write('SKILL.md', 'source');
  await writeBundleIdentity(source, { sourceOnly: true });
  const original = await fs.readFile(path.join(source, BUNDLE), 'utf8');
  await write('node_modules/local/index.js', 'generated dependency');
  await write('dist/cli.js', 'generated build');
  await write('__pycache__/cache.pyc', 'generated cache');
  await writeBundleIdentity(source, { sourceOnly: true, check: true });
  expect(await fs.readFile(path.join(source, BUNDLE), 'utf8')).toBe(original);
  await writeBundleIdentity(source);
  expect(await fs.readFile(path.join(source, BUNDLE), 'utf8')).not.toBe(original);
  await write('node_modules/local/index.js', 'changed native closure');
  await expect(writeBundleIdentity(source, { check: true })).rejects.toThrow('stale');
});
