import {
  connectHost,
  type GuestProject,
  type GuestSessionRecord,
  type HostClient,
  type HostReadyContext,
} from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

import { isDueThisWeek, isDueToday, isOverdue, todayISO, TASK_PRIORITIES, TASK_STATES, type Task } from './model.ts';
import { deleteTask, loadTasks, updateTask, type LoadedTasks, type TaskScope } from './store.ts';
import { el, installStyles, notice, relativeDay } from './shared.ts';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('缺少根节点');

type Selection = { scope: TaskScope; id: string };

interface State {
  ready: HostReadyContext | null;
  projects: GuestProject[];
  sessions: GuestSessionRecord[];
  projectId: string;
  global: LoadedTasks | null;
  project: LoadedTasks | null;
  selection: Selection | null;
  filter: FilterValue;
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
  selection: null,
  filter: 'open',
  priority: 'all',
  query: '',
  busy: false,
};

const hostNotice = notice();

let calendarMonth = new Date();
calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
let calendarOpen = false;
let calendarDay: string | null = null;

const scopeLabel = (scope: TaskScope): string => (scope === 'global' ? '我的任务' : '项目');

const stateLabel = {
  planned: '待办',
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
  if (task.origin === 'agent') meta.append(el('span', 'badge', '来自对话'));
  if (task.state === 'blocked' || task.state === 'waiting') meta.append(el('span', 'badge', stateLabel[task.state]));
  if (!options.compact) meta.append(el('span', 'badge', scopeLabel(entry.scope)));
  if (task.session) meta.append(el('span', 'badge', '有会话'));
  if (meta.childElementCount > 0) main.append(meta);
  row.append(main);

  const open = (): void => {
    if (task.id) {
      state.selection = { scope: entry.scope, id: task.id };
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

const isoOf = (date: Date): string => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const mondayOfThisWeek = (): Date => {
  const now = new Date();
  const offset = (now.getDay() + 6) % 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
};

const taskMapByDate = (): Map<string, Array<{ task: Task; scope: TaskScope }>> => {
  const map = new Map<string, Array<{ task: Task; scope: TaskScope }>>();
  for (const entry of allTasks()) {
    if (!entry.task.due) continue;
    const list = map.get(entry.task.due) ?? [];
    list.push(entry);
    map.set(entry.task.due, list);
  }
  return map;
};

const renderCalendarCard = (): HTMLElement => {
  const card = el('section', 'tile cal-card');
  const byDate = taskMapByDate();
  const today = todayISO();
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();

  const head = el('div', 'cal-card-head');
  const title = el('h2', '', calendarOpen ? `${year}年${month + 1}月` : '本周');
  const nav = el('div', 'cal-navs');
  const toggle = el('button', 'cal-nav', calendarOpen ? '周' : '月');
  toggle.setAttribute('aria-label', calendarOpen ? '切回本周' : '展开本月');
  nav.append(toggle);
  if (calendarOpen) {
    const prev = el('button', 'cal-nav', '‹');
    const next = el('button', 'cal-nav', '›');
    prev.addEventListener('click', () => {
      calendarMonth = new Date(year, month - 1, 1);
      render();
    });
    next.addEventListener('click', () => {
      calendarMonth = new Date(year, month + 1, 1);
      render();
    });
    nav.append(prev, next);
  }
  head.append(title, nav);
  card.append(head);

  const grid = el('div', calendarOpen ? 'cal-month-mini' : 'cal-week-mini');
  if (calendarOpen) {
    for (const dow of ['一', '二', '三', '四', '五', '六', '日']) grid.append(el('div', 'cal-dow', dow));
    const prefix = `${year}-${`${month + 1}`.padStart(2, '0')}-`;
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let index = 0; index < offset; index += 1) grid.append(el('span', 'cal-blank'));
    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = `${prefix}${`${day}`.padStart(2, '0')}`;
      grid.append(dayCell(iso, String(day), byDate.get(iso), today));
    }
  } else {
    const monday = mondayOfThisWeek();
    for (let index = 0; index < 7; index += 1) {
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index);
      const iso = isoOf(date);
      grid.append(dayCell(iso, String(date.getDate()), byDate.get(iso), today, ['一', '二', '三', '四', '五', '六', '日'][index]));
    }
  }
  card.append(grid);

  if (calendarDay) {
    const entries = byDate.get(calendarDay) ?? [];
    const list = el('div', 'cal-day-list');
    if (entries.length === 0) list.append(el('div', 'empty', '这天没有任务。'));
    for (const entry of entries.slice(0, 4)) {
      const item = el('button', 'cal-day-item');
      item.append(el('span', '', entry.task.title));
      item.addEventListener('click', () => {
        if (!entry.task.id) return;
        state.selection = { scope: entry.scope, id: entry.task.id };
          render();
      });
      list.append(item);
    }
    if (entries.length > 4) list.append(el('div', 'cal-more', `还有 ${entries.length - 4} 条`));
    card.append(list);
  }

  toggle.addEventListener('click', () => {
    calendarOpen = !calendarOpen;
    render();
  });
  return card;
};

