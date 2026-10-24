import { describe, expect, test } from 'bun:test';

import {
  CONTENT_LIMIT,
  EMPTY_ANSWERS,
  briefMarkdown,
  defaultTitle,
  sanitizeTitle,
  todayISO,
  workFolder,
  workPathLabel,
  type Answers,
} from './wizard.ts';

const answers = (overrides: Partial<Answers> = {}): Answers => ({ ...EMPTY_ANSWERS, ...overrides });

describe('sanitizeTitle', () => {
  test('replaces path and shell punctuation', () => {
    expect(sanitizeTitle('2026/季度:汇报*草稿?')).toBe('2026-季度-汇报-草稿-');
  });
  test('collapses whitespace and trims', () => {
    expect(sanitizeTitle('  季度   汇报  ')).toBe('季度 汇报');
  });
  test('drops leading dots and caps at 40 characters', () => {
    expect(sanitizeTitle('..hidden')).toBe('hidden');
    expect(sanitizeTitle('长'.repeat(60))).toHaveLength(40);
  });
  test('falls back to a placeholder instead of an empty name', () => {
    expect(sanitizeTitle('   ')).toBe('未命名');
  });
});

describe('workFolder', () => {
  test('puts the date after the title', () => {
    expect(workFolder('季度汇报', '2026-10-21')).toBe('季度汇报 2026-10-21');
  });
  test('labels the folder under its category', () => {
    expect(workPathLabel('deck', '季度汇报', '2026-10-21')).toBe('文稿/SuperWagie/PPT/季度汇报 2026-10-21');
  });
});

describe('todayISO', () => {
  test('pads month and day', () => {
    expect(todayISO(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('defaultTitle', () => {
  test('uses the first line of the content', () => {
    expect(defaultTitle('doc', answers({ content: '关于接口开放的技术方案\n第二行' }))).toBe('关于接口开放的技术方案');
  });
  test('falls back per kind', () => {
    expect(defaultTitle('video', answers())).toBe('新视频');
  });
});

describe('briefMarkdown', () => {
  test('records the kind in a line the panel can read back', () => {
    const brief = briefMarkdown('deck', answers({ content: '季度汇报', audience: '客户', occasion: '季度评审', pages: '12 页' }), '季度汇报', '2026-10-21');
    expect(brief.startsWith('# 季度汇报\n')).toBe(true);
    expect(brief).toContain('- 类型：deck');
    expect(brief).toContain('- 给谁看：客户');
    expect(brief).toContain('- 场合：季度评审');
    expect(brief).toContain('- 创建时间：2026-10-21');
  });

  test('uses the typed title so the heading matches the folder and session', () => {
    const brief = briefMarkdown('doc', answers({ content: '技术方案\n第二行', audience: '客户' }), '接口开放 方案', '2026-10-21');
    expect(brief.startsWith('# 接口开放 方案\n')).toBe(true);
  });

  test('truncates a long paste and points the rest to the chat', () => {
    const brief = briefMarkdown('doc', answers({ content: '甲'.repeat(CONTENT_LIMIT + 5), audience: '客户' }), '长文', '2026-10-21');
    expect(brief).toContain('甲'.repeat(CONTENT_LIMIT) + '\n\n（内容过长，已截断，其余请在对话里补充）');
    expect(brief).not.toContain('甲'.repeat(CONTENT_LIMIT + 1));
  });
});


test('English briefs use a recognized English kind marker and preserve the user content', () => {
  const brief = briefMarkdown('deck', answers({ content: '用户原文', audience: '客户', occasion: 'Client review', pages: 'About 10 slides' }), 'Review deck', '2026-10-24', 'en');
  expect(brief).toContain('- Type: deck');
  expect(brief).toContain('- Audience: Clients');
  expect(brief).toContain('- Slides: About 10 slides');
  expect(brief).toContain('## User requirements\n\n用户原文');
});
