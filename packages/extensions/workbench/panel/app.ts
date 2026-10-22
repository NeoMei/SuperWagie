import {
  connectHost,
  type GuestProject,
  type GuestSessionRecord,
  type HostClient,
  type HostReadyContext,
} from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

import { isDoneThisWeek, isDueThisWeek, isDueToday, isOverdue, todayISO, TASK_PRIORITIES, TASK_STATES, type Task } from './model.ts';
import { deleteTask, loadTasks, updateTask, type LoadedTasks, type TaskScope } from './store.ts';
import { el, formatDate, installStyles, notice, relativeDay } from './shared.ts';
import { SOUP_AUTHOR, soupFor } from './soup.ts';
import { collectDeliverables, type Deliverable } from './deliverables.ts';
import { creationProjectIds, mergeSessions } from './sessions.ts';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('缺少根节点');

type Selection = { scope: TaskScope; id: string };

interface ProjectNote {
  id: string;
  body: string;
  createdAt: number;
  pinned?: boolean;
}

interface ProjectTodoEntry {
  id: string;
  text: string;
  completed: boolean;
}

interface ProjectPlanEntry {
  id: string;
  title: string;
  progress?: { done: number; total: number };
}

interface ProjectContextView {
  notes: ProjectNote[];
  todos: ProjectTodoEntry[];
  plans: ProjectPlanEntry[];
}

interface ScheduledExecution {
  kind?: string;
  prompt?: string;
  useDefaults?: boolean;
  targetSessionId?: string;
}

interface ScheduledTaskSummary {
  id?: string;
  execution?: ScheduledExecution;
}

interface ScheduledListResponse {
  tasks?: ScheduledTaskSummary[];
  task?: ScheduledTaskSummary;
}

type ScheduleRequest = { method: 'GET' | 'PUT' | 'DELETE'; path: string; body?: string };

interface ScheduledWrite {
  task: {
    id?: string;
    name: string;
    enabled: boolean;
    schedule: { kind: 'once'; date: string; time: string };
    execution: ScheduledExecution;
  };
}

interface State {
  ready: HostReadyContext | null;
  projects: GuestProject[];
  sessions: GuestSessionRecord[];
  creationSessions: GuestSessionRecord[];
  deliverables: Deliverable[];
  deliverablesError: string;
  projectId: string;
  global: LoadedTasks | null;
  project: LoadedTasks | null;
  selection: Selection | null;
  filter: FilterValue;
  priority: FilterPriority;
  query: string;
  busy: boolean;
  context: ProjectContextView | null;
  contextError: string;
  noteDraft: string;
  contextBusy: boolean;
}

const state: State = {
  ready: null,
  projects: [],
  sessions: [],
  creationSessions: [],
  deliverables: [],
  deliverablesError: '',
  projectId: '',
  global: null,
  project: null,
  selection: null,
  filter: 'open',
  priority: 'all',
  query: '',
  busy: false,
  context: null,
  contextError: '',
  noteDraft: '',
  contextBusy: false,
};

const hostNotice = notice();

let calendarMonth = new Date();
calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
let calendarOpen = false;
let calendarDay: string | null = null;

const scopeLabel = (scope: TaskScope): string => (scope === 'global' ? '我的任务' : '项目');

const stateLabel = {
  planned: '未开始',
  in_progress: '进行中',
  waiting: '等待对方',
  blocked: '受阻',
  completed: '已完成',
  cancelled: '已取消',
} satisfies Record<Task['state'], string>;

const pick = <T extends string>(values: readonly T[], value: string): T | undefined =>
  values.find((entry) => entry === value);

