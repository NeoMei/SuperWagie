import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSelfContained, deliverTask, DeliveryError } from '../src/delivery.js';
import { applyDecision, createState, markDirectionsReady, markInspected } from '../src/state.js';
import type { SuperwebState } from '../src/schema.js';

function deliveredState(passed = true): SuperwebState {
  const ready = markDirectionsReady(createState({ taskId: 'deliver-abc123', route: 'page' }));
  let state = applyDecision(ready, {
    gate: 'direction',
    choice: 'editorial-swiss',
    revision: ready.stageRevision,
    decisionId: 'd-direction',
  }).state;
  state = applyDecision(state, {
    gate: 'sample',
    choice: 'accept',
    revision: state.stageRevision,
    decisionId: 'd-sample',
  }).state;
  state = markInspected(state, {
    passed,
    reportPath: '验收/report.json',
    screenshots: ['验收/desktop.png'],
    browserAvailable: true,
    issueCount: passed ? 0 : 1,
  });
  return applyDecision(state, {
    gate: 'acceptance',
    choice: 'accept',
    revision: state.stageRevision,
    decisionId: 'd-accept',
    acknowledgeIssues: !passed,
  }).state;
}

async function taskWithPreview(html: string, state = deliveredState()): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'superweb-deliver-'));
  await mkdir(join(dir, '预览', 'assets'), { recursive: true });
  await mkdir(join(dir, '验收'), { recursive: true });
  await writeFile(join(dir, '预览', 'index.html'), html, 'utf8');
  await writeFile(join(dir, '验收', 'report.json'), JSON.stringify({ passed: state.acceptance.passed, issues: [] }), 'utf8');
  await writeFile(join(dir, 'superweb.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return dir;
}

test('self-contained check accepts relative assets and data URIs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superweb-sc-'));
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'photo.png'), 'png', 'utf8');
  await writeFile(join(dir, 'style.css'), 'body{background:url("assets/photo.png")}', 'utf8');
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><link rel="stylesheet" href="style.css"><img src="assets/photo.png"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><a href="https://example.com">out</a>',
    'utf8',
  );
  assert.deepEqual(await checkSelfContained(dir), []);
});

test('self-contained check rejects absolute, remote and missing assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superweb-sc-'));
  await writeFile(
    join(dir, 'index.html'),
    [
      '<!doctype html>',
      '<img src="/Users/me/tmp/photo.png">',
      '<img src="https://cdn.example.com/photo.png">',
      '<img src="assets/missing.png">',
      '<link rel="stylesheet" href="missing.css">',
    ].join('\n'),
    'utf8',
  );
  const issues = await checkSelfContained(dir);
  assert.equal(issues.length, 4, JSON.stringify(issues));
  assert.ok(issues.some((issue) => /absolute|绝对/.test(issue.message)));
  assert.ok(issues.some((issue) => /remote|远程/.test(issue.message)));
  assert.ok(issues.some((issue) => /missing|不存在/.test(issue.message)));
});

test('delivery is refused when the acceptance decision is missing', async () => {
  const state = createState({ taskId: 'deliver-abc123', route: 'page' });
  const dir = await taskWithPreview('<html><body>ok</body></html>', state);
  await assert.rejects(() => deliverTask({ taskDir: dir, state }), DeliveryError);
});

test('delivery copies the page, acceptance evidence and a Chinese readme', async () => {
  const state = deliveredState();
  const dir = await taskWithPreview(
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="assets/site.css"></head><body><h1>真实内容</h1><button>开始</button></body></html>',
  );
  await writeFile(join(dir, '预览', 'assets', 'site.css'), 'body{font-family:system-ui}', 'utf8');
  await writeFile(join(dir, '预览', 'v0.html'), '<html><body>sample only</body></html>', 'utf8');
  const result = await deliverTask({ taskDir: dir, state });
  assert.equal(result.deliveryDir, '交付');
  assert.equal(await readFile(join(dir, '交付', 'index.html'), 'utf8'), await readFile(join(dir, '预览', 'index.html'), 'utf8'));
  assert.equal(await readFile(join(dir, '交付', 'assets', 'site.css'), 'utf8'), 'body{font-family:system-ui}');
  assert.equal(await readFile(join(dir, '交付', '验收', 'report.json'), 'utf8'), await readFile(join(dir, '验收', 'report.json'), 'utf8'));
  const readme = await readFile(join(dir, '交付', '说明.md'), 'utf8');
  assert.match(readme, /真实内容|editorial-swiss/);
  assert.match(readme, /index\.html/);
  await assert.rejects(() => readFile(join(dir, '交付', 'v0.html')), /ENOENT/);
});

