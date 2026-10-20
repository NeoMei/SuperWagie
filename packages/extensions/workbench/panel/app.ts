import {
  connectHost,
  type GuestProject,
  type GuestSessionRecord,
  type HostClient,
  type HostReadyContext,
} from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

import { isDueThisWeek, isDueToday, isOverdue, todayISO, TASK_OWNERS, TASK_PRIORITIES, TASK_STATES, type Task } from './model.ts';
import { addTask, deleteTask, loadTasks, updateTask, type LoadedTasks, type TaskScope } from './store.ts';
import { el, installStyles, notice, relativeDay } from './shared.ts';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('缺少根节点');

type View = 'home' | 'tasks';
type Selection = { scope: TaskScope; id: string };

interface State {
  ready: HostReadyContext | null;
  projects: GuestProject[];
  sessions: GuestSessionRecord[];
  projectId: string;
  global: LoadedTasks | null;
  project: LoadedTasks | null;
  view: View;
  selection: Selection | null;
  filter: FilterValue;
  owner: FilterOwner;
  priority: FilterPriority;
  query: string;
  busy: boolean;
}

const state: State = {
  ready: null,
  projects: [],
  sessions: [],
  projectId: '',
  global: null,
  project: null,
  view: 'home',
  selection: null,
  filter: 'open',
  owner: 'all',
  priority: 'all',
  query: '',
  busy: false,
};

const hostNotice = notice();

const scopeLabel = (scope: TaskScope): string => (scope === 'global' ? '收件箱' : '项目');

const ownerLabel = { me: '我', agent: 'Agent', shared: '共同' } satisfies Record<Task['owner'], string>;
const stateLabel = {
  inbox: '收件箱',
  planned: '已计划',
  in_progress: '进行中',
  waiting: '等待对方',
  blocked: '受阻',
  completed: '已完成',
  cancelled: '已取消',
} satisfies Record<Task['state'], string>;

const pick = <T extends string>(values: readonly T[], value: string): T | undefined =>
  values.find((entry) => entry === value);

const FILTERS = [
  ['open', '未完成'],
  ['today', '今天与逾期'],
  ['week', '本周'],
  ['done', '已完成'],
  ['all', '全部'],
] as const;
type FilterValue = (typeof FILTERS)[number][0];
const FILTER_OWNERS = ['all', 'me', 'agent', 'shared'] as const;
type FilterOwner = (typeof FILTER_OWNERS)[number];
const FILTER_PRIORITIES = ['all', 'high', 'normal', 'low'] as const;
type FilterPriority = (typeof FILTER_PRIORITIES)[number];

const allTasks = (): Array<{ task: Task; scope: TaskScope }> => [
  ...(state.global?.tasks ?? []).map((task) => ({ task, scope: 'global' as const })),
  ...(state.project?.tasks ?? []).map((task) => ({ task, scope: 'project' as const })),
];

const isOpen = (task: Task): boolean => task.state !== 'completed' && task.state !== 'cancelled';

const findSelection = (): { task: Task; scope: TaskScope } | null => {
  if (!state.selection) return null;
  return allTasks().find((entry) => entry.scope === state.selection?.scope && entry.task.id === state.selection?.id) ?? null;
};

const loadedFor = (scope: TaskScope): LoadedTasks | null => (scope === 'global' ? state.global : state.project);

const refresh = async (): Promise<void> => {
  const [global, project] = await Promise.all([
    loadTasks(host, 'global').catch(() => null),
    loadTasks(host, 'project').catch(() => null),
  ]);
  state.global = global;
  state.project = project;
  render();
};

