import { creationLocale, creationText, type CreationMessageKey } from './i18n.ts';
export const KINDS = ['doc', 'deck', 'video', 'page'] as const;
export type Kind = (typeof KINDS)[number];

export const CATEGORY = { doc: '文档', deck: 'PPT', video: '视频', page: '网页' } satisfies Record<Kind, string>;

export type Answers = {
  content: string;
  audience: string;
  docType: string;
  length: string;
  materials: string;
  occasion: string;
  pages: string;
  outcome: string;
  mode: string;
  webGoal: string;
  references: string;
};

export const EMPTY_ANSWERS: Answers = {
  content: '',
  audience: '',
  docType: '方案',
  length: '中等，6 到 10 页',
  materials: '',
  occasion: '',
  pages: '10 页左右',
  outcome: '',
  mode: '讲解片',
  webGoal: '',
  references: '',
};

/** Longer pastes belong in the chat; the transport rejects very large prompt bodies. */
export const CONTENT_LIMIT = 12_000;

export const sanitizeTitle = (value: string): string => {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 40)
    .trim();
  return cleaned || '未命名';
};

export const todayISO = (date = new Date()): string => {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

export const defaultTitle = (kind: Kind, answers: Answers, locale = 'zh-CN'): string => {
  const first = answers.content.trim().split('\n')[0] ?? '';
  const subject = first.replace(/^#+\s*/, '').slice(0, 24).trim();
  if (subject) return subject;
  return creationText(locale, `title.${kind}`);
};

export const workFolder = (title: string, date = todayISO()): string => `${sanitizeTitle(title)} ${date}`;

export const workPathLabel = (kind: Kind, title: string, date = todayISO()): string =>
  `文稿/SuperWagie/${CATEGORY[kind]}/${workFolder(title, date)}`;

const choiceText = (value: string, locale: string): string => {
  if (creationLocale(locale) !== 'en') return value;
  const labels = new Map<string, CreationMessageKey>([
    ['自己', 'option.self'], ['同事', 'option.colleagues'], ['客户', 'option.clients'], ['学生', 'option.students'], ['其他', 'option.other'],
    ['标书', 'option.bid'], ['方案', 'option.proposal'], ['报告', 'option.report'], ['白皮书', 'option.whitepaper'],
    ['讲解片', 'option.explainer'], ['绘本', 'option.storybook'], ['教程', 'option.tutorial'],
  ]);
  const key = labels.get(value);
  return key ? creationText(locale, key) : value;
};

const thirdQuestionLines = (kind: Kind, answers: Answers, locale: string): string[] => {
  const t = (key: CreationMessageKey, params?: { [name: string]: string | number }) => creationText(locale, key, params);
  if (kind === 'doc') {
    return [
      t('brief.docType', { value: choiceText(answers.docType, locale) }),
      t('brief.length', { value: answers.length }),
      ...(answers.materials.trim() ? [t('brief.materials'), answers.materials.trim()] : []),
    ];
  }
  if (kind === 'deck') return [t('brief.occasion', { value: answers.occasion }), t('brief.pages', { value: answers.pages })];
  if (kind === 'video') return [t('brief.outcome', { value: answers.outcome }), t('brief.mode', { value: choiceText(answers.mode, locale) })];
  return [t('brief.webGoal', { value: answers.webGoal }), ...(answers.references.trim() ? [t('brief.references', { value: answers.references.trim() })] : [])];
};

const contentForBrief = (content: string, locale: string): string => {
  const trimmed = content.trim();
  if (trimmed.length <= CONTENT_LIMIT) return trimmed;
  return `${trimmed.slice(0, CONTENT_LIMIT)}\n\n${creationText(locale, 'brief.truncated')}`;
};

export const briefMarkdown = (kind: Kind, answers: Answers, title: string, date = todayISO(), locale = 'zh-CN'): string => {
  const t = (key: CreationMessageKey, params?: { [name: string]: string | number }) => creationText(locale, key, params);
  return [
    `# ${sanitizeTitle(title || defaultTitle(kind, answers, locale))}`,
    '',
    t('brief.kind', { kind }),
    t('brief.audience', { audience: choiceText(answers.audience, locale) }),
    ...thirdQuestionLines(kind, answers, locale),
    t('brief.created', { date }),
    '',
    t('brief.userWords'),
    '',
    contentForBrief(answers.content, locale),
    '',
  ].join('\n');
};
