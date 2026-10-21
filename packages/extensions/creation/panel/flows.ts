import {
  AUDIENCES,
  DOC_TYPES,
  type Answers,
  type Kind,
} from './wizard.ts';

/** The whole skill, in the order the guide walks it. The first stage is intake. */
export const FLOW_STAGES = {
  doc: ['需求', '方案', '大纲', '章节', '配图', '合稿', '导出'],
  deck: ['需求', '内容方案', '选款', '样页', '整套', '交付'],
  video: ['需求', '简报', '讲稿', '样片', '成片', '交付'],
  page: ['需求', '生成', '预览', '交付'],
} satisfies Record<Kind, readonly string[]>;

export type IntakeFieldID =
  | 'content'
  | 'audience'
  | 'docType'
  | 'length'
  | 'materials'
  | 'occasion'
  | 'pages'
  | 'outcome'
  | 'mode'
  | 'webGoal'
  | 'references';

export type IntakeField = {
  id: IntakeFieldID;
  label: string;
  hint?: string;
  kind: 'text' | 'long' | 'choice';
  options?: readonly string[];
  optional?: boolean;
};

const base = (kind: IntakeField['kind'], id: IntakeFieldID, label: string, hint?: string): IntakeField => {
  const field: IntakeField = { id, label, kind };
  if (hint) field.hint = hint;
  return field;
};

/** What this kind must know before its first skill stage can start. */
export const INTAKE = {
  doc: [
    base('long', 'content', '这份文件要写什么？', '可以贴原文、给一个文件路径，或只写一句主题。'),
    { ...base('choice', 'docType', '文档类型'), options: DOC_TYPES },
    base('long', 'materials', '有没有招标文件、评分表或参考资料？', '没有就留空；有就贴要点或写文件路径。'),
    { ...base('choice', 'audience', '给谁看'), options: AUDIENCES },
    base('text', 'length', '大概篇幅', '例如：中等，6 到 10 页。'),
  ],
  deck: [
    base('long', 'content', '这次要讲什么？', '可以贴原文、给一个文件路径，或只写一句主题。'),
    { ...base('choice', 'audience', '给谁看'), options: AUDIENCES },
    base('text', 'occasion', '用在哪里？', '例如：季度评审、客户路演。'),
    base('text', 'pages', '大概几页？', '例如：10 页左右。'),
  ],
  video: [
    base('long', 'content', '这条片子要讲什么？', '可以贴资料、给一个文件路径，或只写一句主题。'),
    { ...base('choice', 'audience', '给谁看'), options: AUDIENCES },
    base('long', 'outcome', '看完之后，观众应该能做什么或说出什么？'),
    { ...base('choice', 'mode', '做成哪种？'), options: ['讲解片', '绘本', '教程', '其他'] },
  ],
  page: [
    base('long', 'content', '页面上放什么？', '可以贴文案、给参考链接或文件路径。'),
    { ...base('choice', 'audience', '给谁看'), options: AUDIENCES },
    base('long', 'webGoal', '访客在页面上要完成什么？', '例如：预约试用、下载资料。'),
    base('text', 'references', '有没有想参考的站点？', '没有就留空。'),
  ],
} satisfies Record<Kind, readonly IntakeField[]>;

const filled = (value: string): boolean => value.trim().length >= 2;

/** Everything required for this kind's intake is present. */
export const canStart = (kind: Kind, answers: Answers): boolean => {
  if (!filled(answers.content) || !answers.audience.trim()) return false;
  if (kind === 'doc') return Boolean(answers.docType);
  if (kind === 'deck') return filled(answers.occasion);
  if (kind === 'video') return filled(answers.outcome) && Boolean(answers.mode);
  return filled(answers.webGoal);
};
