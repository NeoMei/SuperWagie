import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';

/** The first-party creation extension and the four entries the sidebar offers. */
export const CREATION_GUEST_ID = 'openchamber-builtin-creation';

/** The work link stored on a creation session; clicking it opens the work's files. */
export const CREATION_WORK_URL_PREFIX = 'https://superwagie.local/work/';

const CREATION_INTENTS = ['doc', 'deck', 'video', 'page'] as const;

export type CreationIntent = (typeof CREATION_INTENTS)[number];

export const isCreationIntent = (value: unknown): value is CreationIntent =>
  CREATION_INTENTS.some((intent) => intent === value);

/** The five top-level groups the session sidebar shows, in order. */
export type WorkCategory = 'chat' | CreationIntent;

/** The headers the list draws, including the general project block at the bottom. */
export type WorkCategoryHeaderKey = WorkCategory | 'projects';

export const WORK_CATEGORIES: readonly WorkCategory[] = ['chat', 'doc', 'deck', 'video', 'page'];

export const WORK_CATEGORY_LABEL_KEY = {
  chat: 'creation.category.chat',
  doc: 'creation.category.doc',
  deck: 'creation.category.deck',
  video: 'creation.category.video',
  page: 'creation.category.page',
  projects: 'creation.category.projects',
} satisfies Record<WorkCategoryHeaderKey, I18nKey>;

export const CREATION_NEW_LABEL_KEY = {
  chat: 'creation.new.chat',
  doc: 'creation.new.doc',
  deck: 'creation.new.deck',
  video: 'creation.new.video',
  page: 'creation.new.page',
} satisfies Record<WorkCategory, I18nKey>;

export const CREATION_TITLE_KEY = {
  doc: 'creation.title.doc',
  deck: 'creation.title.deck',
  video: 'creation.title.video',
  page: 'creation.title.page',
} satisfies Record<CreationIntent, I18nKey>;

export const CREATION_PROMPT_KEY = {
  doc: 'creation.prompt.doc',
  deck: 'creation.prompt.deck',
  video: 'creation.prompt.video',
  page: 'creation.prompt.page',
} satisfies Record<CreationIntent, I18nKey>;

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
