import type { IconName } from '@/components/icon/icons';

/** The first-party creation extension and the four entries the sidebar offers. */
export const CREATION_GUEST_ID = 'openchamber-builtin-creation';

/** The work link stored on a creation session; clicking it opens the work's files. */
export const CREATION_WORK_URL_PREFIX = 'https://superwagie.local/work/';

const CREATION_ENTRIES = [
  { kind: 'doc', label: '写文档', hint: '标书、方案、报告、白皮书', icon: 'file-text' },
  { kind: 'deck', label: '做 PPT', hint: '汇报、路演、培训', icon: 'file-image' },
  { kind: 'video', label: '做演示视频', hint: '讲解片、绘本、教程', icon: 'play' },
  { kind: 'page', label: '做网页', hint: '落地页、作品集、小工具', icon: 'window' },
] as const;

export type CreationIntent = (typeof CREATION_ENTRIES)[number]['kind'];

export const isCreationIntent = (value: unknown): value is CreationIntent =>
  CREATION_ENTRIES.some((entry) => entry.kind === value);

/** The five top-level groups the session sidebar shows, in order. */
export type WorkCategory = 'chat' | CreationIntent;

/** The headers the list draws, including the general project block at the bottom. */
export type WorkCategoryHeaderKey = WorkCategory | 'projects';

export const WORK_CATEGORIES: readonly WorkCategory[] = ['chat', 'doc', 'deck', 'video', 'page'];

export const WORK_CATEGORY_LABEL: Record<WorkCategoryHeaderKey, string> = {
  chat: '聊天',
  doc: '写文档',
  deck: '做 PPT',
  video: '做演示视频',
  page: '做网页',
  projects: '项目',
};

export const WORK_CATEGORY_ICON: Record<WorkCategoryHeaderKey, IconName> = {
  chat: 'chat-4',
  doc: 'file-text',
  deck: 'file-image',
  video: 'play',
  page: 'window',
  projects: 'folder',
};

const CATEGORY_FOLDER: Record<Exclude<WorkCategory, 'chat'>, string> = {
  doc: '文档',
  deck: 'PPT',
  video: '视频',
  page: '网页',
};

/**
 * A work's category is its folder under the fixed creation root. Projects
 * anywhere else are the general chat bucket, so no extra metadata can drift
 * from where the files actually live.
 */
export const categoryOfProjectPath = (projectPath: string): WorkCategory => {
  const normalized = projectPath.replace(/\\/g, '/');
  for (const category of ['doc', 'deck', 'video', 'page'] as const) {
    if (normalized.includes(`/Documents/SuperWagie/${CATEGORY_FOLDER[category]}/`)) return category;
  }
  return 'chat';
};
