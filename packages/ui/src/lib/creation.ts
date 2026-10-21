/** The first-party creation extension and the four entries the sidebar offers. */
export const CREATION_GUEST_ID = 'openchamber-builtin-creation';

export const CREATION_ENTRIES = [
  { kind: 'doc', label: '写文档', hint: '标书、方案、报告、白皮书', icon: 'file-text' },
  { kind: 'deck', label: '做 PPT', hint: '汇报、路演、培训', icon: 'file-image' },
  { kind: 'video', label: '做演示视频', hint: '讲解片、绘本、教程', icon: 'play' },
  { kind: 'page', label: '做网页', hint: '落地页、作品集、小工具', icon: 'window' },
] as const;

export type CreationIntent = (typeof CREATION_ENTRIES)[number]['kind'];

export const isCreationIntent = (value: unknown): value is CreationIntent =>
  CREATION_ENTRIES.some((entry) => entry.kind === value);