const withWrite = async (operation: () => Promise<{ ok: boolean; reason?: string }>): Promise<void> => {
  if (state.busy) return;
  state.busy = true;
  try {
    const result = await operation();
    if (!result.ok) {
      hostNotice.show(
        result.reason === 'conflict'
          ? '文件在别处被修改了，先刷新再改，避免覆盖你的改动。'
          : '写入失败，任务文件可能没有写权限。',
        'error',
      );
      return;
    }
    hostNotice.clear();
    await refresh();
  } catch (error) {
    hostNotice.show(`操作失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    state.busy = false;
  }
};

const toggleTask = (entry: { task: Task; scope: TaskScope }): void => {
  const loaded = loadedFor(entry.scope);
  if (!loaded) return;
  const done = entry.task.state === 'completed';
  void withWrite(() => updateTask(host, loaded, entry.task, {
    state: done ? 'planned' : 'completed',
    done: done ? '' : todayISO(),
  }));
};

const startSessionFor = (entry: { task: Task; scope: TaskScope }): void => {
  const loaded = loadedFor(entry.scope);
  if (!loaded) return;
  void withWrite(async () => {
    let task = entry.task;
    if (!task.id) {
      const assigned = await updateTask(host, loaded, task, {});
      if (!assigned.ok) return { ok: false, reason: assigned.reason };
      const created = assigned.loaded.tasks.find((candidate) => candidate.line === task.line);
      if (!created?.id) return { ok: false, reason: 'failed' };
      task = created;
    }
    const projectId = entry.scope === 'project' ? state.projectId : state.projectId || undefined;
    const result = await host.startSession({
      providerId: 'workbench',
      id: task.id ?? 'task',
      title: task.title,
      url: `https://superwagie.local/task/${encodeURIComponent(task.id ?? '')}`,
      text: [task.title, task.note].filter(Boolean).join('\n\n').slice(0, 16_000),
      projectId,
      navigation: 'preserve',
    });
    if (!result.sessionId) {
      hostNotice.show('会话没有建起来，项目或分支可能不可用。', 'warn');
      return { ok: false, reason: 'failed' };
    }
    const latest = loadedFor(entry.scope);
    if (!latest) return { ok: false, reason: 'failed' };
    return updateTask(host, latest, task, { session: result.sessionId, state: 'in_progress' });
  });
  void refresh();
};

const linkCurrentSession = (entry: { task: Task; scope: TaskScope }): void => {
  const loaded = loadedFor(entry.scope);
  const session = state.ready?.session;
  if (!loaded || !session) {
    hostNotice.show('先打开一个会话，再把它关联到任务。', 'warn');
    return;
  }
  void withWrite(() => updateTask(host, loaded, entry.task, { session: session.id }));
};

const saveDetail = (entry: { task: Task; scope: TaskScope }, patch: Partial<Task>): void => {
  const loaded = loadedFor(entry.scope);
  if (!loaded) return;
  void withWrite(() => updateTask(host, loaded, entry.task, patch));
};

const formatClock = (): string => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

const formatToday = (): string => new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });

const renderTaskRow = (
  entry: { task: Task; scope: TaskScope },
  options: { compact?: boolean } = {},
): HTMLElement => {
  const { task } = entry;
  const row = el('div', 'task');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');

  const box = el('button', 'box');
  box.setAttribute('aria-label', task.state === 'completed' ? '标记未完成' : '标记完成');
  box.dataset.done = String(task.state === 'completed');
  box.textContent = task.state === 'completed' ? '✓' : '';
  box.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleTask(entry);
  });
  row.append(box);

  const main = el('div', 'task-title');
  main.append(el('div', '', task.title));
  const meta = el('div', 'task-meta');
  if (task.due) {
    const badge = el('span', `badge${isOverdue(task) ? ' late' : isDueToday(task) ? ' due' : ''}`, relativeDay(task.due, todayISO()));
    meta.append(badge);
  }
  if (task.owner !== 'me') meta.append(el('span', 'badge', ownerLabel[task.owner]));
  if (task.state === 'blocked' || task.state === 'waiting') meta.append(el('span', 'badge', stateLabel[task.state]));
  if (!options.compact) meta.append(el('span', 'badge', scopeLabel(entry.scope)));
  if (task.session) meta.append(el('span', 'badge', '有会话'));
  if (meta.childElementCount > 0) main.append(meta);
  row.append(main);

  const open = (): void => {
    if (task.id) {
      state.selection = { scope: entry.scope, id: task.id };
      state.view = 'tasks';
      render();
    }
  };
  row.addEventListener('click', open);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
  return row;
};

