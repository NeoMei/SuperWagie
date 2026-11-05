import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'scripts/product-help-content.mjs');
const source = path.join(root, 'packages/web/server/lib/product-help/content.json');
const fixture = {
  schemaVersion: 1,
  catalogVersion: '2026-11-05.test',
  revision: 2,
  minAppVersion: '2.7.57',
  articles: [{
    id: 'models-first-connection',
    keywords: ['model', '模型'],
    en: { title: 'Connect a model', text: 'Open Settings, then Model configuration.' },
    'zh-CN': { title: '接入模型', text: '打开设置，再打开模型配置。' },
  }],
};

const temporaryDirectory = async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sw-product-help-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

test('content CLI checks the author source without writing output', () => {
  const result = spawnSync(process.execPath, [cli, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Validated product help/);
});

test('content CLI writes only the validated author bytes as catalog.json', async (t) => {
  const directory = await temporaryDirectory(t);
  const result = spawnSync(process.execPath, [cli, '--output', directory], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(directory), ['catalog.json']);
  assert.deepEqual(await readFile(path.join(directory, 'catalog.json')), await readFile(source));
});

test('content validation preserves an existing output after malformed, incompatible or oversized input', async (t) => {
  const { buildProductHelpContent } = await import('./product-help-content.mjs');
  const directory = await temporaryDirectory(t);
  const sourcePath = path.join(directory, 'author.json');
  const outputDir = path.join(directory, 'output');
  await mkdir(outputDir);
  await writeFile(path.join(outputDir, 'catalog.json'), 'previous content');
  const invalid = [
    '{',
    JSON.stringify({ ...fixture, revision: 0 }),
    JSON.stringify({ ...fixture, minAppVersion: '999.0.0' }),
    JSON.stringify({ ...fixture, maxAppVersion: '0.0.1' }),
    `${JSON.stringify(fixture)}${' '.repeat(512_000)}`,
  ];
  for (const text of invalid) {
    await writeFile(sourcePath, text);
    await assert.rejects(buildProductHelpContent({ sourcePath, outputDir }));
    assert.equal(await readFile(path.join(outputDir, 'catalog.json'), 'utf8'), 'previous content');
    assert.deepEqual(await readdir(outputDir), ['catalog.json']);
  }
});

test('content CLI rejects missing or unknown options without writing output', async () => {
  for (const args of [[], ['--output'], ['--unknown'], ['--check', '--output', '/unused']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});

test('standalone website build carries the author JSON at the public help path without dependencies', async (t) => {
  const directory = await temporaryDirectory(t);
  await cp(path.join(root, 'site/src'), path.join(directory, 'site/src'), { recursive: true });
  await cp(path.join(root, 'site/build.mjs'), path.join(directory, 'site/build.mjs'));
  const contentDirectory = path.join(directory, 'packages/web/server/lib/product-help');
  await mkdir(contentDirectory, { recursive: true });
  const bytes = `${JSON.stringify(fixture, null, 2)}\n`;
  await writeFile(path.join(contentDirectory, 'content.json'), bytes);
  const result = spawnSync(process.execPath, [path.join(directory, 'site/build.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(directory, 'site/dist/product-help/v1/catalog.json'), 'utf8'), bytes);
});
