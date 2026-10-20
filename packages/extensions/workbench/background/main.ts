import { connectHost } from '@openchamber/sdk';

import { addTask, loadTasks } from '../panel/store.ts';

const host = connectHost();

const titleFromText = (text: string): string => {
  const first = text.split('\n').find((line) => line.trim()) ?? '';
  return first.trim().slice(0, 120) || '新的任务';
};

const create = async (title: string, note: string): Promise<void> => {
  const loaded = await loadTasks(host, 'global');
  if (!loaded) throw new Error('读不到全局任务文件');
  const result = await addTask(host, loaded, { title, note });
  if (!result.ok) throw new Error(result.reason === 'conflict' ? '任务文件刚被修改，先刷新再试。' : '写入任务文件失败');
  await host.toast({ kind: 'success', message: `已存为任务：${result.task.title}` });
};

host.onAction(async (item) => {
  if (item.kind !== 'message' || item.action !== 'save-task') {
    throw new Error('未知操作');
  }
  await create(titleFromText(item.text), item.text.slice(0, 16_000));
});

window.addEventListener('pagehide', () => host.dispose());