const renderHome = (): HTMLElement => {
  const wrap = el('div', 'bento');
  const today = todayISO();
  const tasks = allTasks();
  const dueToday = tasks.filter((entry) => isDueToday(entry.task, today));
  const overdue = tasks.filter((entry) => isOverdue(entry.task, today));
  const weekDone = tasks.filter((entry) => entry.task.state === 'completed' && entry.task.done && isDueThisWeek({ ...entry.task, due: entry.task.done, state: 'planned' }, today));
  const running = state.sessions.filter((session) => session.activity === 'running' || session.activity === 'retrying');
  const recent = [...state.sessions].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 4);

  // Start card
  const start = el('section', 'tile start');
  start.append(el('h2', '', '开始工作'));
  const input = el('input');
  input.placeholder = '今天想完成什么？';
  input.setAttribute('aria-label', '今天想完成什么');
  start.append(input);

  const controls = el('div', 'row');
  const scope = el('select');
  scope.setAttribute('aria-label', '任务写入位置');
  scope.append(new Option(state.projectId ? '收件箱' : '收件箱（全局）', 'global'));
  if (state.projectId) scope.append(new Option('当前项目', 'project'));
  const options = el('div', 'row');
  const create = el('button', 'primary', '建任务');
  const startChat = el('button', 'ghost', '开会话');
  controls.append(scope);
  if (state.projects.length > 0) {
    const project = el('select');
    project.setAttribute('aria-label', '会话项目');
    for (const entry of state.projects) project.append(new Option(entry.name || entry.id, entry.id));
    project.value = state.projectId;
    project.addEventListener('change', () => {
      state.projectId = project.value;
      void connectSessions();
      render();
    });
    controls.append(project);
  }
  controls.append(create, startChat);
  start.append(controls, options);

  const createTask = async (alsoStart: boolean): Promise<void> => {
    const title = input.value.trim();
    if (!title) {
      hostNotice.show('先写一句要做什么。', 'warn');
      return;
    }
    const target: TaskScope = scope.value === 'project' && state.projectId ? 'project' : 'global';
    const loaded = target === 'project' ? state.project : state.global;
    if (!loaded) {
      hostNotice.show('这个项目还没有可写的任务文件。', 'warn');
      return;
    }
    state.busy = true;
    try {
      const result = await addTask(host, loaded, { title });
      if (!result.ok) {
        hostNotice.show(result.reason === 'conflict' ? '任务文件刚被改过，刷新后再试。' : '写入失败。', 'error');
        return;
      }
      hostNotice.clear();
      input.value = '';
      state.selection = result.task.id ? { scope: target, id: result.task.id } : null;
      await refresh();
      if (alsoStart) {
        const created = allTasks().find((entry) => entry.task.id === result.task.id);
        if (created) startSessionFor(created);
      }
    } finally {
      state.busy = false;
    }
  };

  create.addEventListener('click', () => void createTask(false));
  startChat.addEventListener('click', () => void createTask(true));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void createTask(false);
    }
  });

  // Today
  const todayTile = el('section', 'tile today');
  todayTile.append(el('h2', '', '今日'));
  const todayList = el('div', 'list');
  if (dueToday.length === 0) todayList.append(el('div', 'empty', '今天没有到期任务。'));
  for (const entry of dueToday.slice(0, 8)) todayList.append(renderTaskRow(entry, { compact: true }));
  todayTile.append(todayList);

  // Overdue
  const overdueTile = el('section', 'tile half');
  overdueTile.append(el('h2', '', '已逾期'));
  const overdueList = el('div', 'list');
  if (overdue.length === 0) overdueList.append(el('div', 'empty', '没有逾期任务。'));
  for (const entry of overdue.slice(0, 8)) overdueList.append(renderTaskRow(entry, { compact: true }));
  overdueTile.append(overdueList);

  // Inbox: open tasks with no date yet.
  const inbox = tasks.filter((entry) => isOpen(entry.task) && !entry.task.due && entry.task.state !== 'blocked');
  const inboxTile = el('section', 'tile half');
  inboxTile.append(el('h2', '', '收件箱'));
  const inboxList = el('div', 'list');
  if (inbox.length === 0) inboxList.append(el('div', 'empty', '收件箱是空的。'));
  for (const entry of inbox.slice(0, 6)) inboxList.append(renderTaskRow(entry, { compact: true }));
  inboxTile.append(inboxList);

  // Week
  const weekTile = el('section', 'tile third');
  weekTile.append(el('h2', '', '本周完成'));
  weekTile.append(el('div', 'count', String(weekDone.length)), el('div', 'wb-sub', `全部已完成 ${tasks.filter((entry) => entry.task.state === 'completed').length}`));

  // Sessions
  const sessionTile = el('section', 'tile half');
  sessionTile.append(el('h2', '', '会话'));
  const sessionList = el('div', 'list');
  if (running.length > 0) sessionList.append(el('div', 'section-label', `进行中 ${running.length}`));
  for (const session of running.slice(0, 4)) {
    const row = el('div', 'task');
    row.tabIndex = 0;
    row.append(el('div', '', session.title || '未命名会话'), el('span', 'badge', '进行中'));
    row.addEventListener('click', () => void host.openSession(session.id));
    sessionList.append(row);
  }
  sessionList.append(el('div', 'section-label', '最近'));
  for (const session of recent) {
    const row = el('div', 'task');
    row.tabIndex = 0;
    const main = el('div', 'task-title');
    main.append(el('div', '', session.title || '未命名会话'));
    main.append(el('div', 'task-meta', new Date(session.updatedAt).toLocaleDateString('zh-CN')));
    row.append(main);
    row.addEventListener('click', () => void host.openSession(session.id));
    sessionList.append(row);
  }
  if (recent.length === 0) sessionList.append(el('div', 'empty', '还没有会话。'));
  sessionTile.append(sessionList);

  wrap.append(start, todayTile, overdueTile, inboxTile, weekTile, sessionTile);
  return wrap;
};

