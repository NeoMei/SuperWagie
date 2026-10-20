import {
  connectHost,
  type GuestProject,
  type GuestSessionRecord,
  type HostClient,
  type HostReadyContext,
} from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

import { isDoneThisWeek, isDueThisWeek, isDueToday, isOverdue, todayISO, TASK_PRIORITIES, TASK_STATES, type Task } from './model.ts';
import { addTask, deleteTask, loadTasks, updateTask, type LoadedTasks, type TaskScope } from './store.ts';
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
      id: '任务',
      title: task.title,
      url: `https://superwagie.local/task/${encodeURIComponent(task.id ?? '')}`,
      text: [task.title, task.note].filter(Boolean).join('\n\n').slice(0, 16_000),
      projectId,
      navigation: 'open',
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
  const row = el('div', `task${task.state === 'completed' ? ' done' : ''}`);
  row.tabIndex = 0;
  row.setAttribute('role', 'button');

  const box = el('button', 'box');
  box.type = 'button';
  box.setAttribute('aria-label', task.state === 'completed' ? '标记未完成' : '标记完成');
  box.dataset.done = String(task.state === 'completed');
  box.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleTask(entry);
  });
  row.append(box);

  const main = el('div');
  main.append(el('div', 'title', task.title));
  const meta = el('div', 'meta-line');
  if (task.due) meta.append(el('span', `due${isOverdue(task) ? ' late' : ''}`, relativeDay(task.due, todayISO())));
  if (task.state === 'blocked' || task.state === 'waiting') meta.append(el('span', stateLabel[task.state]));
  if (task.origin === 'agent') meta.append(el('span', 'origin', '来自对话'));
  if (!options.compact) meta.append(el('span', 'origin', scopeLabel(entry.scope)));
  if (meta.childElementCount > 0) main.append(meta);
  row.append(main);

  const open = (): void => {
    if (!task.id) return;
    const already = state.selection?.scope === entry.scope && state.selection?.id === task.id;
    state.selection = already ? null : { scope: entry.scope, id: task.id };
    render();
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
  const panel = el('section', `panel${calendarOpen || calendarDay ? ' cal-expanded' : ''}`);
  const head = el('div', 'panel-head');
  const title = el('h2', '', '日历');
  const meta = el('div', 'panel-meta');
  const toggle = el('button', 'chip', calendarOpen ? '周' : '月');
  toggle.style.padding = '3px 9px';
  toggle.style.fontSize = '12px';
  toggle.setAttribute('aria-label', calendarOpen ? '切回本周' : '展开本月');
  meta.append(el('span', '', calendarOpen ? `${calendarMonth.getMonth() + 1}月` : '本周'), toggle);
  head.append(title, meta);
  panel.append(head);

  const byDate = taskMapByDate();
  const today = todayISO();
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();

  if (calendarOpen) {
    const prev = el('button', 'chip', '‹');
    const next = el('button', 'chip', '›');
    prev.style.padding = '2px 8px';
    next.style.padding = '2px 8px';
    const nav = el('div', 'toolbar');
    nav.append(prev, next);
    panel.append(nav);
    const grid = el('div', 'month');
    for (const dow of ['一', '二', '三', '四', '五', '六', '日']) grid.append(el('div', 'cal-dow', dow));
    const prefix = `${year}-${`${month + 1}`.padStart(2, '0')}-`;
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let index = 0; index < offset; index += 1) grid.append(el('span'));
    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = `${prefix}${`${day}`.padStart(2, '0')}`;
      grid.append(dayCell(iso, String(day), byDate.get(iso), today));
    }
    prev.addEventListener('click', () => {
      calendarMonth = new Date(year, month - 1, 1);
      render();
    });
    next.addEventListener('click', () => {
      calendarMonth = new Date(year, month + 1, 1);
      render();
    });
    panel.append(grid);
  } else {
    const week = el('div', 'week');
    const monday = mondayOfThisWeek();
    for (let index = 0; index < 7; index += 1) {
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index);
      const iso = isoOf(date);
      const cell = el('button', `day${iso === today ? ' today' : ''}${iso === calendarDay ? ' selected' : ''}`);
      cell.append(el('span', '', ['一', '二', '三', '四', '五', '六', '日'][index]));
      cell.append(el('b', '', String(date.getDate())));
      if (byDate.has(iso)) cell.append(el('i', 'dot'));
      cell.addEventListener('click', () => {
        calendarDay = iso === calendarDay ? null : iso;
        render();
      });
      week.append(cell);
    }
    panel.append(week);
  }

  if (calendarDay) {
    const entries = byDate.get(calendarDay) ?? [];
    const list = el('div', 'day-list');
    if (entries.length === 0) list.append(el('div', 'empty', '这天没有任务。'));
    for (const entry of entries.slice(0, 4)) {
      const item = el('button', '', entry.task.title);
      item.addEventListener('click', () => {
        if (!entry.task.id) return;
        state.selection = { scope: entry.scope, id: entry.task.id };
        render();
      });
      list.append(item);
    }
    if (entries.length > 4) list.append(el('div', 'empty', `还有 ${entries.length - 4} 条`));
    panel.append(list);
  }

  toggle.addEventListener('click', () => {
    calendarOpen = !calendarOpen;
    render();
  });
  return panel;
};