test('self-contained check rejects remote CSS imports and absolute JS asset paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superweb-sc-'));
  await writeFile(join(dir, 'style.css'), '@import "https://fonts.example.com/site.css";', 'utf8');
  await writeFile(join(dir, 'site.js'), 'const logo = "/Users/me/logo.png";', 'utf8');
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><link rel="stylesheet" href="style.css"><script src="site.js"></script>',
    'utf8',
  );
  const issues = await checkSelfContained(dir);
  assert.ok(issues.some((issue) => issue.ref?.startsWith('https://fonts.example.com')));
  assert.ok(issues.some((issue) => issue.ref === '/Users/me/logo.png'));
});

test('self-contained check rejects relative references that escape the delivery root', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'superweb-sc-boundary-'));
  const root = join(parent, 'preview');
  await mkdir(root, { recursive: true });
  await writeFile(join(parent, 'outside.png'), 'outside', 'utf8');
  await writeFile(join(root, 'index.html'), '<img src="../outside.png">', 'utf8');
  const issues = await checkSelfContained(root);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /交付目录|目录外|不存在/);
});

test('self-contained check rejects symlinked delivery assets', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'superweb-sc-symlink-'));
  const root = join(parent, 'preview');
  await mkdir(root, { recursive: true });
  await writeFile(join(parent, 'outside.png'), 'outside', 'utf8');
  await symlink(join(parent, 'outside.png'), join(root, 'outside.png'));
  const issues = await checkSelfContained(root);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /符号链接/);
});

test('self-contained check reports malformed URL encoding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superweb-sc-uri-'));
  await writeFile(join(dir, 'index.html'), '<img src="assets/%E0%A4%A.png">', 'utf8');
  const issues = await checkSelfContained(dir);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /非法 URL 编码/);
});

test('delivery requires an acceptance report file', async () => {
  const state = deliveredState();
  const dir = await mkdtemp(join(tmpdir(), 'superweb-deliver-report-'));
  await mkdir(join(dir, '预览'), { recursive: true });
  await writeFile(join(dir, '预览', 'index.html'), '<html><body>ok</body></html>', 'utf8');
  await assert.rejects(() => deliverTask({ taskDir: dir, state }), /找不到验收报告/);
});

test('a new delivery archives the previous one instead of overwriting it', async () => {
  const dir = await taskWithPreview('<html><body>first version</body></html>');
  await deliverTask({ taskDir: dir, state: deliveredState() });
  await writeFile(join(dir, '预览', 'index.html'), '<html><body>second version</body></html>', 'utf8');
  const result = await deliverTask({ taskDir: dir, state: deliveredState() });
  assert.equal(result.archived, '交付-v1');
  assert.match(await readFile(join(dir, '交付-v1', 'index.html'), 'utf8'), /first version/);
  assert.match(await readFile(join(dir, '交付', 'index.html'), 'utf8'), /second version/);
});

test('acknowledged acceptance without a browser is labelled in the readme', async () => {
  const state = markInspected(
    (() => {
      let value = markDirectionsReady(createState({ taskId: 'deliver-abc123', route: 'page' }));
      value = applyDecision(value, {
        gate: 'direction',
        choice: 'editorial-swiss',
        revision: value.stageRevision,
        decisionId: 'd-direction',
      }).state;
      value = applyDecision(value, {
        gate: 'sample',
        choice: 'accept',
        revision: value.stageRevision,
        decisionId: 'd-sample',
      }).state;
      return value;
    })(),
    {
      passed: false,
      reportPath: '验收/report.json',
      screenshots: [],
      browserAvailable: false,
      issueCount: 1,
    },
  );
  const accepted = applyDecision(state, {
    gate: 'acceptance',
    choice: 'accept',
    revision: state.stageRevision,
    decisionId: 'd-accept',
    acknowledgeIssues: true,
  }).state;
  const dir = await taskWithPreview('<html><body>offline</body></html>', accepted);
  await deliverTask({ taskDir: dir, state: accepted });
  assert.match(await readFile(join(dir, '交付', '说明.md'), 'utf8'), /未完成浏览器验收/);
});