const FILTERS = [
  ['all', '全部'],
  ['open', '未完成'],
  ['done', '已完成'],
  ['today', '今天与逾期'],
  ['week', '本周'],
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
  void withWrite(async () => {
    if (done) {
      // Reopening a dated todo puts its reminder back; the task was only
      // paused, not abandoned.
      const reopened = await updateTask(host, loaded, entry.task, { state: 'planned', done: '' });
      if (!reopened.ok || !entry.task.due || entry.task.due < todayISO()) return reopened;
      const latest = reopened.loaded.tasks.find((candidate) => candidate.id === entry.task.id) ?? null;
      if (!latest) return reopened;
      const reminder = await syncReminderForTask(latest, latest.title, latest.due, latest.dueTime);
      return updateTask(host, reopened.loaded, latest, {
        dueTime: reminder.dueTime,
        schedule: reminder.schedule,
        scheduleProject: reminder.scheduleProject,
      });
    }
    if (entry.task.schedule) {
      // Clear the link before deleting the reminder: the server removes todo
      // lines that still point at a deleted schedule, and a finished todo
      // should stay in the list while its reminder goes away.
      const saved = await updateTask(host, loaded, entry.task, {
        state: 'completed',
        done: todayISO(),
        schedule: '',
        scheduleProject: '',
        dueTime: '',
      });
      if (saved.ok) await callSchedules('DELETE', scheduleEndpoint(entry.task.scheduleProject || state.projectId, entry.task.schedule)).catch(() => null);
      return saved;
    }
    return updateTask(host, loaded, entry.task, {
      state: 'completed',
      done: todayISO(),
    });
  });
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

const scheduleEndpoint = (projectId: string, taskID = ''): string =>
  `/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks${taskID ? `/${encodeURIComponent(taskID)}` : ''}`;

const callSchedules = async (
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  body?: ScheduledWrite,
): Promise<ScheduledListResponse | null> => {
  const init: ScheduleRequest = { method, path };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await host.request(init);
  if (response.status >= 400) throw new Error(`计划任务接口返回 ${response.status}`);
  const parsed: ScheduledListResponse | null = response.body ? JSON.parse(response.body) : null;
  return parsed;
};

/** Create, update or delete the reminder behind a task, keeping the board in step. */
const syncReminderForTask = async (
  task: Task,
  title: string,
  due: string,
  dueTime: string,
): Promise<{ schedule: string; dueTime: string; scheduleProject: string }> => {
  const projectId = task.scheduleProject || state.projectId;
  if (!due) {
    if (task.schedule) await callSchedules('DELETE', scheduleEndpoint(projectId, task.schedule)).catch(() => null);
    return { schedule: '', dueTime: '', scheduleProject: '' };
  }
  const time = dueTime || '09:00';
  const list = await callSchedules('GET', scheduleEndpoint(projectId));
  const existing = (list?.tasks ?? []).find((entry) => entry.id === task.schedule);
  const execution = existing?.execution ?? { kind: 'notify', useDefaults: true };
  const payload = {
    name: title,
    enabled: true,
    schedule: { kind: 'once' as const, date: due, time },
    execution: { kind: execution.kind ?? 'notify', useDefaults: execution.useDefaults ?? true, prompt: title },
  };
  if (task.schedule) payload.id = task.schedule;
  const saved = await callSchedules('PUT', scheduleEndpoint(projectId), { task: payload });
  const id = saved?.task?.id ?? '';
  if (!id) throw new Error('计划任务没有返回 id');
  return { schedule: id, dueTime: time, scheduleProject: projectId };
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
  if (task.due) {
    const day = relativeDay(task.due, todayISO());
    meta.append(el('span', `due${isOverdue(task) ? ' late' : ''}`, task.dueTime ? `${day} ${task.dueTime}` : day));
  }
  if (task.schedule) meta.append(el('span', 'tag', '定时'));
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
      cell.append(el('i', `dot${byDate.has(iso) ? '' : ' dot-off'}`));
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
  cell.append(el('i', `dot${entries && entries.length > 0 ? '' : ' dot-off'}`));
  cell.addEventListener('click', () => {
    calendarDay = iso === calendarDay ? null : iso;
    render();
  });
  return cell;
};

const deliverableDate = (mtime: number): string =>
  new Date(mtime).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });

const thumbnailCache = new Map<string, string | null>();