const dayCell = (
  iso: string,
  label: string,
  entries: Array<{ task: Task; scope: TaskScope }> | undefined,
  today: string,
): HTMLElement => {
  const cell = el('button', `day${iso === today ? ' today' : ''}${iso === calendarDay ? ' selected' : ''}`);
  cell.append(el('b', '', label));
  if (entries && entries.length > 0) cell.append(el('i', 'dot'));
  cell.addEventListener('click', () => {
    calendarDay = iso === calendarDay ? null : iso;
    render();
  });
  return cell;
};

const renderHome = (): HTMLElement => {
  const wrap = el('div', 'home');
  const today = todayISO();
  const tasks = allTasks();
  const dueToday = tasks.filter((entry) => isDueToday(entry.task, today));
  const overdue = tasks.filter((entry) => isOverdue(entry.task, today));
  const unscheduled = tasks.filter((entry) => isOpen(entry.task) && !entry.task.due);
  const weekDone = tasks.filter((entry) => isDoneThisWeek(entry.task, today));
  const completed = tasks.filter((entry) => entry.task.state === 'completed').length;
  const running = state.sessions.filter((session) => session.activity === 'running' || session.activity === 'retrying');
  const recent = [...state.sessions].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 4);

  // Composer
  const composer = el('section', 'composer');
  const input = el('input');
  input.id = 'wb-composer';
  input.placeholder = '写下要做的事，例如：整理周五评审材料';
  input.setAttribute('aria-label', '写下要做的事');
  composer.append(input);

  const row = el('div', 'composer-row');
  const startButton = el('button', 'primary', '开始');
  const chips = el('div', 'toolbar');
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
      if (label !== '创建待办') {
        input.value = prompt;
        input.focus();
        return;
      }
      const title = input.value.trim();
      if (!title) {
        input.focus();
        hostNotice.show('先在输入框写下待办标题，再点创建待办。', 'warn');
        return;
      }
      const loaded = state.global;
      if (!loaded) return;
      let created = '';
      void withWrite(async () => {
        const result = await addTask(host, loaded, { title });
        if (!result.ok) return { ok: false, reason: result.reason };
        created = result.task.title;
        input.value = '';
        return { ok: true };
      }).then(() => {
        if (created) hostNotice.show(`已创建待办：${created}`);
      });
    });
    chips.append(chip);
  }
  row.append(startButton, chips);
  composer.append(row);

  const startWork = (): void => {
    const text = input.value.trim();
    if (!text) {
      hostNotice.show('先写一句要做什么。', 'warn');
      return;
    }
    const title = text.split('\n')[0].slice(0, 80);
    void host.startSession({
      providerId: 'workbench',
      id: '任务',
      title,
      url: 'https://superwagie.local/start',
      text: text.slice(0, 16_000),
      projectId: state.projectId || undefined,
      navigation: 'open',
    }).then((result) => {
      if (!result.sessionId) {
        hostNotice.show('会话没有建起来，先确认有可用的项目。', 'warn');
        void host.toast({ kind: 'error', message: '会话没有建起来，先确认有可用的项目。' });
      }
    }).catch(() => {
      hostNotice.show('开会话失败，先确认有可用的项目再试。', 'error');
      void host.toast({ kind: 'error', message: '开会话失败，先确认有可用的项目再试。' });
    });
  };

  startButton.addEventListener('click', startWork);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      startWork();
    }
  });

  // Count helper for the side column.
  const count = (label: string, value: number, caption: string): HTMLElement => {
    const cell = el('div', 'count');
    cell.append(el('span', '', label), el('strong', '', String(value)), el('em', '', caption));
    return cell;
  };
  // Tasks on the left; counts, calendar and sessions on the right.
  const rowA = el('div', 'row-a');
  const side = el('div', 'side');
  const sideCounts = el('section', 'counts-side');
  sideCounts.append(
    count('今日', dueToday.length, dueToday.length > 0 ? `${dueToday.length} 件到期` : '没有到期'),
    count('逾期', overdue.length, overdue.length > 0 ? `${overdue.length} 件逾期` : '没有逾期'),
    count('未排期', unscheduled.length, unscheduled.length > 0 ? '没定日子' : '都排好了'),
    count('本周完成', weekDone.length, `共完成 ${completed}`),
  );
  side.append(renderCalendarCard(), sideCounts);

  const sessionPanel = el('section', 'panel sessions');
  const sessionHead = el('div', 'panel-head');
  sessionHead.append(el('h2', '', '会话'), el('div', 'panel-meta', '最近'));
  sessionPanel.append(sessionHead);
  if (running.length > 0) sessionPanel.append(el('div', 'section-label', `进行中 ${running.length}`));
  for (const session of [...running.slice(0, 3), ...recent]) {
    const item = el('div', 'task');
    item.tabIndex = 0;
    const main = el('div');
    main.append(el('div', 'title', session.title || '未命名会话'));
    main.append(el('div', 'meta-line', new Date(session.updatedAt).toLocaleDateString('zh-CN')));
    item.append(main);
    item.addEventListener('click', () => void host.openSession(session.id));
    sessionPanel.append(item);
  }
  if (running.length === 0 && recent.length === 0) sessionPanel.append(el('div', 'empty', '还没有会话。'));
  side.append(sessionPanel);
  rowA.append((() => { const main = el('div', 'main-col'); main.append(composer, renderTaskList()); return main; })(), side);
  wrap.append(rowA);
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
  const editorHead = el('div', 'editor-head');
  editorHead.append(el('span', 'section-label', '任务详情'));
  const close = el('button', 'editor-close', '×');
  close.setAttribute('aria-label', '关闭任务详情');
  close.addEventListener('click', () => {
    state.selection = null;
    render();
  });
  editorHead.append(close);
  editor.append(editorHead);

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
  actions.append(startBtn);
  if (task.session) {
    const openBtn = el('button', 'btn', '打开会话');
    openBtn.addEventListener('click', () => void host.openSession(task.session));
    actions.append(openBtn);
  }
  const doneBtn = el('button', 'btn', task.state === 'completed' ? '标记未完成' : '标记完成');
  doneBtn.addEventListener('click', () => toggleTask(entry));
  actions.append(doneBtn);
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

  actions.append(save);
  const meta = el('div', 'mono', `${entry.scope === 'global' ? '我的任务' : '项目任务'} · 第 ${task.line} 行${task.origin === 'agent' ? ' · 来自对话' : ''}`);
  editor.append(titleField, row, noteField, actions, meta);
  return editor;
};

