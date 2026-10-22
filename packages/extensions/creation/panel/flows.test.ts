import { describe, expect, test } from 'bun:test';

import { FLOW_STAGES, INTAKE, canStart } from './flows.ts';
import { EMPTY_ANSWERS, type Answers } from './wizard.ts';

const answers = (overrides: Partial<Answers> = {}): Answers => ({ ...EMPTY_ANSWERS, ...overrides });

describe('FLOW_STAGES', () => {
  test('each kind starts with its own intake and then follows the skill', () => {
    expect(FLOW_STAGES.doc).toEqual(['需求', '方案', '大纲', '章节', '配图', '合稿', '导出']);
    expect(FLOW_STAGES.deck).toEqual(['需求', '内容方案', '选款', '样页', '整套', '交付']);
    expect(FLOW_STAGES.video).toEqual(['需求', '简报', '讲稿', '样片', '成片', '交付']);
    expect(FLOW_STAGES.page).toEqual(['需求', '方向', '样页', '整页', '验收', '交付']);
  });
});

describe('INTAKE', () => {
  test('asks document-specific questions that other kinds never see', () => {
    const ids = INTAKE.doc.map((field) => field.id);
    expect(ids).toContain('docType');
    expect(ids).toContain('materials');
    expect(INTAKE.deck.map((field) => field.id)).not.toContain('docType');
  });

  test('every kind asks its own shape question', () => {
    expect(INTAKE.deck.map((field) => field.id)).toContain('occasion');
    expect(INTAKE.video.map((field) => field.id)).toContain('mode');
    expect(INTAKE.page.map((field) => field.id)).toContain('webGoal');
    expect(INTAKE.page.map((field) => field.id)).toContain('materials');
  });
});

describe('canStart', () => {
  test('needs the shared fields', () => {
    expect(canStart('doc', answers())).toBe(false);
    expect(canStart('doc', answers({ content: '技术方案', audience: '客户' }))).toBe(true);
  });

  test('needs the kind-specific answer', () => {
    const base = answers({ content: '季度汇报', audience: '同事' });
    expect(canStart('deck', base)).toBe(false);
    expect(canStart('deck', { ...base, occasion: '季度评审' })).toBe(true);
    expect(canStart('video', base)).toBe(false);
    expect(canStart('video', { ...base, outcome: '看懂三个卖点' })).toBe(true);
    expect(canStart('page', base)).toBe(false);
    expect(canStart('page', { ...base, webGoal: '预约试用' })).toBe(true);
  });
});