const dayCell = (
  iso: string,
  label: string,
  entries: Array<{ task: Task; scope: TaskScope }> | undefined,
  today: string,
  dow?: string,
): HTMLElement => {
  const cell = el('button', `cal-day${iso === today ? ' today' : ''}${iso === calendarDay ? ' selected' : ''}`);
  if (dow) cell.append(el('span', 'cal-dow', dow));
  cell.append(el('span', 'cal-num', label));
  if (entries && entries.length > 0) cell.append(el('span', 'cal-dot'));
  cell.addEventListener('click', () => {
    calendarDay = iso === calendarDay ? null : iso;
    render();
  });
  return cell;
};

const renderHome = (): HTMLElement => {
  const wrap = el('div', 'wb-cols');
  const main = el('div', 'wb-main');
  const side = el('div', 'wb-side');
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
  const startButton = el('button', 'primary', '开始');
  const quick = el('div', 'quick');
  const presets: Array<[string, string]> = [
    ['写文档', '帮我写一份文档。先和我确认主题、读者和篇幅。'],
    ['做 PPT', '帮我做一份 PPT。先确认主题、受众和页数。'],
    ['做演示视频', '帮我做一个演示视频。先确认主题、时长和风格。'],
    ['创建待办', '帮我创建一个待办任务。'],
  ];
  for (const [label, prompt] of presets) {
    const chip = el('button', 'chip', label);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      input.value = prompt;
      input.focus();
    });
    quick.append(chip);
  }
  controls.append(startButton, quick);
  const hint = el('div', 'ctl-label', '会开一个会话，把要做的事交给智能体');
  start.append(controls, hint);

  const startWork = (): void => {
    const text = input.value.trim();
    if (!text) {
      hostNotice.show('先写一句要做什么。', 'warn');
      return;
    }
    const title = text.split('\n')[0].slice(0, 80);
      void host.startSession({
      providerId: 'workbench',
      id: `start_${Date.now()}`,
      title,
      url: '',
      text: text.slice(0, 16_000),
      projectId: state.projectId || undefined,
      navigation: 'open',
    }).then((result) => {
      if (!result.sessionId) hostNotice.show('会话没有建起来，先确认有可用的项目。', 'warn');
    }).catch(() => {
      hostNotice.show('开会话失败，先确认有可用的项目再试。', 'error');
    }).finally(() => {
      state.busy = false;
    });
  };

  startButton.addEventListener('click', startWork);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      startWork();
    }
  });

  // Progress
  const weekTile = el('section', 'tile third');
  weekTile.append(el('h2', '', '本周完成'));
  weekTile.append(el('div', 'count', String(weekDone.length)), el('div', 'wb-sub', `全部已完成 ${tasks.filter((entry) => entry.task.state === 'completed').length}`));

  const sessionTile = el('section', 'tile wide');
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
    const mainPart = el('div', 'task-title');
    mainPart.append(el('div', '', session.title || '未命名会话'));
    mainPart.append(el('div', 'task-meta', new Date(session.updatedAt).toLocaleDateString('zh-CN')));
    row.append(mainPart);
    row.addEventListener('click', () => void host.openSession(session.id));
    sessionList.append(row);
  }
  if (recent.length === 0) sessionList.append(el('div', 'empty', '还没有会话。'));
  sessionTile.append(sessionList);

  const progressZone = el('section', 'zone');
  const progressGrid = el('div', 'bento');
  progressGrid.append(weekTile, sessionTile);
  progressZone.append(el('h3', 'zone-title', '进展'), progressGrid);

  const calendarCard = renderCalendarCard();
  side.append(calendarCard);
  main.append(start, renderTaskList(), progressZone);
  wrap.append(main, side);
  return wrap;
};

