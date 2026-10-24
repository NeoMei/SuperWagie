import { t, setWorkbenchLocale, workbenchLocale } from './i18n.ts';
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
  head.append(el('h2', '', t('today')), el('span', 'mono', new Date().toLocaleDateString(workbenchLocale())));
  rail.append(head);

  if (due.length === 0 && late.length === 0) {
    rail.append(el('div', 'empty', t('noDueToday')));
  }
  for (const entry of late.slice(0, 5)) rail.append(taskRow(entry, true));
  for (const entry of due.slice(0, 5)) rail.append(taskRow(entry, false));
  if (late.length + due.length > 10) rail.append(el('div', 'more', t('more', { count: late.length + due.length - 10 })));
  root.append(rail);
};

const taskRow = (entry: { task: Task; scope: 'global' | 'project' }, late: boolean): HTMLElement => {
  const row = el('div', 'task');
  const box = el('button', 'box');
  box.dataset.done = String(entry.task.state === 'completed');
  box.setAttribute('aria-label', entry.task.state === 'completed' ? t('markIncomplete') : t('markComplete'));
  box.addEventListener('click', (event) => {
    event.stopPropagation();
    void toggle(entry);
  });
  const main = el('div', 'task-title');
  main.append(el('div', '', entry.task.title));
  const meta = el('div', 'task-meta');
  if (entry.task.due) meta.append(el('span', `badge${late ? ' late' : ' due'}`, relativeDay(entry.task.due, todayISO())));
  if (entry.task.origin === 'agent') meta.append(el('span', 'badge', t('fromChat')));
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

let readySeen = false;
let lastSession: HostReadyContext['session'] = null;
host.onReady((ready: HostReadyContext) => {
  applyHostReady(ready, document.documentElement);
  setWorkbenchLocale(ready.locale);
  document.title = t('today');
  if (readySeen) { render(); return; }
  readySeen = true;
  lastSession = ready.session;
  void refresh();
});

host.onSession((session) => {
  if (session?.id === lastSession?.id && session?.busy === lastSession?.busy) return;
  lastSession = session;
  void refresh();
});

window.addEventListener('pagehide', () => host.dispose());
