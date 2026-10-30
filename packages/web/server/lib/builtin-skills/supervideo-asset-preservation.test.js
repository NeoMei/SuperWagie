import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { createProject, readProject } from '../../builtin-skills/supervideo-engine/src/core/store.mjs';
import { importAsset } from '../../builtin-skills/supervideo-engine/src/providers/assets.mjs';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supervideo-asset-preservation-'));
  roots.push(root);
  const project = path.join(root, 'project');
  const source = path.join(root, 'source.wav');
  await createProject(project, { mode: 'book', output: { width: 1280, height: 720, fps: 30 } });
  await fs.writeFile(source, 'original audio fixture');
  return { project, source, origin: { kind: 'host', reference: 'fixture', version: '1' } };
}

it('reuses identical bytes on reimport and restores a missing registered file', async () => {
  const { project, source, origin } = await fixture();
  const original = await importAsset(project, { path: source, origin });
  expect(await importAsset(project, { path: source, origin })).toEqual(original);
  const destination = path.join(project, original.path);
  await fs.unlink(destination);
  expect(await importAsset(project, { path: source, origin })).toEqual(original);
  expect(await fs.readFile(destination, 'utf8')).toBe('original audio fixture');
});

it.each(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'])('imports without overwriting existing assets when hard links fail with %s', async (code) => {
  const { project, source, origin } = await fixture();
  const originalLink = fs.link;
  fs.link = async () => { throw Object.assign(new Error('Filesystem does not support hard links'), { code }); };
  syncBuiltinESMExports();
  try {
    const asset = await importAsset(project, { path: source, origin });
    const destination = path.join(project, asset.path);
    expect(await fs.readFile(destination, 'utf8')).toBe('original audio fixture');
    expect(await importAsset(project, { path: source, origin })).toEqual(asset);
    await fs.writeFile(destination, 'user edits');
    await expect(importAsset(project, { path: source, origin })).rejects.toMatchObject({ code: 'ASSET_HASH_MISMATCH' });
    expect(await fs.readFile(destination, 'utf8')).toBe('user edits');
    expect((await readProject(project)).assets).toEqual([asset]);
  } finally {
    fs.link = originalLink;
    syncBuiltinESMExports();
  }
});