const loadThumbnail = (item: Deliverable, image: HTMLImageElement, fallback: HTMLElement): void => {
  if (!host.thumbnailFile) return;
  const key = `${item.path}:${item.mtime}`;
  const cached = thumbnailCache.get(key);
  if (cached !== undefined) {
    if (cached) {
      image.src = cached;
      image.hidden = false;
      fallback.hidden = true;
    }
    return;
  }
  void host.thumbnailFile(item.path).then((url) => {
    thumbnailCache.set(key, url);
    if (!url || !image.isConnected) return;
    image.src = url;
    image.hidden = false;
    fallback.hidden = true;
  }).catch(() => thumbnailCache.set(key, null));
};

const latestSessionForProject = (projectId: string): GuestSessionRecord | undefined =>
  mergeSessions(state.sessions, state.creationSessions).find((session) => (
    session.projectId === projectId && !session.parentId && !session.archivedAt
  ));

const revealDeliverable = async (item: Deliverable): Promise<void> => {
  try {
    await host.openFile(item.path);
  } catch {
    try {
      await host.writeClipboard(item.path);
      hostNotice.show('文件打不开，已复制路径。');
    } catch {
      hostNotice.show('文件打不开。', 'error');
    }
  }
};

const loadDeliverables = async (): Promise<void> => {
  try {
    state.deliverables = await collectDeliverables(host, state.projects);
    state.deliverablesError = '';
  } catch (error) {
    state.deliverables = [];
    state.deliverablesError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
};

const refreshDeliverables = async (): Promise<void> => {
  // A new work is a new project; reload the list so refresh can find it.
  const projects = await host.listProjects().catch(() => null);
  if (projects) state.projects = projects.projects;
  await Promise.all([loadCreationSessions(), loadDeliverables()]);
};

const renderDeliverables = (): HTMLElement => {
  const panel = el('section', 'panel deliverables');
  const head = el('div', 'panel-head');
  const refresh = el('button', 'chip', '刷新');
  refresh.type = 'button';
  refresh.addEventListener('click', () => {
    void refreshDeliverables().then(() => render());
  });
  head.append(el('h2', '', '最近成果'), el('div', 'panel-meta', `${state.deliverables.length} 个文件`), refresh);
  panel.append(head);
  if (state.deliverablesError) panel.append(el('div', 'empty', `成果读取失败：${state.deliverablesError}`));
  if (state.deliverables.length === 0) {
    panel.append(el('div', 'empty', '完成一份文档、PPT、视频或网页后，成果文件会出现在这里。'));
    return panel;
  }
  const rows = el('div', 'rows');
  for (const item of state.deliverables) {
    const card = el('div', 'deliverable deliverable-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.title = `${item.path}\n点击直接打开交付物。`;
    const extension = item.name.slice(item.name.lastIndexOf('.') + 1).toUpperCase();
    const thumb = el('div', 'deliverable-thumb');
    const kind = el('span', 'deliverable-kind', extension);
    kind.dataset.kind = extension.toLowerCase();
    const fallback = el('div', 'deliverable-fallback');
    fallback.append(kind, el('span', 'deliverable-fallback-label', item.category || '文件'));
    const image = new Image();
    image.className = 'deliverable-image';
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.hidden = true;
    image.addEventListener('error', () => {
      image.hidden = true;
      fallback.hidden = false;
    });
    const copy = el('button', 'deliverable-copy', '复制');
    copy.type = 'button';
    copy.title = '复制文件路径';
    copy.setAttribute('aria-label', '复制文件路径');
    copy.addEventListener('click', (event) => {
      event.stopPropagation();
      void host.writeClipboard(item.path).then(() => hostNotice.show('文件路径已复制。')).catch(() => hostNotice.show('复制失败。', 'error'));
    });
    thumb.append(image, fallback, copy);
    const main = el('div', 'deliverable-body');
    main.append(el('div', 'title', item.name));
    main.append(el('div', 'meta-line', [item.category, item.projectName, item.folder, deliverableDate(item.mtime)].filter(Boolean).join(' · ')));
    card.append(thumb, main);
    card.addEventListener('click', () => void revealDeliverable(item));
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      void revealDeliverable(item);
    });
    rows.append(card);
    loadThumbnail(item, image, fallback);
  }
  panel.append(rows);
  return panel;
};

