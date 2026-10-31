import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_BLUEPRINT,
  PAGE_BLUEPRINT,
  assessBrief,
  detectRoute,
  directionsForRoute,
  parseOfferedDirectionIds,
  pickDirections,
  renderDirectionsDoc,
} from '../src/directions.js';
import { DIRECTIONS } from '../src/directions.js';
import { renderGuidedBuildContract, renderGuidedBuildDocument } from '../src/guided.js';

test('the library has 12 complete, route-compatible directions', () => {
  assert.equal(DIRECTIONS.length, 12);
  assert.equal(new Set(DIRECTIONS.map((direction) => direction.id)).size, 12);
  for (const direction of DIRECTIONS) {
    for (const field of ['id', 'nameZh', 'nameEn', 'concept', 'composition', 'type', 'palette', 'motion', 'bestFor', 'avoid'] as const) {
      assert.ok(direction[field].length > 0, `${direction.id}.${field} is empty`);
    }
    assert.ok(direction.routes.length > 0);
  }
  assert.ok(directionsForRoute('page').length >= 6);
  assert.ok(directionsForRoute('app').length >= 6);
  assert.ok(new Set(DIRECTIONS.map((direction) => direction.concept)).size === 12);
});

test('the same seed always extracts the same 3 directions', () => {
  const first = pickDirections('page', 'demo-seed').map((direction) => direction.id);
  const second = pickDirections('page', 'demo-seed').map((direction) => direction.id);
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  assert.equal(new Set(first).size, 3);
});

test('extraction respects the route and different seeds vary', () => {
  for (const route of ['page', 'app'] as const) {
    for (let index = 0; index < 12; index += 1) {
      const picked = pickDirections(route, `seed-${index}`);
      assert.equal(picked.length, 3);
      assert.equal(new Set(picked.map((direction) => direction.id)).size, 3);
      for (const direction of picked) assert.ok(direction.routes.includes(route));
    }
  }
  const page = pickDirections('page', 'seed-0').map((direction) => direction.id).join(',');
  const alternate = pickDirections('page', 'seed-7').map((direction) => direction.id).join(',');
  assert.notEqual(page, alternate);
});

test('short or empty briefs are refused', () => {
  assert.equal(assessBrief('').ok, false);
  assert.equal(assessBrief('   \n\n  ').ok, false);
  assert.equal(assessBrief('做一个网站').ok, false);
  assert.match(assessBrief('做一个网站').reason ?? '', /至少/);
  const good = assessBrief(
    '做一个面向独立开发者的产品落地页，需要首屏、核心功能、价格和常见问题。还没有 logo 和产品截图。',
  );
  assert.equal(good.ok, true);
});

test('route detection prefers app for work interfaces', () => {
  assert.equal(detectRoute('做一个 SaaS 管理后台，包含仪表盘、用户列表和设置页。'), 'app');
  assert.equal(detectRoute('Build an admin dashboard with tables and settings'), 'app');
  assert.equal(detectRoute('做一个摄影作品集落地页，展示系列照片。'), 'page');
  assert.equal(detectRoute('an event one-pager with speakers and tickets'), 'page');
  assert.equal(detectRoute('一些没有关键词的需求描述'), 'page');
});

test('rendered direction doc lists exactly the extracted ids and content structure', () => {
  const picked = pickDirections('app', 'doc-seed');
  const doc = renderDirectionsDoc({
    taskId: 'demo-abc123',
    route: 'app',
    seed: 'doc-seed',
    revision: 2,
    directions: picked,
    blueprint: APP_BLUEPRINT,
  });
  assert.match(doc, /doc-seed/);
  assert.match(doc, /应用外壳/);
  assert.match(doc, /superweb decide .*--gate direction/);
  const parsed = parseOfferedDirectionIds(doc);
  assert.deepEqual(parsed, picked.map((direction) => direction.id));
  assert.equal(parseOfferedDirectionIds('# 设计方向\n\n没有方向').length, 0);
  for (const section of PAGE_BLUEPRINT) {
    assert.ok(section.proves.length > 0);
  }
});

test('rendered direction doc keeps the guided contract in its dedicated artifact', () => {
  const doc = renderDirectionsDoc({
    taskId: 'guided-page',
    route: 'page',
    seed: 'guided-seed',
    revision: 2,
    directions: pickDirections('page', 'guided-seed'),
    blueprint: PAGE_BLUEPRINT,
  });

  assert.doesNotMatch(doc, /## 引导式构建输入/);
  assert.match(doc, /## 内容结构/);
});

test('guided contract contains the primary page build rules', () => {
  const doc = renderGuidedBuildContract({
    route: 'page',
    blueprint: PAGE_BLUEPRINT,
  });

  for (const heading of [
    '## 引导式构建输入',
    '## 页面输出顺序',
    '## 分段构建顺序',
    '## 视觉系统契约',
    '## 交互与交付检查',
  ]) {
    assert.match(doc, new RegExp(heading));
  }
  assert.match(doc, /页面大纲/);
  assert.match(doc, /Hero 文案/);
  assert.match(doc, /SEO \/ AEO/);
  assert.match(doc, /tagline reveal/);
  assert.match(doc, /prefers-reduced-motion/);
  assert.match(doc, /tagline reveal/);
});

test('app directions keep the guided contract while using the app build order', () => {
  const doc = renderGuidedBuildContract({
    route: 'app',
    blueprint: APP_BLUEPRINT,
  });

  assert.match(doc, /应用结构与任务路径/);
  assert.match(doc, /应用外壳/);
  assert.match(doc, /状态覆盖/);
  assert.match(doc, /hover、active、focus、loading、empty、error/);
  assert.doesNotMatch(doc, /页面输出顺序.*Hero 文案/s);
});

test('guided build document wraps the contract with one source note', () => {
  const doc = renderGuidedBuildDocument({ route: 'page', blueprint: PAGE_BLUEPRINT });
  assert.match(doc, /^# 设计引导/);
  assert.match(doc, /来源：SuperWeb 内置的统一引导规则/);
  assert.equal((doc.match(/来源：/g) ?? []).length, 1);
});
