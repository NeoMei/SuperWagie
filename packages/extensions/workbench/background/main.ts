import { t, setWorkbenchLocale } from '../panel/i18n.ts';
import { connectHost } from '@openchamber/sdk';

import { addTask, loadTasks } from '../panel/store.ts';

const host = connectHost();
host.onReady((ready) => { setWorkbenchLocale(ready.locale); document.title = t('title'); });

const titleFromText = (text: string): string => {
  const first = text.split('\n').find((line) => line.trim()) ?? '';
  return first.trim().slice(0, 120) || t('newTask');
};

const create = async (title: string, note: string): Promise<void> => {
  const loaded = await loadTasks(host, 'global');
  if (!loaded) throw new Error(t('globalFileUnavailable'));
  const result = await addTask(host, loaded, { title, note, origin: 'agent' });
  if (!result.ok) throw new Error(result.reason === 'conflict' ? t('taskFileConflict') : t('taskFileWriteFailed'));
  await host.toast({ kind: 'success', message: t('taskSaved', { title: result.task.title }) });
};

host.onAction(async (item) => {
  if (item.kind !== 'message' || item.action !== 'save-task') {
    throw new Error(t('unknownAction'));
  }
  await create(titleFromText(item.text), item.text.slice(0, 16_000));
});

window.addEventListener('pagehide', () => host.dispose());
