export const KINDS = ['doc', 'deck', 'video', 'page'] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABEL = {
  doc: '写文档',
  deck: '做 PPT',
  video: '做视频',
  page: '做网页',
} satisfies Record<Kind, string>;

export const KIND_HINT = {
  doc: '标书、方案、报告、白皮书',
  deck: '汇报、路演、培训',
  video: '讲解片、绘本、教程',
  page: '落地页、作品集、小工具',
} satisfies Record<Kind, string>;

export const CATEGORY = { doc: '文档', deck: 'PPT', video: '视频', page: '网页' } satisfies Record<Kind, string>;

export type Answers = {
  content: string;
  audience: string;
  docType: string;
  length: string;
  occasion: string;
  pages: string;
  outcome: string;
  webGoal: string;
};

export const EMPTY_ANSWERS: Answers = {
  content: '',
  audience: '',
  docType: '方案',
  length: '中等，6 到 10 页',
  occasion: '',
  pages: '10 页左右',
  outcome: '',
  webGoal: '',
};

export const AUDIENCES = ['自己', '同事', '客户', '学生', '其他'] as const;
export const DOC_TYPES = ['标书', '方案', '报告', '白皮书', '其他'] as const;

/** Longer pastes belong in the chat; the transport rejects very large prompt bodies. */
export const CONTENT_LIMIT = 12_000;

export type ScreenID = 'content' | 'audience' | 'shape' | 'confirm';
export const SCREENS: readonly ScreenID[] = ['content', 'audience', 'shape', 'confirm'];

export const canAdvance = (kind: Kind, screen: ScreenID, answers: Answers): boolean => {
  if (screen === 'content') return answers.content.trim().length >= 2;
  if (screen === 'audience') return answers.audience.trim().length > 0;
  if (screen === 'shape') {
    if (kind === 'doc') return Boolean(answers.docType);
    if (kind === 'deck') return Boolean(answers.occasion.trim());
    if (kind === 'video') return Boolean(answers.outcome.trim());
    return Boolean(answers.webGoal.trim());
  }
  return true;
};

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

export const defaultTitle = (kind: Kind, answers: Answers): string => {
  const first = answers.content.trim().split('\n')[0] ?? '';
  const subject = first.replace(/^#+\s*/, '').slice(0, 24).trim();
  if (subject) return subject;
  return ({ doc: '新文档', deck: '新 PPT', video: '新视频', page: '新网页' } as const)[kind];
};

export const workFolder = (title: string, date = todayISO()): string => `${sanitizeTitle(title)} ${date}`;

export const workPathLabel = (kind: Kind, title: string, date = todayISO()): string =>
  `文稿/SuperWagie/${CATEGORY[kind]}/${workFolder(title, date)}`;

const thirdQuestionLines = (kind: Kind, answers: Answers): string[] => {
  if (kind === 'doc') return [`- 文档类型：${answers.docType}`, `- 篇幅：${answers.length}`];
  if (kind === 'deck') return [`- 场合：${answers.occasion}`, `- 页数：${answers.pages}`];
  if (kind === 'video') return [`- 看完能做到：${answers.outcome}`];
  return [`- 访客要完成：${answers.webGoal}`];
};

const contentForBrief = (content: string): string => {
  const trimmed = content.trim();
  if (trimmed.length <= CONTENT_LIMIT) return trimmed;
  return `${trimmed.slice(0, CONTENT_LIMIT)}\n\n（内容过长，已截断，其余请在对话里补充）`;
};

export const briefMarkdown = (kind: Kind, answers: Answers, title: string, date = todayISO()): string => {
  return [
    `# ${sanitizeTitle(title || defaultTitle(kind, answers))}`,
    '',
    `- 类型：${kind}`,
    `- 给谁看：${answers.audience}`,
    ...thirdQuestionLines(kind, answers),
    `- 创建时间：${date}`,
    '',
    '## 用户原话',
    '',
    contentForBrief(answers.content),
    '',
  ].join('\n');
};