const filterTask = (entry: { task: Task; scope: TaskScope }): boolean => {
  const task = entry.task;
  const today = todayISO();
  if (state.filter === 'open' && !isOpen(task)) return false;
  if (state.filter === 'done' && task.state !== 'completed') return false;
  if (state.filter === 'today' && !isDueToday(task, today) && !isOverdue(task, today)) return false;
  if (state.filter === 'week' && !isDueThisWeek(task, today)) return false;
  if (state.owner !== 'all' && task.owner !== state.owner) return false;
  if (state.priority !== 'all' && task.priority !== state.priority) return false;
  if (state.query && !`${task.title} ${task.note}`.toLowerCase().includes(state.query.toLowerCase())) return false;
  return true;
};

const renderDetail = (): HTMLElement | null => {
  const entry = findSelection();
  if (!entry) return null;
  const { task } = entry;
  const detail = el('section', 'detail');
  detail.append(el('h2', '', task.title || '未命名任务'));

  const titleField = el('div', 'field');
  titleField.append(el('label', '', '标题'));
  const titleInput = el('input');
  titleInput.value = task.title;
  titleField.append(titleInput);

  const row = el('div', 'actions');
  const stateField = el('div', 'field');
  stateField.append(el('label', '', '状态'));
  const stateSelect = el('select');
  for (const value of TASK_STATES) stateSelect.append(new Option(stateLabel[value], value));
  stateSelect.value = task.state;
  stateField.append(stateSelect);

  const ownerField = el('div', 'field');
  ownerField.append(el('label', '', '负责人'));
  const ownerSelect = el('select');
  for (const value of TASK_OWNERS) ownerSelect.append(new Option(ownerLabel[value], value));
  ownerSelect.value = task.owner;
  ownerField.append(ownerSelect);

  const priorityField = el('div', 'field');
  priorityField.append(el('label', '', '优先级'));
  const prioritySelect = el('select');
  for (const [value, label] of [['low', '低'], ['normal', '普通'], ['high', '高']] as const) prioritySelect.append(new Option(label, value));
  prioritySelect.value = task.priority;
  priorityField.append(prioritySelect);

  const dueField = el('div', 'field');
  dueField.append(el('label', '', '截止'));
  const dueInput = el('input');
  dueInput.type = 'date';
  dueInput.value = task.due;
  dueField.append(dueInput);

  const noteField = el('div', 'field');
  noteField.append(el('label', '', '说明'));
  const noteInput = el('textarea');
  noteInput.value = task.note;
  noteField.append(noteInput);

  row.append(stateField, ownerField, priorityField, dueField);

  const actions = el('div', 'actions');
  const startBtn = el('button', 'btn primary', task.session ? '再开一个会话' : '开始会话');
  startBtn.addEventListener('click', () => startSessionFor(entry));
  const linkBtn = el('button', 'btn', '关联当前会话');
  linkBtn.disabled = !state.ready?.session;
  linkBtn.addEventListener('click', () => linkCurrentSession(entry));
  const doneBtn = el('button', 'btn', task.state === 'completed' ? '标记未完成' : '标记完成');
  doneBtn.addEventListener('click', () => toggleTask(entry));
  actions.append(startBtn, linkBtn, doneBtn);

  if (task.session) {
    const openBtn = el('button', 'btn', '打开会话');
    openBtn.addEventListener('click', () => void host.openSession(task.session));
    actions.append(openBtn);
  }

  const removeBtn = el('button', 'btn', '删除任务');
  removeBtn.addEventListener('click', () => {
    const loaded = loadedFor(entry.scope);
    if (!loaded) return;
    if (!window.confirm('从任务文件里删掉这条任务？')) return;
    state.selection = null;
    void withWrite(() => deleteTask(host, loaded, task));
  });
  actions.append(removeBtn);

  const save = el('button', 'btn primary', '保存');
  save.addEventListener('click', () => {
    if (!task.id) return;
    saveDetail(entry, {
      title: titleInput.value.trim() || task.title,
      note: noteInput.value,
      state: pick(TASK_STATES, stateSelect.value) ?? task.state,
      owner: pick(TASK_OWNERS, ownerSelect.value) ?? task.owner,
      priority: pick(TASK_PRIORITIES, prioritySelect.value) ?? task.priority,
      due: dueInput.value,
      done: stateSelect.value === 'completed' ? task.done || todayISO() : '',
    });
  });

  detail.append(titleField, row, noteField, actions, save);
  detail.append(el('div', 'mono', `${entry.scope === 'global' ? '~/.config/openchamber/tasks.md' : '任务.md'} · 第 ${task.line} 行`));
  if (task.session) detail.append(el('div', 'mono', `会话 ${task.session}`));
  return detail;
};

