import { expect, test } from 'bun:test';
import { creationLocale, creationText } from './i18n.ts';
import { flowStages, intakeFields } from './flows.ts';
import { confirmMessage, readWorkView } from './readers.ts';
import { EMPTY_ANSWERS, defaultTitle, workPathLabel } from './wizard.ts';
import plan from './fixtures/plan.json';
import prompts from './fixtures/sample-prompts.json';
import state from './fixtures/superppt.json';
import writer from './fixtures/superwriter.json';

test('each creation entry, intake and progress flow has English copy', () => {
  for (const kind of ['doc', 'deck', 'video', 'page'] as const) {
    expect(creationText('en', `kind.${kind}`)).not.toMatch(/\p{Script=Han}/u);
    expect(creationText('en', `hint.${kind}`)).not.toMatch(/\p{Script=Han}/u);
    expect(flowStages(kind, 'en').join(' ')).not.toMatch(/\p{Script=Han}/u);
    const fields = intakeFields(kind, 'en');
    for (const field of fields) {
      expect(field.label).not.toMatch(/\p{Script=Han}/u);
      expect(field.hint ?? '').not.toMatch(/\p{Script=Han}/u);
      expect(field.options?.map((option) => option.label).join(' ') ?? '').not.toMatch(/\p{Script=Han}/u);
    }
  }
  expect(creationText('zh-CN', 'kind.doc')).toBe('写文档');
  expect(creationLocale('en-US')).toBe('en');
  expect(creationLocale('zh-TW')).toBe('zh-CN');
});

test('translated choices retain their canonical values and existing folder contract', () => {
  const audience = intakeFields('doc', 'en').find((field) => field.id === 'audience');
  expect(audience?.options?.find((option) => option.value === '客户')?.label).toBe('Clients');
  expect(defaultTitle('deck', EMPTY_ANSWERS, 'en')).toBe('New presentation');
  expect(defaultTitle('doc', { ...EMPTY_ANSWERS, content: '用户原文' }, 'en')).toBe('用户原文');
  expect(workPathLabel('doc', 'My proposal', '2026-10-24')).toBe('文稿/SuperWagie/文档/My proposal 2026-10-24');
});

test('English reader chrome leaves generated titles, style names and document text unchanged', () => {
  const files = { state: JSON.stringify(state), plan: JSON.stringify(plan), prompts: JSON.stringify(prompts) };
  const en = readWorkView('deck', files, 'en');
  const zh = readWorkView('deck', files, 'zh-CN');
  expect(en?.gate?.title).toBe('Choose a style');
  expect(zh?.gate?.title).toBe('选风格');
  expect(en?.steps.map((step) => step.label)).toEqual(['Approach', 'Style', 'Sample', 'Full deck', 'Delivery']);
  expect(en?.gate?.choices).toEqual(zh?.gate?.choices);
  expect(en?.gate?.sections).toEqual(zh?.gate?.sections);
  const doc = readWorkView('doc', { state: JSON.stringify(writer), artifact: '# 用户创作的章节\n正文保持中文。' }, 'en');
  expect(doc?.gate?.title).toBe('Chapter 3 of 3');
  expect(doc?.gate?.body).toBe('# 用户创作的章节\n正文保持中文。');
});


test('English approvals keep exact revision, decision and command identities', () => {
  const page = readWorkView('page', {
    state: JSON.stringify({ version: 1, stage: 'acceptance', stageRevision: 7, acceptance: { passed: false, issueCount: 2 } }),
  }, 'en');
  if (!page?.gate) throw new Error('Acceptance gate missing');
  const message = confirmMessage('page', page.gate, { action: 'accept' }, 'en');
  expect(message).toContain('Accept the existing issues and deliver');
  expect(message).toContain('superweb decide --gate acceptance --choice accept --revision 7 --decision-id web-acceptance-7 --acknowledge-issues');
  expect(message).not.toMatch(/\p{Script=Han}/u);
  expect(page.gate.title).toBe('Browser checks');
  expect(page.gate.excerpt).toContain('2 issues found');
});
