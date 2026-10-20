import { connectHost, type HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

import { isDueToday, isOverdue, todayISO, type Task } from './model.ts';
import { loadTasks, updateTask, type LoadedTasks } from './store.ts';
import { el, installStyles, relativeDay } from './shared.ts';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('缺少根节点');

let global: LoadedTasks | null = null;
let project: LoadedTasks | null = null;

const rows = (): Array<{ task: Task; scope: 'global' | 'project' }> => [
  ...(global?.tasks ?? []).map((task) => ({ task, scope: 'global' as const })),
  ...(project?.tasks ?? []).map((task) => ({ task, scope: 'project' as const })),
];

const render = (): void => {
  root.replaceChildren();
  installStyles();
  const rail = el('div', 'rail');
  const today = todayISO();
  const all = rows();
  const due = all.filter((entry) => isDueToday(entry.task, today));
  const late = all.filter((entry) => isOverdue(entry.task, today));

  const head = el('div');
  head.style.display = 'flex';
  head.style.justifyContent = 'space-between';
  head.style.alignItems = 'center';
  head.append(el('h2', '', '今日'), el('span', 'mono', new Date().toLocaleDateString('zh-CN')));
  rail.append(head);

  if (due.length === 0 && late.length === 0) {
    rail.append(el('div', 'empty', '今天没有到期任务。'));
  }
  for (const entry of late.slice(0, 5)) rail.append(taskRow(entry, true));
  for (const entry of due.slice(0, 5)) rail.append(taskRow(entry, false));
  if (late.length + due.length > 10) rail.append(el('div', 'more', `还有 ${late.length + due.length - 10} 条`));
  root.append(rail);
};

const taskRow = (entry: { task: Task; scope: 'global' | 'project' }, late: boolean): HTMLElement => {
  const row = el('div', 'task');
  const box = el('button', 'box');
  box.dataset.done = String(entry.task.state === 'completed');
  box.setAttribute('aria-label', entry.task.state === 'completed' ? '标记未完成' : '标记完成');
  box.addEventListener('click', (event) => {
    event.stopPropagation();
    void toggle(entry);
  });
  const main = el('div', 'task-title');
  main.append(el('div', '', entry.task.title));
  const meta = el('div', 'task-meta');
  if (entry.task.due) meta.append(el('span', `badge${late ? ' late' : ' due'}`, relativeDay(entry.task.due, todayISO())));
  if (entry.task.owner !== 'me') meta.append(el('span', 'badge', entry.task.owner === 'agent' ? 'Agent' : '共同'));
  if (meta.childElementCount > 0) main.append(meta);
  row.append(box, main);
  row.addEventListener('click', () => {
    if (entry.task.session) void host.openSession(entry.task.session);
  });
  return row;
};

const toggle = async (entry: { task: Task; scope: 'global' | 'project' }): Promise<void> => {
  const loaded = entry.scope === 'global' ? global : project;
  if (!loaded) return;
  const undo = entry.task.state === 'completed';
  const result = await updateTask(host, loaded, entry.task, {
    state: undo ? 'planned' : 'completed',
    done: undo ? '' : todayISO(),
  });
  if (!result.ok) return;
  await refresh();
};

const refresh = async (): Promise<void> => {
  global = await loadTasks(host, 'global').catch(() => null);
  project = await loadTasks(host, 'project').catch(() => null);
  render();
};

host.onReady((ready: HostReadyContext) => {
  applyHostReady(ready, document.documentElement);
  void refresh();
});

host.onSession(() => {
  void refresh();
});

window.addEventListener('pagehide', () => host.dispose());