const renderTasks = (): HTMLElement => {
  const wrap = el('div', 'tasks');

  const left = el('div');
  const toolbar = el('div', 'toolbar');
  const filter = el('select');
  filter.setAttribute('aria-label', '筛选');
  for (const [value, label] of FILTERS) filter.append(new Option(label, value));
  filter.value = state.filter;
  filter.addEventListener('change', () => {
    state.filter = pick(FILTERS.map(([value]) => value), filter.value) ?? state.filter;
    render();
  });
  const owner = el('select');
  owner.setAttribute('aria-label', '负责人');
  owner.append(new Option('所有负责人', 'all'), new Option('我', 'me'), new Option('Agent', 'agent'), new Option('共同', 'shared'));
  owner.value = state.owner;
  owner.addEventListener('change', () => {
    state.owner = pick(FILTER_OWNERS, owner.value) ?? state.owner;
    render();
  });
  const priority = el('select');
  priority.setAttribute('aria-label', '优先级');
  priority.append(new Option('所有优先级', 'all'), new Option('高', 'high'), new Option('普通', 'normal'), new Option('低', 'low'));
  priority.value = state.priority;
  priority.addEventListener('change', () => {
    state.priority = pick(FILTER_PRIORITIES, priority.value) ?? state.priority;
    render();
  });
  const search = el('input');
  search.placeholder = '搜索';
  search.value = state.query;
  search.addEventListener('input', () => {
    state.query = search.value;
    render();
  });
  toolbar.append(filter, owner, priority, search);
  left.append(toolbar);

  const list = el('div', 'list');
  const visible = allTasks().filter(filterTask);
  const sorted = [...visible].sort((leftEntry, rightEntry) => {
    const a = leftEntry.task.due || '9999-12-31';
    const b = rightEntry.task.due || '9999-12-31';
    return a === b ? leftEntry.task.line - rightEntry.task.line : a < b ? -1 : 1;
  });
  if (sorted.length === 0) list.append(el('div', 'empty', '没有符合条件的任务。'));
  for (const entry of sorted) list.append(renderTaskRow(entry));
  if (state.global && state.global.issues.length > 0) {
    list.append(el('div', 'section-label', '无法解析的行'));
    for (const issue of state.global.issues) {
      list.append(el('div', 'mono', `第 ${issue.line} 行：${issue.reason}`));
    }
  }
  left.append(list);

  const right = el('div');
  const detail = renderDetail();
  if (detail) right.append(detail);
  else {
    const hint = el('div', 'detail');
    hint.append(el('h2', '', '任务详情'), el('div', 'empty', '从左边选一条任务。'));
    right.append(hint);
  }

  wrap.append(left, right);
  return wrap;
};