const filterTask = (entry: { task: Task; scope: TaskScope }): boolean => {
  const task = entry.task;
  const today = todayISO();
  if (state.filter === 'open' && !isOpen(task)) return false;
  if (state.filter === 'done' && task.state !== 'completed') return false;
  if (state.filter === 'today' && !isDueToday(task, today) && !isOverdue(task, today)) return false;
  if (state.filter === 'week' && !isDueThisWeek(task, today)) return false;
  if (state.priority !== 'all' && task.priority !== state.priority) return false;
  if (state.query && !`${task.title} ${task.note}`.toLowerCase().includes(state.query.toLowerCase())) return false;
  return true;
};

const renderTaskEditor = (entry: { task: Task; scope: TaskScope }): HTMLElement => {
  const { task } = entry;
  const editor = el('div', 'editor');

  const titleField = el('div', 'field');
  titleField.append(el('label', '', '标题'));
  const titleInput = el('input');
  titleInput.value = task.title;
  titleField.append(titleInput);

  const row = el('div', 'editor-row');
  const stateField = el('div', 'field');
  stateField.append(el('label', '', '状态'));
  const stateSelect = el('select');
  for (const value of TASK_STATES) stateSelect.append(new Option(stateLabel[value], value));
  stateSelect.value = task.state;
  stateField.append(stateSelect);

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
  row.append(stateField, priorityField, dueField);

  const noteField = el('div', 'field');
  noteField.append(el('label', '', '说明'));
  const noteInput = el('textarea');
  noteInput.value = task.note;
  noteField.append(noteInput);

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
      priority: pick(TASK_PRIORITIES, prioritySelect.value) ?? task.priority,
      due: dueInput.value,
      done: stateSelect.value === 'completed' ? task.done || todayISO() : '',
    });
  });

  const meta = el('div', 'mono', `${entry.scope === 'global' ? '我的任务' : '项目任务'} · 第 ${task.line} 行${task.origin === 'agent' ? ' · 来自对话' : ''}`);
  editor.append(titleField, row, noteField, actions, save, meta);
  return editor;
};

const renderTaskList = (): HTMLElement => {
  const section = el('section', 'zone task-zone');
  const head = el('div', 'section-head');
  const visible = allTasks().filter(filterTask);
  const title = el('h2', 'zone-title', '任务');
  title.append(el('span', 'n', String(visible.length)));
  const toolbar = el('div', 'toolbar');
  const filter = el('select');
  filter.setAttribute('aria-label', '筛选');
  for (const [value, label] of FILTERS) filter.append(new Option(label, value));
  filter.value = state.filter;
  filter.addEventListener('change', () => {
    state.filter = pick(FILTERS.map(([value]) => value), filter.value) ?? state.filter;
    render();
  });
  const priority = el('select');
  priority.setAttribute('aria-label', '优先级');
  priority.append(new Option('优先级', 'all'), new Option('高', 'high'), new Option('普通', 'normal'), new Option('低', 'low'));
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
  toolbar.append(filter, priority, search);
  head.append(title, toolbar);
  section.append(head);

  const list = el('div', 'list');
  const sorted = [...visible].sort((leftEntry, rightEntry) => {
    const a = leftEntry.task.due || '9999-12-31';
    const b = rightEntry.task.due || '9999-12-31';
    return a === b ? leftEntry.task.line - rightEntry.task.line : a < b ? -1 : 1;
  });
  if (sorted.length === 0) list.append(el('div', 'empty', '没有符合条件的任务。'));
  for (const entry of sorted) {
    list.append(renderTaskRow(entry));
    const selected = Boolean(state.selection && state.selection.scope === entry.scope && state.selection.id === entry.task.id && entry.task.id);
    if (selected) list.append(renderTaskEditor(entry));
  }
  if (state.global && state.global.issues.length > 0) {
    list.append(el('div', 'section-label', '无法解析的行'));
    for (const issue of state.global.issues) list.append(el('div', 'mono', `第 ${issue.line} 行：${issue.reason}`));
  }
  section.append(list);
  return section;
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
  head.append(titleWrap);

  page.append(head);
  page.append(renderHome());
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
  const project = state.projectId;
  const release = await host.onSessions(state.projectId, (snapshot) => {
    if (state.projectId !== project || snapshot.state !== 'ready') return;
    state.sessions = snapshot.sessions;
    render();
  });
  if (state.projectId === project) stopSessions = release;
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
