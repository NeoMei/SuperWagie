import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  buildDocumentIndex,
  extractExcalidrawScene,
  renderMarkdown,
  resolveWorkspaceReference,
  resolveWikiTarget,
} from '../src/markdown-model.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const fixtureRoot = resolve(repoRoot, 'fixtures/gate-1/G1-MARKDOWN-001/fixtures');
const torture = readFileSync(resolve(fixtureRoot, 'torture.md'), 'utf8');
const drawing = readFileSync(resolve(fixtureRoot, '系统架构.excalidraw.md'), 'utf8');

test('resolves Obsidian wikilinks without collapsing aliases or anchors', () => {
  assert.deepEqual(resolveWikiTarget('核心内容|显示名'), {
    path: '核心内容.md',
    heading: null,
    block: null,
    label: '显示名',
  });
  assert.deepEqual(resolveWikiTarget('核心内容#小节'), {
    path: '核心内容.md',
    heading: '小节',
    block: null,
    label: '核心内容#小节',
  });
  assert.deepEqual(resolveWikiTarget('核心内容#^block-anchor'), {
    path: '核心内容.md',
    heading: null,
    block: 'block-anchor',
    label: '核心内容#^block-anchor',
  });
});

test('resolves local attachments beside a nested document and keeps vault-root links stable', () => {
  const current = 'SuperWagie验收/G1-MARKDOWN-001/run-1/torture-edited.md';
  assert.equal(resolveWorkspaceReference(current, '图片素材.png'), 'SuperWagie验收/G1-MARKDOWN-001/run-1/图片素材.png');
  assert.equal(resolveWorkspaceReference(current, './系统架构.excalidraw.md'), 'SuperWagie验收/G1-MARKDOWN-001/run-1/系统架构.excalidraw.md');
  assert.equal(resolveWorkspaceReference(current, 'SuperWagie验收/G1-MARKDOWN-001/run-1/核心内容.md'), 'SuperWagie验收/G1-MARKDOWN-001/run-1/核心内容.md');
});

test('indexes links, embeds, headings, tasks, tags and properties from source', () => {
  const index = buildDocumentIndex(torture);
  assert.equal(index.properties.custom_plugin_field, 'keep-me');
  assert.equal(index.headings.length, 7);
  assert.equal(index.wikilinks.length, 5);
  assert.equal(index.embeds.length, 3);
  assert.equal(index.tasks.length, 4);
  assert.ok(index.tags.includes('g1/子标签'));
});

test('extracts the native Excalidraw scene while preserving the markdown container', () => {
  const parsed = extractExcalidrawScene(drawing);
  assert.equal(parsed.scene.type, 'excalidraw');
  assert.ok(parsed.scene.elements.some((element) => element.text === 'Agent 引导加工'));
  assert.equal(parsed.source, drawing);
});

test('renders Obsidian dialect content with working document, image and drawing embeds', async () => {
  const files = new Map([
    ['核心内容.md', '# 核心内容\n\n## 小节\n\n嵌入正文。\n\n块目标。 ^block-anchor\n'],
    ['系统架构.excalidraw.md', drawing],
  ]);
  const rendered = await renderMarkdown(torture, {
    readText: async (path) => files.get(path) ?? null,
    assetUrl: (path) => `superwagie-asset://${encodeURIComponent(path)}`,
  });
  assert.match(rendered, /data-wikilink="核心内容.md"/);
  assert.match(rendered, /class="sw-embed sw-document-embed"/);
  assert.match(rendered, /superwagie-asset:\/\/%E5%9B%BE%E7%89%87%E7%B4%A0%E6%9D%90.png/);
  assert.match(rendered, /class="sw-excalidraw-embed"/);
  assert.match(rendered, /Agent 引导加工/);
  assert.match(rendered, /class="sw-callout sw-callout-note"/);
  assert.match(rendered, /class="katex"/);
  assert.match(rendered, /language-unknown-plugin/);
  assert.match(rendered, /custom_plugin_field/);
});
