import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, hashPreviewDir, inspectTask } from '../src/inspect.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, 'fixtures', 'pages', name);

async function taskWithPage(page: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'superweb-inspect-'));
  await mkdir(join(dir, '预览'), { recursive: true });
  await cp(fixture(page), join(dir, '预览', 'index.html'));
  return dir;
}

const chrome = findChrome();

test('local Chrome discovery yields an executable path', () => {
  if (!chrome.available) {
    assert.ok(chrome.reason && chrome.reason.length > 0);
    return;
  }
  assert.ok(chrome.path?.startsWith('/') || chrome.path?.includes('\\'));
});

test('missing Chrome returns an explainable failure and a report', async () => {
  const dir = await taskWithPage('good.html');
  const result = await inspectTask({
    taskDir: dir,
    route: 'page',
    chrome: join(dir, 'definitely-not-chrome'),
  });
  assert.equal(result.exitCode, 4);
  assert.equal(result.report.passed, false);
  assert.equal(result.report.browser.available, false);
  assert.match(result.report.browser.reason ?? '', /not found|找不到|不存在/i);
  const report = JSON.parse(await readFile(join(dir, '验收', 'report.json'), 'utf8'));
  assert.equal(report.browser.available, false);
  assert.ok(report.issues.some((issue: { check: string }) => issue.check === 'browser'));
});

test('browser inspection finds overflow, broken images and console errors', { skip: chrome.available ? false : 'Chrome not installed' }, async () => {
  const dir = await taskWithPage('bad.html');
  const result = await inspectTask({ taskDir: dir, route: 'page' });
  assert.equal(result.report.browser.available, true);
  assert.equal(result.report.viewports.length, 3);
  assert.equal(result.report.passed, false);
  assert.equal(result.exitCode, 1);

  const checks = new Set(result.report.issues.map((issue) => issue.check));
  assert.ok(checks.has('overflow'), `overflow missing: ${JSON.stringify(result.report.issues)}`);
  assert.ok(checks.has('images'));
  assert.ok(checks.has('console'));
  assert.ok(result.report.issues.some((issue) => issue.viewport === 'mobile'));

  for (const viewport of result.report.viewports) {
    const file = join(dir, viewport.screenshot);
    assert.equal((await stat(file)).isFile(), true);
  }
  const report = JSON.parse(await readFile(join(dir, '验收', 'report.json'), 'utf8'));
  assert.equal(report.passed, false);
  assert.ok(report.issueCount > 0);
});

test('a clean responsive page passes all three viewports', { skip: chrome.available ? false : 'Chrome not installed' }, async () => {
  const dir = await taskWithPage('good.html');
  const result = await inspectTask({ taskDir: dir, route: 'page' });
  assert.equal(result.report.passed, true, JSON.stringify(result.report.issues));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.report.viewports.map((viewport) => [viewport.name, viewport.width]),
    [
      ['desktop', 1440],
      ['tablet', 768],
      ['mobile', 390],
    ],
  );
});

test('preview fingerprint changes when preview content changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superweb-fingerprint-'));
  await mkdir(join(dir, '预览'), { recursive: true });
  await writeFile(join(dir, '预览', 'index.html'), '<html><body>one</body></html>', 'utf8');
  const first = await hashPreviewDir(join(dir, '预览'));
  await writeFile(join(dir, '预览', 'index.html'), '<html><body>two</body></html>', 'utf8');
  const second = await hashPreviewDir(join(dir, '预览'));
  assert.notEqual(first, second);
});