const render = (): void => {
  if (!root) return;
  root.replaceChildren();
  installStyles();
  const page = el('main', 'wb');

  const head = el('header', 'wb-head');
  const titleWrap = el('div');
  const clockText = `${formatToday()} · ${formatClock()}`;
  const clockNode = el('div', 'wb-sub', clockText);
  titleWrap.append(el('h1', '', '工作台'), clockNode);
  const tabs = el('div', 'tabs');
  const homeTab = el('button', '', '工作台');
  homeTab.setAttribute('aria-pressed', String(state.view === 'home'));
  homeTab.addEventListener('click', () => {
    state.view = 'home';
    render();
  });
  const tasksTab = el('button', '', '任务');
  tasksTab.setAttribute('aria-pressed', String(state.view === 'tasks'));
  tasksTab.addEventListener('click', () => {
    state.view = 'tasks';
    render();
  });
  tabs.append(homeTab, tasksTab);
  head.append(titleWrap, tabs);

  page.append(head);
  page.append(state.view === 'home' ? renderHome() : renderTasks());
  if (state.projectId && state.project === null) {
    page.append(el('div', 'notice', '当前项目的任务文件暂时读不到，只显示全局收件箱。'));
  }
  page.append(hostNotice.element);
  root.append(page);
};

let stopSessions: (() => void) | null = null;

const connectSessions = async (): Promise<void> => {
  stopSessions?.();
  stopSessions = null;
  if (!state.projectId) {
    state.sessions = [];
    return;
  }
  const owner = state.projectId;
  const release = await host.onSessions(state.projectId, (snapshot) => {
    if (state.projectId !== owner || snapshot.state !== 'ready') return;
    state.sessions = snapshot.sessions;
    if (state.view === 'home') render();
  });
  if (state.projectId === owner) stopSessions = release;
  else release();
};

const bootstrap = async (ready: HostReadyContext): Promise<void> => {
  state.ready = ready;
  const projects = await host.listProjects().catch(() => null);
  state.projects = projects?.projects ?? [];
  state.projectId = state.projects[0]?.id ?? '';
  await Promise.all([
    loadTasks(host, 'global').then((loaded) => { state.global = loaded; }).catch(() => null),
    loadTasks(host, 'project').then((loaded) => { state.project = loaded; }).catch(() => null),
    connectSessions(),
  ]);
  render();
};

host.onSession(() => {
  // The open project can change with the session; the task file is read
  // relative to it, so reload rather than guess the id.
  void refresh();
});

host.onReady((ready) => {
  applyHostReady(ready, document.documentElement);
  void bootstrap(ready).catch((error) => {
    hostNotice.show(`加载失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    render();
  });
});

setInterval(() => {
  const node = document.querySelector('.wb-head .wb-sub');
  if (node) node.textContent = `${formatToday()} · ${formatClock()}`;
}, 30_000);

window.addEventListener('pagehide', () => {
  host.dispose();
});