it('preserves an incomplete exclusive write without registering or overwriting it on retry', async () => {
  const { project, source, origin } = await fixture();
  const originalLink = fs.link;
  const originalOpen = fs.open;
  fs.link = async () => { throw Object.assign(new Error('Filesystem does not support hard links'), { code: 'ENOTSUP' }); };
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (path.dirname(args[0]) === path.join(project, 'assets') && !path.basename(args[0]).startsWith('.asset-')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async () => {
        await write('partial');
        throw Object.assign(new Error('Disk is full'), { code: 'ENOSPC' });
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await expect(importAsset(project, { path: source, origin })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect((await readProject(project)).assets).toEqual([]);
    const entries = await fs.readdir(path.join(project, 'assets'));
    expect(entries).toHaveLength(1);
    const destination = path.join(project, 'assets', entries[0]);
    expect(await fs.readFile(destination, 'utf8')).toBe('partial');
    await expect(importAsset(project, { path: source, origin })).rejects.toMatchObject({ code: 'ASSET_HASH_MISMATCH' });
    expect(await fs.readFile(destination, 'utf8')).toBe('partial');
  } finally {
    fs.link = originalLink;
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
});

it('preserves modified destination bytes when the original is reimported', async () => {
  const { project, source, origin } = await fixture();
  const original = await importAsset(project, { path: source, origin });
  const destination = path.join(project, original.path);
  await fs.writeFile(destination, 'user edits that must survive');
  await expect(importAsset(project, { path: source, origin })).rejects.toMatchObject({ code: 'ASSET_HASH_MISMATCH' });
  expect(await fs.readFile(destination, 'utf8')).toBe('user edits that must survive');
  await expect(fs.access(path.join(project, 'project.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.unlink(destination);
  expect(await importAsset(project, { path: source, origin })).toEqual(original);
});

it('publishes identical concurrent imports without overwriting or partial bytes', async () => {
  const { project, source, origin } = await fixture();
  const first = await importAsset(project, { path: source, origin });
  const destination = path.join(project, first.path);
  await fs.unlink(destination);
  const results = await Promise.all(Array.from({ length: 5 }, () => importAsset(project, { path: source, origin })));
  expect(results).toEqual(Array(5).fill(first));
  expect(await fs.readFile(destination, 'utf8')).toBe('original audio fixture');
});

it('coalesces concurrent first imports into one registered asset', async () => {
  const { project, source, origin } = await fixture();
  const results = await Promise.all(Array.from({ length: 5 }, () => importAsset(project, { path: source, origin })));
  expect(results).toEqual(Array(5).fill(results[0]));
  expect(await fs.readFile(path.join(project, results[0].path), 'utf8')).toBe('original audio fixture');
});

it('returns the registered asset for concurrent identical JPEG bytes with different extensions', async () => {
  const { project, source, origin } = await fixture();
  const jpg = path.join(path.dirname(source), 'image.jpg');
  const jpeg = path.join(path.dirname(source), 'image.jpeg');
  await fs.copyFile(source, jpg);
  await fs.copyFile(source, jpeg);
  const [first, second] = await Promise.all([
    importAsset(project, { path: jpg, origin }),
    importAsset(project, { path: jpeg, origin }),
  ]);
  const registered = (await readProject(project)).assets;
  expect(registered).toHaveLength(1);
  expect(first).toEqual(registered[0]);
  expect(second).toEqual(registered[0]);
  expect(await fs.readFile(path.join(project, registered[0].path), 'utf8')).toBe('original audio fixture');
  expect(await fs.readdir(path.join(project, 'assets'))).toEqual([path.basename(registered[0].path)]);
});

it('preserves a modified registered JPEG when imported under its alternate extension', async () => {
  const { project, source, origin } = await fixture();
  const jpg = path.join(path.dirname(source), 'image.jpg');
  const jpeg = path.join(path.dirname(source), 'image.jpeg');
  await fs.copyFile(source, jpg);
  await fs.copyFile(source, jpeg);
  const registered = await importAsset(project, { path: jpg, origin });
  await fs.writeFile(path.join(project, registered.path), 'user edits');
  await expect(importAsset(project, { path: jpeg, origin })).rejects.toMatchObject({ code: 'ASSET_HASH_MISMATCH' });
  expect(await fs.readFile(path.join(project, registered.path), 'utf8')).toBe('user edits');
  expect(await fs.readdir(path.join(project, 'assets'))).toEqual([path.basename(registered.path)]);
});

it('rejects the same bytes and origin under a different MIME type without publishing an extra file', async () => {
  const { project, source, origin } = await fixture();
  const mp3 = path.join(path.dirname(source), 'same-audio.mp3');
  await fs.copyFile(source, mp3);
  const registered = await importAsset(project, { path: source, origin });
  await expect(importAsset(project, { path: mp3, origin })).rejects.toMatchObject({ code: 'ASSET_TYPE_MISMATCH' });
  expect(await fs.readdir(path.join(project, 'assets'))).toEqual([path.basename(registered.path)]);
});

it('coalesces concurrent mixed MIME requests without registering an invalid type', async () => {
  const { project, source, origin } = await fixture();
  const mp3 = path.join(path.dirname(source), 'same-audio.mp3');
  await fs.copyFile(source, mp3);
  const outcomes = await Promise.allSettled([
    importAsset(project, { path: source, origin }),
    importAsset(project, { path: mp3, origin }),
  ]);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === 'rejected')[0].reason).toMatchObject({ code: 'ASSET_TYPE_MISMATCH' });
  const registered = (await readProject(project)).assets;
  expect(registered).toHaveLength(1);
  expect(await fs.readdir(path.join(project, 'assets'))).toEqual([path.basename(registered[0].path)]);
});

it.skipIf(process.platform === 'win32')('refuses an existing symlink at the content-addressed destination', async () => {
  const { project, source, origin } = await fixture();
  const original = await importAsset(project, { path: source, origin });
  const destination = path.join(project, original.path);
  const outside = path.join(path.dirname(project), 'outside.wav');
  await fs.writeFile(outside, 'user file');
  await fs.unlink(destination);
  await fs.symlink(outside, destination);
  await expect(importAsset(project, { path: source, origin })).rejects.toMatchObject({ code: 'ASSET_HASH_MISMATCH' });
  expect(await fs.readFile(outside, 'utf8')).toBe('user file');
  expect((await fs.lstat(destination)).isSymbolicLink()).toBe(true);
});