const renderTaskList = (): HTMLElement => {
  const panel = el('section', 'panel');
  const visible = allTasks().filter(filterTask);
  const head = el('div', 'panel-head');
  const titleWrap = el('div', 'panel-meta');
  const title = el('h2', '', '任务');
  titleWrap.append(title, el('span', 'count-chip', String(visible.length)));
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
  head.append(titleWrap, toolbar);
  panel.append(head);

  const rows = el('div', 'rows');
  const sorted = [...visible].sort((leftEntry, rightEntry) => {
    const a = leftEntry.task.due || '9999-12-31';
    const b = rightEntry.task.due || '9999-12-31';
    return a === b ? leftEntry.task.line - rightEntry.task.line : a < b ? -1 : 1;
  });
  if (sorted.length === 0) rows.append(el('div', 'empty', '没有符合条件的任务。'));
  for (const entry of sorted) {
    rows.append(renderTaskRow(entry));
    const selected = Boolean(state.selection && state.selection.scope === entry.scope && state.selection.id === entry.task.id && entry.task.id);
    if (selected) rows.append(renderTaskEditor(entry));
  }
  if (state.global && state.global.issues.length > 0) {
    rows.append(el('div', 'section-label', '无法解析的行'));
    for (const issue of state.global.issues) rows.append(el('div', 'mono', `第 ${issue.line} 行：${issue.reason}`));
  }
  panel.append(rows);
  return panel;
};

const greeting = (): HTMLElement => {
  const hour = new Date().getHours();
  const salute = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  const tasks = allTasks();
  const today = todayISO();
  const due = tasks.filter((entry) => isDueToday(entry.task, today)).length;
  const late = tasks.filter((entry) => isOverdue(entry.task, today)).length;
  const unscheduled = tasks.filter((entry) => isOpen(entry.task) && !entry.task.due).length;
  const fact = late > 0
    ? `有 ${late} 件事拖过期了。`
    : due > 0
      ? `今天有 ${due} 件事到期。`
      : unscheduled > 0
        ? `还有 ${unscheduled} 件事没排期。`
        : '今天没有到期任务。';
  const weekDue = tasks.filter((entry) => isDueThisWeek(entry.task, today)).length;
  const done = tasks.filter((entry) => entry.task.state === 'completed').length;
  const head = el('header', 'greeting');
  head.append(el('h1', '', `${salute}，${fact}`));
  head.append(el('p', '', `${formatToday()} · 本周 ${weekDue} 件到期 · ${done} 件完成`));
  return head;
};

const render = (): void => {
  if (!root) return;
  root.replaceChildren();
  installStyles();
  const page = el('main', 'wb');
  page.append(greeting());
  page.append(renderHome());
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
