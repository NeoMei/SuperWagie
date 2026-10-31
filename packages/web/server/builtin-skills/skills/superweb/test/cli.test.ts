import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';
import { findChrome } from '../src/inspect.js';

const here = dirname(fileURLToPath(import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(cwd: string, args: string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(args, {
    cwd,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

function json(result: CliResult): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function newDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'superweb-cli-'));
}

const APP_BRIEF =
  '做一个团队管理后台，包含仪表盘、用户列表、设置页和权限控制。需要展示每个成员的当前状态，并支持按部门筛选和批量邀请成员。';

test('start creates a task, detects the app route and immediately extracts directions', async () => {
  const dir = await newDir();
  const started = await cli(dir, ['start', '--name', '团队后台', '--brief', APP_BRIEF, '--json']);
  assert.equal(started.code, 0, started.stderr);
  const summary = json(started);
  assert.equal(summary.route, 'app');
  assert.equal(summary.stage, 'direction');
  assert.equal(summary.stageRevision, 2);
  assert.equal((summary.directions as Array<{ id: string }>).length, 3);

  assert.match(await readFile(join(dir, '需求.md'), 'utf8'), /团队管理后台/);
  assert.match(await readFile(join(dir, 'superweb.json'), 'utf8'), /"route": "app"/);
  assert.match(await readFile(join(dir, '设计方向.md'), 'utf8'), /## 内容结构/);
  assert.match(await readFile(join(dir, '设计引导.md'), 'utf8'), /## 引导式构建输入/);
  assert.match(await readFile(join(dir, 'superweb.json'), 'utf8'), /"guide": "设计引导\.md"/);

  const again = await cli(dir, ['start', '--name', '覆盖', '--brief', APP_BRIEF]);
  assert.equal(again.code, 3);
  assert.match(again.stderr, /不会覆盖/);
  assert.match(await readFile(join(dir, '需求.md'), 'utf8'), /团队管理后台/);
});

test('start keeps a thin brief at the brief stage and can override the route', async () => {
  const dir = await newDir();
  const started = await cli(dir, ['start', '--route', 'page', '--brief', APP_BRIEF, '--json']);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(json(started).route, 'page');
  assert.equal(json(started).stage, 'direction');

  const before = await readFile(join(dir, 'superweb.json'), 'utf8');
  const status = await cli(dir, ['status', '--json']);
  assert.equal(status.code, 0);
  assert.equal(json(status).stage, 'direction');
  assert.equal(await readFile(join(dir, 'superweb.json'), 'utf8'), before);

  const thin = await newDir();
  const thinStart = await cli(thin, ['start', '--name', '演示']);
  assert.equal(thinStart.code, 0);
  assert.equal(json(await cli(thin, ['status', '--json'])).stage, 'brief');
});


test('start adopts an existing brief for a creation task without overwriting it', async () => {
  const dir = await newDir();
  const brief = '# 需求：独立书店\n\n为一间独立书店做一个介绍页，包含本周活动、营业时间、到店路线和联系方式；受众是附近居民，暂时没有照片和 logo。\n';
  await writeFile(join(dir, '需求.md'), brief, 'utf8');

  const started = await cli(dir, ['start', '--name', '独立书店', '--adopt-brief', '--json']);
  assert.equal(started.code, 0, started.stderr);
  const summary = json(started);
  assert.equal(summary.route, 'page');
  assert.equal(summary.stage, 'direction');
  assert.equal((summary.directions as Array<{ id: string }>).length, 3);
  assert.equal(await readFile(join(dir, '需求.md'), 'utf8'), brief);

  const again = await cli(dir, ['start', '--name', 'again', '--adopt-brief']);
  assert.equal(again.code, 3);
  assert.match(again.stderr, /superweb\.json/);
});

test('start refuses an existing brief without --adopt-brief', async () => {
  const dir = await newDir();
  await writeFile(join(dir, '需求.md'), '# 需求\n\n已经有人写好的需求。\n', 'utf8');

  const started = await cli(dir, ['start', '--name', '书店']);
  assert.equal(started.code, 3);
  assert.match(started.stderr, /不会覆盖需求文件/);
  assert.match(await readFile(join(dir, '需求.md'), 'utf8'), /已经有人写好的需求/);
});

test('directions refuses a thin brief, then extracts the same three ids for the same seed', async () => {
  const dir = await newDir();
  await cli(dir, ['start', '--name', '演示']);

  const refused = await cli(dir, ['directions']);
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /需求还不够/);

  await writeFile(
    join(dir, '需求.md'),
    '# 需求\n\n做一个面向独立开发者的产品落地页，需要首屏、核心功能、价格和常见问题。还没有 logo 和产品截图。\n',
    'utf8',
  );
  const first = await cli(dir, ['directions', '--seed', 'cli-seed', '--json']);
  assert.equal(first.code, 0, first.stderr);
  const firstSummary = json(first);
  assert.equal(firstSummary.stage, 'direction');
  assert.equal(firstSummary.stageRevision, 2);
  const firstIds = (firstSummary.directions as Array<{ id: string }>).map((direction) => direction.id);
  assert.equal(firstIds.length, 3);
  assert.equal(new Set(firstIds).size, 3);

  const again = await cli(dir, ['directions', '--seed', 'cli-seed', '--json']);
  assert.equal(again.code, 0);
  const againSummary = json(again);
  assert.equal(againSummary.stageRevision, 3);
  assert.deepEqual(
    (againSummary.directions as Array<{ id: string }>).map((direction) => direction.id),
    firstIds,
  );
  assert.match(await readFile(join(dir, '设计方向.md'), 'utf8'), /## 内容结构/);
});

test('legacy direction tasks explain how to restore a missing guided contract', async () => {
  const dir = await newDir();
  await cli(dir, ['start', '--name', '演示']);
  await writeFile(
    join(dir, '需求.md'),
    '# 需求\n\n做一个面向独立开发者的产品落地页，需要首屏、功能说明、价格、常见问题和明确的下载行动。\n',
    'utf8',
  );
  await cli(dir, ['directions']);
  const state = JSON.parse(await readFile(join(dir, 'superweb.json'), 'utf8')) as Record<string, unknown>;
  const artifacts = { ...(state.artifacts as Record<string, unknown>) };
  delete artifacts.guide;
  await writeFile(join(dir, 'superweb.json'), `${JSON.stringify({ ...state, artifacts }, null, 2)}\n`, 'utf8');
  await unlink(join(dir, '设计引导.md'));

  const status = await cli(dir, ['status', '--json']);
  assert.equal(status.code, 0);
  const next = (json(status).next as Array<{ note?: string }>)[0]?.note ?? '';
  assert.match(next, /directions/);
  assert.match(next, /缺失|重建/);

  const directionDoc = await readFile(join(dir, '设计方向.md'), 'utf8');
  const directionId = /^##\s+\d+\.\s+([a-z0-9-]+)\s+—/m.exec(directionDoc)?.[1];
  assert.ok(directionId);
  const decided = await cli(dir, ['decide', '--gate', 'direction', '--choice', directionId!, '--decision-id', 'd-legacy']);
  assert.equal(decided.code, 0);
  await unlink(join(dir, '设计引导.md'));
  const replay = await cli(dir, [
    'decide', '--gate', 'direction', '--choice', directionId!, '--revision', '2', '--decision-id', 'd-legacy', '--json',
  ]);
  assert.equal(replay.code, 0);
  assert.equal(json(replay).idempotent, true);
  assert.match(await readFile(join(dir, '设计引导.md'), 'utf8'), new RegExp(directionId!));
});

test('decide rejects flags that do not apply to the selected gate', async () => {
  const dir = await newDir();
  const started = await cli(dir, ['start', '--name', '演示', '--brief', APP_BRIEF, '--json']);
  const directionId = (json(started).directions as Array<{ id: string }>)[0]!.id;
  const wrongTarget = await cli(dir, [
    'decide', '--gate', 'direction', '--choice', directionId, '--target', 'sample',
  ]);
  assert.equal(wrongTarget.code, 2);
  assert.match(wrongTarget.stderr, /--target/);

  const accepted = await cli(dir, ['decide', '--gate', 'direction', '--choice', directionId]);
  assert.equal(accepted.code, 0);
  const wrongAcknowledgement = await cli(dir, [
    'decide', '--gate', 'sample', '--choice', 'accept', '--acknowledge-issues',
  ]);
  assert.equal(wrongAcknowledgement.code, 2);
  assert.match(wrongAcknowledgement.stderr, /--acknowledge-issues/);
});

test('decide rejects stale revisions, unknown directions and skipped stages', async () => {
  const dir = await newDir();
  const started = await cli(dir, [
    'start', '--name', '演示', '--brief',
    '做一个摄影作品集落地页，展示三个系列、关于页面和联系方式。素材是本地照片，暂时没有 logo。', '--json',
  ]);
  assert.equal(started.code, 0, started.stderr);
  const offered = (json(started).directions as Array<{ id: string }>).map((direction) => direction.id);

  const stale = await cli(dir, [
    'decide', '--gate', 'direction', '--choice', offered[0]!, '--revision', '1', '--decision-id', 'd-stale',
  ]);
  assert.equal(stale.code, 3);
  assert.match(stale.stderr, /stageRevision 已过期/);

  const unknown = await cli(dir, [
    'decide', '--gate', 'direction', '--choice', 'not-a-direction', '--revision', '2', '--decision-id', 'd-unknown',
  ]);
  assert.equal(unknown.code, 3);
  assert.match(unknown.stderr, /不在当前 3 个方向中/);

  const skipped = await cli(dir, [
    'decide', '--gate', 'sample', '--choice', 'accept', '--revision', '2', '--decision-id', 'd-skip',
  ]);
  assert.equal(skipped.code, 3);
});

test('full page lifecycle requires only three confirmations and auto-delivers', {
  skip: findChrome().available ? false : 'Chrome not installed',
}, async () => {
  const dir = await newDir();
  const started = await cli(dir, [
    'start', '--name', '书店', '--brief',
    '为一间独立书店做一个介绍页，包含本周活动、营业时间和到店路线。使用真实文字，暂时没有照片，用明确占位符。', '--json',
  ]);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(json(started).stage, 'direction');
  const directionId = (json(started).directions as Array<{ id: string }>)[0]!.id;

  const accepted = await cli(dir, ['decide', '--gate', 'direction', '--choice', directionId, '--json']);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(json(accepted).stage, 'sample');
  assert.equal(json(accepted).stageRevision, 3);
  const directionDecision = json(accepted).decisionId as string;
  assert.ok(directionDecision.length > 0);
  assert.match(await readFile(join(dir, '设计引导.md'), 'utf8'), new RegExp(directionId));
  assert.equal(json(await cli(dir, ['status', '--json'])).stage, 'sample');

  const replay = await cli(dir, [
    'decide', '--gate', 'direction', '--choice', directionId,
    '--revision', '2', '--decision-id', directionDecision, '--json',
  ]);
  assert.equal(replay.code, 0);
  assert.equal(json(replay).idempotent, true);
  assert.equal(json(replay).stageRevision, 3);

  const noSample = await cli(dir, ['decide', '--gate', 'sample', '--choice', 'accept']);
  assert.equal(noSample.code, 3);
  assert.match(noSample.stderr, /预览\/v0\.html/);

  const fixture = await readFile(join(here, 'fixtures', 'pages', 'good.html'), 'utf8');
  await writeFile(join(dir, '预览', 'v0.html'), fixture, 'utf8');
  const sample = await cli(dir, ['decide', '--gate', 'sample', '--choice', 'accept']);
  assert.equal(sample.code, 0, sample.stderr);

  const earlyDelivery = await cli(dir, ['deliver']);
  assert.equal(earlyDelivery.code, 1);
  assert.match(earlyDelivery.stderr, /只有 delivered 阶段/);

  await cp(join(dir, '预览', 'v0.html'), join(dir, '预览', 'index.html'));
  const inspected = await cli(dir, ['inspect', '--json']);
  assert.equal(inspected.code, 0, inspected.stderr);
  const report = json(inspected);
  assert.equal(report.passed, true);
  assert.equal(report.stage, 'acceptance');
  for (const screenshot of report.screenshots as string[]) {
    assert.ok((await stat(join(dir, screenshot))).size > 100);
  }

  const previewPath = join(dir, '预览', 'index.html');
  const previewBeforeAcceptance = await readFile(previewPath, 'utf8');
  await writeFile(previewPath, `${previewBeforeAcceptance}\n<!-- changed after inspect -->`, 'utf8');
  const staleAcceptance = await cli(dir, [
    'decide', '--gate', 'acceptance', '--choice', 'accept', '--decision-id', 'd-stale-acceptance',
  ]);
  assert.equal(staleAcceptance.code, 3);
  assert.match(staleAcceptance.stderr, /验收报告已过期|重新 inspect/);
  await writeFile(previewPath, previewBeforeAcceptance, 'utf8');

  const acceptedPage = await cli(dir, ['decide', '--gate', 'acceptance', '--choice', 'accept', '--json']);
  assert.equal(acceptedPage.code, 0, acceptedPage.stderr);
  const acceptedSummary = json(acceptedPage);
  assert.equal(acceptedSummary.stage, 'delivered');
  assert.equal(acceptedSummary.stageRevision, 6);
  assert.equal((acceptedSummary.delivery as Record<string, unknown>).ok, true);
  assert.equal((acceptedSummary.delivery as Record<string, unknown>).fileCount, 6);

  const readme = await readFile(join(dir, '交付', '说明.md'), 'utf8');
  assert.match(readme, /direct|index\.html|双击/);
  assert.ok((await readFile(join(dir, '交付', 'index.html'))).byteLength > 100);
  assert.ok((await readFile(join(dir, '交付', '验收', 'report.json'))).byteLength > 10);

  const finalStatus = json(await cli(dir, ['status', '--json']));
  assert.equal(finalStatus.stage, 'delivered');
  assert.equal((finalStatus.artifacts as Record<string, string>).delivery, '交付');
});

test('auto-delivery reports a self-contained failure but keeps the acceptance decision', {
  skip: findChrome().available ? false : 'Chrome not installed',
}, async () => {
  const dir = await newDir();
  const started = await cli(dir, [
    'start', '--name', '坏素材', '--brief',
    '做一个产品介绍单页，说明一个本地工具的功能和使用方式，需要首屏、功能说明和下载按钮。页面需要真实文案和明确的本地占位图。', '--json',
  ]);
  const directionId = (json(started).directions as Array<{ id: string }>)[0]!.id;
  await cli(dir, ['decide', '--gate', 'direction', '--choice', directionId]);

  const page = [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>img{max-width:100%}</style></head><body><h1>本地工具</h1><button>下载</button>',
    '<img src="/Users/me/missing.png" alt="绝对路径图片"></body></html>',
  ].join('');
  await writeFile(join(dir, '预览', 'v0.html'), page, 'utf8');
  await cli(dir, ['decide', '--gate', 'sample', '--choice', 'accept']);
  await cp(join(dir, '预览', 'v0.html'), join(dir, '预览', 'index.html'));

  const inspected = await cli(dir, ['inspect', '--json']);
  assert.equal(inspected.code, 1);
  assert.equal(json(inspected).passed, false);

  const accepted = await cli(dir, ['decide', '--gate', 'acceptance', '--choice', 'accept', '--acknowledge-issues', '--json']);
  assert.equal(accepted.code, 1);
  const summary = json(accepted);
  assert.equal(summary.stage, 'delivered');
  assert.equal((summary.delivery as Record<string, unknown>).ok, false);
  await assert.rejects(() => stat(join(dir, '交付')), /ENOENT/);

  const status = json(await cli(dir, ['status', '--json']));
  assert.equal(status.stage, 'delivered');
  assert.equal((status.artifacts as Record<string, string>).delivery, undefined);
});

test('corrupt state is reported without being reset', async () => {
  const dir = await newDir();
  await cli(dir, ['start', '--name', '坏状态']);
  await writeFile(join(dir, 'superweb.json'), '{"version": 1,', 'utf8');
  const status = await cli(dir, ['status', '--json']);
  assert.equal(status.code, 3);
  assert.match(status.stdout, /不是合法 JSON/);
  assert.equal(await readFile(join(dir, 'superweb.json'), 'utf8'), '{"version": 1,');
});

test('usage errors and help are explicit', async () => {
  const dir = await newDir();
  assert.equal((await cli(dir, ['start', '--bogus', 'x'])).code, 2);
  assert.equal((await cli(dir, ['wat'])).code, 2);
  const help = await cli(dir, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /superweb <命令>/);
  const version = await cli(dir, ['--version']);
  assert.match(version.stdout, /^superweb \d+\.\d+\.\d+/);
});