const contextProjectId = (): string => {
  const project = state.projects.find((entry) => entry.id === state.projectId);
  const directory = project?.directory?.replace(/\\/g, '/').replace(/\/+$/, '').trim() ?? '';
  if (!directory) return '';
  const bytes = new TextEncoder().encode(directory);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `path_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
};

type ProjectContextWrite = { body: string };
type ContextRequest = { method: 'GET' | 'POST' | 'DELETE' | 'PATCH'; path: string; body?: string };

const contextRequest = async (
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  suffix: string,
  payload?: ProjectContextWrite,
): Promise<ProjectContextView | null> => {
  const projectId = contextProjectId();
  if (!projectId) throw new Error('no-project');
  const init: ContextRequest = {
    method,
    path: `/api/project-context/${projectId}${suffix}`,
  };
  if (payload !== undefined) init.body = JSON.stringify(payload);
  const result = await host.request(init);
  if (result.status >= 400) throw new Error(`project-context ${result.status}`);
  const parsed: ProjectContextView | null = result.body ? JSON.parse(result.body) : null;
  return parsed;
};

const loadContext = async (): Promise<void> => {
  try {
    const data = await contextRequest('GET', '');
    state.context = {
      notes: Array.isArray(data?.notes) ? data.notes : [],
      todos: Array.isArray(data?.todos) ? data.todos : [],
      plans: Array.isArray(data?.plans) ? data.plans : [],
    };
    state.contextError = '';
  } catch {
    state.context = null;
    state.contextError = '读不到项目笔记，先在右侧面板写一条试试。';
  }
  render();
};

const NOTE_TINTS = ['#f0d488', '#cfe4c7', '#cfdff2', '#f2d2d2'];
const NOTES_COLLAPSED_KEY = 'oc.workbench.notesCollapsed';

let notesCollapsed = false;
try {
  notesCollapsed = localStorage.getItem(NOTES_COLLAPSED_KEY) === '1';
} catch {
  notesCollapsed = false;
}

const setNotesCollapsed = (value: boolean): void => {
  notesCollapsed = value;
  try {
    localStorage.setItem(NOTES_COLLAPSED_KEY, value ? '1' : '0');
  } catch {
    // A sandbox without storage still gets the toggle for this page's life.
  }
  render();
};

/** A stable paper colour per note, so a note keeps its sticky colour across loads. */
const noteTint = (id: string): string => {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return NOTE_TINTS[hash % NOTE_TINTS.length];
};

const renderNotes = (): HTMLElement => {
  const panel = el('section', notesCollapsed ? 'panel notes-panel is-collapsed' : 'panel notes-panel');
  const head = el('div', 'panel-head');
  const meta = el('div', 'panel-meta');
  meta.append(el('span', '', state.context ? `${state.context.notes.length} 条 · 与右侧同步` : '与右侧同步'));
  const toggle = el('button', 'note-toggle', notesCollapsed ? '展开' : '收起');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(!notesCollapsed));
  toggle.setAttribute('aria-label', notesCollapsed ? '展开笔记' : '收起笔记');
  toggle.addEventListener('click', () => setNotesCollapsed(!notesCollapsed));
  meta.append(toggle);
  head.append(el('h2', '', '笔记'), meta);
  panel.append(head);

  if (notesCollapsed) {
    // Collapsed is a pile of the same sticky notes, staggered: the newest on
    // top, the next two peeking out, one click to fan the board open again.
    const notes = state.context?.notes ?? [];
    const board = el('div', 'note-pile-board');
    board.tabIndex = 0;
    board.setAttribute('role', 'button');
    board.setAttribute('aria-label', '展开笔记');
    const expand = (): void => setNotesCollapsed(false);
    board.addEventListener('click', expand);
    board.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      expand();
    });
    for (const note of notes.slice(0, 3)) {
      const card = el('div', 'note note-pile-card');
      card.style.setProperty('--note-tint', noteTint(note.id));
      const copy = el('div', 'note-copy');
      copy.append(el('div', 'note-body', note.body));
      copy.append(el('div', 'note-meta', new Date(note.createdAt).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })));
      card.append(copy);
      board.append(card);
    }
    if (notes.length === 0) {
      board.append(el('div', 'note-pile-empty', state.contextError || '还没有笔记，点开写一张。'));
    } else if (notes.length > 3) {
      board.append(el('span', 'note-pile-count', `+${notes.length - 3}`));
    }
    panel.append(board);
    return panel;
  }

  // A sticky note you write on, not a search field with a button: Enter sticks
  // it, Shift+Enter writes a second line.
  const form = el('div', 'note-composer');
  const input = el('textarea');
  input.rows = 2;
  input.placeholder = '写点什么，回车贴上';
  input.setAttribute('aria-label', '新笔记');
  input.value = state.noteDraft;
  input.addEventListener('input', () => { state.noteDraft = input.value; });
  const actions = el('div', 'note-composer-row');
  actions.append(el('span', 'note-hint', '回车贴上 · Shift+回车换行'));
  const add = el('button', 'note-stick', '贴上');
  add.type = 'button';
  actions.append(add);
  const submit = async (): Promise<void> => {
    const body = state.noteDraft.trim();
    if (!body || state.contextBusy) return;
    state.contextBusy = true;
    add.disabled = true;
    try {
      await contextRequest('POST', '/notes', { body });
      state.noteDraft = '';
      await loadContext();
    } catch {
      hostNotice.show('笔记没保存上，稍后再试。', 'error');
    } finally {
      state.contextBusy = false;
      add.disabled = false;
    }
  };
  add.addEventListener('click', () => void submit());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });
  form.append(input, actions);
  panel.append(form);

  const list = el('div', 'notes-list');
  if (state.contextError) {
    list.append(el('div', 'empty', state.contextError));
  } else if (!state.context) {
    list.append(el('div', 'empty', '正在读取项目笔记…'));
  } else if (state.context.notes.length === 0) {
    list.append(el('div', 'empty', '还没有笔记。'));
  }
  for (const note of state.context?.notes ?? []) {
    const row = el('div', 'note');
    row.style.setProperty('--note-tint', noteTint(note.id));
    const copy = el('div', 'note-copy');
    copy.append(el('div', 'note-body', note.body));
    copy.append(el('div', 'note-meta', new Date(note.createdAt).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })));
    const remove = el('button', 'note-del', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', '删除笔记');
    remove.addEventListener('click', () => {
      void (async () => {
        remove.disabled = true;
        try {
          await contextRequest('DELETE', `/notes/${encodeURIComponent(note.id)}`);
          await loadContext();
        } catch {
          remove.disabled = false;
          hostNotice.show('没删掉，稍后再试。', 'error');
        }
      })();
    });
    row.append(copy, remove);
    list.append(row);
  }
  panel.append(list);
  return panel;
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
  const sessions = mergeSessions(state.sessions, state.creationSessions);
  const running = sessions.filter((session) => session.activity === 'running' || session.activity === 'retrying');
  const recent = sessions.slice(0, 4);

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
  // One chip per kind: the workbench says what can be made, not just that a
  // creation page exists.
  const createEntries = [
    { label: '写文档', kind: 'doc' },
    { label: '做 PPT', kind: 'deck' },
    { label: '做演示视频', kind: 'video' },
    { label: '做网页', kind: 'page' },
  ] as const;
  for (const entry of createEntries) {
    const chip = el('button', 'chip', entry.label);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      void host.openPage('openchamber-builtin-creation', entry.kind).catch(() => {
        hostNotice.show('没能开始，稍后再点一次。', 'warn');
      });
    });
    chips.append(chip);
  }
  const taskChip = el('button', 'chip', '创建任务');
  taskChip.type = 'button';
  taskChip.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) {
      input.focus();
      hostNotice.show('先在输入框写下要做的事，再点创建任务。', 'warn');
      return;
    }
    startTaskSession(text);
  });
  chips.append(taskChip);
  row.append(startButton, chips);
  composer.append(row);

  // 创建任务 opens a session whose agent files the task with the OpenChamber
  // task.create action; the workbench only hands over what the user wrote.
  const startTaskSession = (text: string): void => {
    const title = text.split('\n')[0].slice(0, 80);
    const instruction = [
      '请把下面这句话整理成一条任务，并调用 openchamber 工具的 task.create 动作写入任务列表：',
      '',
      text,
      '',
      '要求：',
      '- 必须用 openchamber 工具的 task.create，不要用 openchamber_knowledge 的 todo：后者写的是项目知识面板，不是工作台的任务列表。',
      '- taskTitle 用用户要做的这件事，简洁但保留关键信息。',
      '- 用户明确说了日期或时间才填 taskDue（YYYY-MM-DD 或 YYYY-MM-DDTHH:mm）；没说就不要补。\n- 只说了日期时会在当天 09:00 提醒；说了具体时间就用那个时间。',
      '- 创建后只说明已加入任务列表，不要重复整段内容。',
    ].join('\n');
    void host.startSession({
      providerId: 'workbench',
      id: '任务',
      title,
      url: 'https://superwagie.local/task',
      text: instruction.slice(0, 16_000),
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
  const shown = new Map<string, GuestSessionRecord>();
  for (const session of [...running.slice(0, 3), ...recent]) shown.set(session.id, session);
  for (const session of shown.values()) {
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
  // Tasks are the workbench's todo list; notes sit beside them. There is no
  // second todo module here: the right panel is the project's knowledge view.
  const workRow = el('div', 'notes-row');
  workRow.append(renderTaskList(), renderNotes());
  rowA.append((() => { const main = el('div', 'main-col'); main.append(composer, workRow, renderDeliverables()); return main; })(), side);
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


interface SegOption { value: string; label: string }

/** A small segmented control; these pages do not use native selects. */
const segmented = (
  value: string,
  options: SegOption[],
  onChange: (value: string) => void,
  ariaLabel: string,
): HTMLElement => {
  const group = el('div', 'seg');
  let current = value;
  group.dataset.value = current;
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', ariaLabel);
  const paint = (): void => {
    for (const node of group.children) {
      if (node instanceof HTMLElement) {
        node.setAttribute('aria-pressed', String(node.dataset.value === current));
      }
    }
  };
  for (const option of options) {
    const button = el('button', '', option.label);
    button.type = 'button';
    button.dataset.value = option.value;
    button.addEventListener('click', () => {
      if (option.value === current) return;
      current = option.value;
      group.dataset.value = current;
      paint();
      onChange(current);
    });
    group.append(button);
  }
  paint();
  return group;
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
  const stateSelect = segmented(
    task.state,
    TASK_STATES.map((value) => ({ value, label: stateLabel[value] })),
    () => {},
    '状态',
  );
  stateField.append(stateSelect);

  const priorityField = el('div', 'field');
  priorityField.append(el('label', '', '优先级'));
  const prioritySelect = segmented(
    task.priority,
    [{ value: 'low', label: '低' }, { value: 'normal', label: '普通' }, { value: 'high', label: '高' }],
    () => {},
    '优先级',
  );
  priorityField.append(prioritySelect);

  const dueField = el('div', 'field');
  dueField.append(el('label', '', '截止'));
  const duePair = el('div', 'field-pair');
  const dueInput = el('input');
  dueInput.type = 'date';
  dueInput.value = task.due;
  const dueTimeInput = el('input');
  dueTimeInput.type = 'time';
  dueTimeInput.value = task.dueTime;
  duePair.append(dueInput, dueTimeInput);
  dueField.append(duePair);
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
  let removeArmed = false;
  removeBtn.addEventListener('click', () => {
    if (!removeArmed) {
      removeArmed = true;
      removeBtn.textContent = '再点一次删除';
      return;
    }
    const loaded = loadedFor(entry.scope);
    if (!loaded) return;
    state.selection = null;
    void withWrite(async () => {
      if (task.schedule) {
        // Deleting the schedule also removes this task line on the server, so
        // reload before deciding whether a local delete is still needed.
        await callSchedules('DELETE', scheduleEndpoint(task.scheduleProject || state.projectId, task.schedule)).catch(() => null);
        const latest = await loadTasks(host, entry.scope).catch(() => null);
        const current = latest?.tasks.find((candidate) => candidate.id === task.id) ?? null;
        return latest && current ? deleteTask(host, latest, current) : { ok: true };
      }
      return deleteTask(host, loaded, task);
    });
  });
  actions.append(removeBtn);

  const save = el('button', 'btn primary', '保存');
  save.addEventListener('click', () => {
    if (!task.id) return;
    const title = titleInput.value.trim() || task.title;
    const due = dueInput.value;
    if (!due && dueTimeInput.value) {
      hostNotice.show('设了时间也要先选日期，否则提醒不会创建。', 'warn');
      return;
    }
    void withWrite(async () => {
      const loaded = loadedFor(entry.scope);
      if (!loaded) return { ok: false, reason: 'failed' };
      const patch = {
        title,
        note: noteInput.value,
        state: pick(TASK_STATES, stateSelect.dataset.value ?? '') ?? task.state,
        priority: pick(TASK_PRIORITIES, prioritySelect.dataset.value ?? '') ?? task.priority,
        due,
        done: stateSelect.dataset.value === 'completed' ? task.done || todayISO() : '',
      };
      if (!due) {
        // Drop the link first so the reminder delete cannot take this todo with
        // it, then remove the reminder.
        const saved = await updateTask(host, loaded, task, { ...patch, dueTime: '', schedule: '', scheduleProject: '' });
        if (saved.ok && task.schedule) {
          await callSchedules('DELETE', scheduleEndpoint(task.scheduleProject || state.projectId, task.schedule)).catch(() => null);
        }
        return saved;
      }
      const reminder = await syncReminderForTask(task, title, due, dueTimeInput.value);
      return updateTask(host, loaded, task, {
        ...patch,
        dueTime: reminder.dueTime,
        schedule: reminder.schedule,
        scheduleProject: reminder.scheduleProject,
      });
    });
  });

  actions.append(save);
  const meta = el('div', 'mono', `${entry.scope === 'global' ? '我的任务' : '项目任务'} · 第 ${task.line} 行${task.origin === 'agent' ? ' · 来自对话' : ''}`);
  editor.append(titleField, row, noteField, actions, meta);
  return editor;
};

const renderTaskList = (): HTMLElement => {
  const panel = el('section', 'panel');
  const head = el('div', 'panel-head');
  const titleWrap = el('div', 'panel-meta');
  const title = el('h2', '', '任务');
  const countChip = el('span', 'count-chip', '0');
  titleWrap.append(title, countChip);
  const filters = el('div', 'filter-row');
  const filter = segmented(
    state.filter,
    FILTERS.map(([value, label]) => ({ value, label })),
    (value) => {
      state.filter = pick(FILTERS.map(([entry]) => entry), value) ?? state.filter;
      render();
    },
    '筛选',
  );
  const priority = segmented(
    state.priority,
    [{ value: 'all', label: '不限' }, { value: 'high', label: '高' }, { value: 'normal', label: '普通' }, { value: 'low', label: '低' }],
    (value) => {
      state.priority = pick(FILTER_PRIORITIES, value) ?? state.priority;
      render();
    },
    '优先级',
  );
  const search = el('input');
  search.className = 'task-search';
  search.placeholder = '搜索任务';
  search.value = state.query;
  search.addEventListener('input', () => {
    state.query = search.value;
    paintRows();
  });
  filters.append(filter, priority);
  head.append(titleWrap, search);
  panel.append(head, filters);

  const rows = el('div', 'rows');
  // Typing in the search box repaints only the rows. Re-rendering the whole
  // panel would replace the input and drop focus after every character.
  const paintRows = (): void => {
    const visible = allTasks().filter(filterTask);
    countChip.textContent = String(visible.length);
    rows.replaceChildren();
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
  };
  paintRows();
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
  const copy = el('div', 'greeting-copy');
  copy.append(el('h1', '', `${salute}，${fact}`));
  copy.append(el('p', '', `${formatToday()} · 本周 ${weekDue} 件到期 · ${done} 件完成`));

  // The right of the title row reads like a line written in a daybook: a small
  // brand mark, one line, then who wrote it and the day.
  const soup = el('aside', 'soup');
  soup.setAttribute('aria-label', '每日毒鸡汤');
  // Quote and signature share one right-aligned line; the logo closes it.
  const line = el('p', 'soup-line');
  const quote = el('span', 'soup-quote', `“${soupFor(new Date())}”`);
  const sign = el('span', 'soup-sign');
  const logo = el('img', 'soup-logo');
  logo.src = 'brand-logo.png';
  logo.alt = '';
  sign.append(
    el('span', 'soup-name', `— ${SOUP_AUTHOR}`),
    el('span', 'soup-wordmark', 'SuperWagie'),
    el('span', 'soup-date', `· ${formatDate(todayISO())}`),
    el('span', 'soup-weather', weatherText ? ` · ${weatherText}` : ''),
    logo,
  );

  line.append(quote, sign);
  soup.append(line);
  head.append(copy, soup);
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

let weatherText = '';

// The daybook line's weather is optional: a failed or disabled read leaves the
// date alone instead of guessing.
const loadWeather = async (): Promise<void> => {
  try {
    const response = await host.request({ method: 'GET', path: '/api/weather' });
    if (response.status < 400) {
      const parsed: { weather?: { label?: string; temp?: string } | null } = JSON.parse(response.body);
      weatherText = parsed.weather?.label && parsed.weather.temp
        ? `${parsed.weather.label} ${parsed.weather.temp}`
        : '';
    } else {
      weatherText = '';
    }
  } catch {
    weatherText = '';
  }
  const node = document.querySelector('.soup-weather');
  if (node) node.textContent = weatherText ? ` · ${weatherText}` : '';
};

// Creation works are separate projects under the fixed root, so the active
// project's live list alone never contains them. Read each work's sessions
// once; the active work (if it is one) is already in `state.sessions`.
const loadCreationSessions = async (): Promise<void> => {
  const ids = creationProjectIds(state.projects);
  if (ids.length === 0) {
    state.creationSessions = [];
    return;
  }
  // A creation work's directory is not the one being watched, so its coverage
  // often stays "loading"; its sessions are still in the global projection and
  // must not be dropped. The live subscription, when ready, wins the merge.
  const snapshots = await Promise.all(ids.map((id) => host.listSessions(id).catch(() => null)));
  state.creationSessions = snapshots.flatMap((snapshot) => (snapshot ? snapshot.sessions : []));
};

const bootstrap = async (ready: HostReadyContext): Promise<void> => {
  state.ready = ready;
  const projects = await host.listProjects().catch(() => null);
  state.projects = projects?.projects ?? [];
  const active = ready.directory
    ? state.projects.find((project) => project.directory === ready.directory)
    : null;
  state.projectId = active?.id ?? state.projects[0]?.id ?? '';
  await Promise.all([
    loadTasks(host, 'global').then((loaded) => { state.global = loaded; }).catch(() => null),
    loadTasks(host, 'project').then((loaded) => { state.project = loaded; }).catch(() => null),
    connectSessions(),
    loadCreationSessions(),
    loadDeliverables(),
  ]);
  await loadContext();
  render();
  void loadWeather();
};

host.onSession(() => {
  // The open project can change with the session; the task file is read
  // relative to it, so reload rather than guess the id.
  void refresh();
});

host.onDirectory((directory) => {
  const project = directory ? state.projects.find((entry) => entry.directory === directory) : null;
  const nextId = project?.id ?? state.projects[0]?.id ?? '';
  if (nextId === state.projectId) return;
  state.projectId = nextId;
  void (async () => {
    await connectSessions();
    await loadCreationSessions();
    await refresh();
    await loadContext();
  })();
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
  // A page left open overnight gets the new day's line without a reload.
  const quote = document.querySelector('.soup-quote');
  if (quote) quote.textContent = `“${soupFor(new Date())}”`;
  const date = document.querySelector('.soup-date');
  if (date) date.textContent = `· ${formatDate(todayISO())}`;
}, 30_000);

// Edits made in the right panel land in the same files; refresh when the page
// comes back into view so both surfaces show one truth.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void loadContext();
});

window.addEventListener('pagehide', () => {
  host.dispose();
});
