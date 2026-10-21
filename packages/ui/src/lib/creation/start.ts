import { toast } from 'sonner';

import type { CreationIntent } from '@/lib/creation';
import { startGuestSession } from '@/lib/guests/start-session';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

const TITLE = {
  doc: '新文档',
  deck: '新 PPT',
  video: '新视频',
  page: '新网页',
} satisfies Record<CreationIntent, string>;

const FIRST_MESSAGE = {
  doc: '我想写一份文档。请先调用 skill 工具加载 superwriter 技能，再读取本项目的 需求.md，按 SuperWriter 的流程一步一步带我完成：需求、方案、大纲、逐章、配图、合稿、导出。每次只问我一个问题，从第一个问题开始。',
  deck: '我想做一份 PPT。请先调用 skill 工具加载 superppt 技能，再读取本项目的 需求.md，按 SuperPPT 的流程一步一步带我完成：需求、内容方案、选款、样页、整套、交付。每次只问我一个问题，从第一个问题开始。',
  video: '我想做一条演示视频。请先调用 skill 工具加载 supervideo 技能，再读取本项目的 需求.md，按 SuperVideo 的流程一步一步带我完成：需求、简报、讲稿、样片、成片、交付。每次只问我一个问题，从第一个问题开始。',
  page: '我想做一个网页。请读取本项目的 需求.md，一步一步问我目标和素材，然后实现；每次只问我一个问题。',
} satisfies Record<CreationIntent, string>;

const today = (): string => {
  const date = new Date();
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
};

const briefFor = (kind: CreationIntent): string => [
  `# ${TITLE[kind]}`,
  '',
  `- 类型：${kind}`,
  `- 创建时间：${today()}`,
  '',
  '## 用户原话',
  '',
  '（用户还没有提供内容，请在对话里一步一步询问。）',
  '',
].join('\n');

/**
 * A creation entry starts the skill in a fresh work folder and lands in the
 * chat. The whole task is then the skill's own question-by-question flow; no
 * guide page stands between the user and the assistant.
 */
export const startCreationChat = async (kind: CreationIntent): Promise<void> => {
  const title = TITLE[kind];
  toast.loading('正在建项目和会话…', { id: 'creation-start' });
  try {
    const response = await runtimeFetch('/api/creation/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, title, brief: briefFor(kind) }),
    });
    if (!response.ok) throw new Error('建项目失败');
    // SAFETY: the creation route returns this small envelope; a missing id is
    // checked on the next line and treated as a failed start.
    const created = await response.json() as { projectId?: string };
    if (!created.projectId) throw new Error('服务没有返回项目编号');
    const session = await startGuestSession({
      request: {
        providerId: 'creation',
        id: '作品',
        title,
        url: `https://superwagie.local/work/${kind}`,
        text: FIRST_MESSAGE[kind],
        projectId: created.projectId,
        navigation: 'open',
      },
      directory: null,
      t: (key, params) => formatMessage(useI18nStore.getState().dictionary, key, params),
      assertAuthorized: () => {},
    });
    if (!session?.sessionId) throw new Error('会话没有建起来');
    toast.success('开好了，直接在对话里说就行。', { id: 'creation-start' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '连接出了点问题';
    toast.error(`没能开始：${reason}。`, { id: 'creation-start' });
  }
};
