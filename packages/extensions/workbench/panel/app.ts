import { t, setWorkbenchLocale, workbenchLocale, weekdayLabels, categoryLabel, weatherLabel, type WorkbenchMessage } from './i18n.ts';
import {
  connectHost,
  type GuestProject,
  type GuestSessionRecord,
  type HostReadyContext,
} from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { z } from 'zod';

import { isDoneThisWeek, isDueThisWeek, isDueToday, isOverdue, todayISO, TASK_PRIORITIES, TASK_STATES, type Task } from './model.ts';
import { deleteTask, loadTasks, updateTask, type LoadedTasks, type TaskScope } from './store.ts';
import { el, formatDate, installStyles, notice, relativeDay } from './shared.ts';
import { soupAuthor, soupFor } from './soup.ts';
import { preserveFormState } from './locale-render.ts';
import { collectDeliverables, type Deliverable } from './deliverables.ts';
import { creationProjectIds, mergeSessions } from './sessions.ts';
import { installNoteReorder } from './note-reorder.ts';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('缺少根节点');

type Selection = { scope: TaskScope; id: string };

interface WorkbenchNote {
  id: string;
  body: string;
  createdAt: number;
}

const WORKBENCH_NOTES_KEY = 'oc.workbench.notes';
const workbenchNotesSchema = z.array(z.object({
  id: z.string().min(1),
  body: z.string().min(1),
  createdAt: z.number(),
}));

const loadWorkbenchNotes = (): WorkbenchNote[] => {
  try {
    const stored = localStorage.getItem(WORKBENCH_NOTES_KEY);
    if (!stored) return [];
    const parsed = workbenchNotesSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};

let notesPersistence: 'local' | 'loading' | 'device' | 'failed' = 'local';
let noteSaveRevision = 0;
let noteSaveStatus: 'idle' | 'saving' | 'failed' = 'idle';
const notesSaveError = (): string => t('notesSaveFailed');
const noteSaveLabel = (): string => noteSaveStatus === 'saving' ? t('notesSaving')
  : noteSaveStatus === 'failed' ? t('notesNotSaved') : '';
const updateNoteSaveStatus = (): void => {
  const label = document.querySelector('.note-save-state');
  if (label) label.textContent = noteSaveLabel();
};

const saveWorkbenchNotes = (notes: WorkbenchNote[]): void => {
  try {
    localStorage.setItem(WORKBENCH_NOTES_KEY, JSON.stringify(notes));
  } catch {
    // A sandbox without storage keeps the notes for this page's life.
  }
  if (notesPersistence !== 'device') return;
  // Send each snapshot immediately so no writes wait in a disappearing frame.
  // The device host orders its IndexedDB readwrite transactions. An older
  // reply must not replace the latest save's visible status.
  const snapshot = notes.map(({ id, body, createdAt }) => ({ id, body, createdAt }));
  const revision = ++noteSaveRevision;
  noteSaveStatus = 'saving';
  updateNoteSaveStatus();
  void host.storage.set(WORKBENCH_NOTES_KEY, snapshot, { scope: 'device' }).then(() => {
      if (revision !== noteSaveRevision) return;
      noteSaveStatus = 'idle';
      updateNoteSaveStatus();
      if (noticeCopy === notesSaveError) {
        noticeCopy = null;
        hostNotice.clear();
      }
    })
    .catch(() => {
      if (revision !== noteSaveRevision) return;
      noteSaveStatus = 'failed';
      updateNoteSaveStatus();
      showNotice(notesSaveError, 'error');
    });
};

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
  notes: WorkbenchNote[];
  noteDraft: string;
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
  notes: loadWorkbenchNotes(),
  noteDraft: '',
};

const hostNotice = notice();
let noticeCopy: (() => string) | null = null;
const showNotice = (copy: () => string, tone: 'info' | 'warn' | 'error' = 'info'): void => {
  noticeCopy = copy;
  hostNotice.show(copy(), tone);
};

const restoreDeviceNotes = async (): Promise<void> => {
  notesPersistence = 'loading';
  try {
    const stored = await host.storage.get(WORKBENCH_NOTES_KEY, { scope: 'device' });
    if (stored !== undefined) {
      const parsed = workbenchNotesSchema.safeParse(stored);
      if (!parsed.success) throw new Error('Invalid saved sticky notes');
      state.notes = parsed.data;
    }
    notesPersistence = 'device';
    if (stored === undefined && state.notes.length > 0) saveWorkbenchNotes(state.notes);
  } catch {
    // An unread snapshot must not be replaced by an empty fallback or local
    // copy. Keep it read-only until the workbench is reopened successfully.
    notesPersistence = 'failed';
    showNotice(() => t('notesLoadFailed'), 'error');
  }
  preserveFormState(root, render);
};

let calendarMonth = new Date();
calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
let calendarOpen = false;
let calendarDay: string | null = null;

const scopeLabel = (scope: TaskScope): string => (scope === 'global' ? t('myTasks') : t('project'));

const STATE_LABEL_KEYS = {
  planned: 'state.planned',
  in_progress: 'state.inProgress',
  waiting: 'state.waiting',
  blocked: 'state.blocked',
  completed: 'state.completed',
  cancelled: 'state.cancelled',
} satisfies Record<Task['state'], WorkbenchMessage>;
const stateLabel = (value: Task['state']): string => t(STATE_LABEL_KEYS[value]);

const pick = <T extends string>(values: readonly T[], value: string): T | undefined =>
  values.find((entry) => entry === value);

const FILTERS = [
  ['all', 'filter.all'],
  ['open', 'filter.open'],
  ['done', 'state.completed'],
  ['today', 'filter.today'],
  ['week', 'thisWeek'],
] as const;
type FilterValue = (typeof FILTERS)[number][0];
const FILTER_PRIORITIES = ['all', 'high', 'normal', 'low'] as const;
type FilterPriority = (typeof FILTER_PRIORITIES)[number];

const allTasks = (): Array<{ task: Task; scope: TaskScope }> => [
  ...(state.global?.tasks ?? []).map((task) => ({ task, scope: 'global' as const })),
  ...(state.project?.tasks ?? []).map((task) => ({ task, scope: 'project' as const })),
];

const isOpen = (task: Task): boolean => task.state !== 'completed' && task.state !== 'cancelled';

const loadedFor = (scope: TaskScope): LoadedTasks | null => (scope === 'global' ? state.global : state.project);

const refresh = async (): Promise<void> => {
  const revision = directoryRevision;
  const directory = contextDirectory;
  const [global, project] = await Promise.all([
    loadTasks(host, 'global').catch(() => null),
    loadTasks(host, 'project').catch(() => null),
  ]);
  if (revision !== directoryRevision || directory !== contextDirectory) return;
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
      showNotice(() =>
        result.reason === 'conflict'
          ? t('writeConflict')
          : t('writeFailed'),
        'error',
      );
      return;
    }
    noticeCopy = null;
    hostNotice.clear();
    await refresh();
  } catch (error) {
    showNotice(() => t('operationFailed', { error: error instanceof Error ? error.message : String(error) }), 'error');
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
      id: t('taskLabel'),
      title: task.title,
      url: `https://superwagie.local/task/${encodeURIComponent(task.id ?? '')}`,
      text: [task.title, task.note].filter(Boolean).join('\n\n').slice(0, 16_000),
      projectId,
      navigation: 'open',
    });
    if (!result.sessionId) {
      showNotice(() => t('sessionUnavailable'), 'warn');
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
  if (response.status >= 400) throw new Error(t('scheduleFailed', { status: response.status }));
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
  if (!id) throw new Error(t('scheduleMissingId'));
  return { schedule: id, dueTime: time, scheduleProject: projectId };
};

const formatClock = (): string => new Date().toLocaleTimeString(workbenchLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const formatDay = (): string => {
  const weekday = new Date().toLocaleDateString(workbenchLocale(), { weekday: 'long' });
  return `${formatDate(todayISO())} ${weekday}`;
};

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
  box.setAttribute('aria-label', task.state === 'completed' ? t('markIncomplete') : t('markComplete'));
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
  if (task.schedule) meta.append(el('span', 'tag', t('scheduled')));
  if (task.state === 'blocked' || task.state === 'waiting') meta.append(el('span', stateLabel(task.state)));
  if (task.origin === 'agent') meta.append(el('span', 'origin', t('fromChat')));
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
  const panel = el('section', `panel calendar${calendarOpen || calendarDay ? ' cal-expanded' : ''}`);
  const head = el('div', 'panel-head');
  const title = el('h2', '', t('calendar'));
  const meta = el('div', 'panel-meta');
  const toggle = el('button', 'chip', calendarOpen ? t('week') : t('month'));
  toggle.style.padding = '3px 9px';
  toggle.style.fontSize = '12px';
  toggle.setAttribute('aria-label', calendarOpen ? t('showWeek') : t('showMonth'));
  meta.append(
    el('span', 'cal-month', calendarOpen ? calendarMonth.toLocaleDateString(workbenchLocale(), { month: 'long' }) : t('thisWeek')),
    toggle,
  );
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
    const nav = el('div', 'cal-nav');
    nav.append(prev, next);
    panel.append(nav);
    const grid = el('div', 'month');
    for (const dow of weekdayLabels()) grid.append(el('div', 'cal-dow', dow));
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
      cell.append(el('span', '', weekdayLabels()[index]));
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
    if (entries.length === 0) list.append(el('div', 'empty', t('noTasksOnDay')));
    for (const entry of entries.slice(0, 4)) {
      const item = el('button', '', entry.task.title);
      item.addEventListener('click', () => {
        if (!entry.task.id) return;
        state.selection = { scope: entry.scope, id: entry.task.id };
        render();
      });
      list.append(item);
    }
    if (entries.length > 4) list.append(el('div', 'empty', t('more', { count: entries.length - 4 })));
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
  new Date(mtime).toLocaleDateString(workbenchLocale(), { month: 'numeric', day: 'numeric' });

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

const revealDeliverable = async (item: Deliverable): Promise<void> => {
  try {
    await host.openFile(item.path);
  } catch {
    try {
      await host.writeClipboard(item.path);
      showNotice(() => t('fileCopiedFallback'));
    } catch {
      showNotice(() => t('fileOpenFailed'), 'error');
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
  const refresh = el('button', 'chip', t('refresh'));
  refresh.type = 'button';
  refresh.addEventListener('click', () => {
    void refreshDeliverables().then(() => render());
  });
  head.append(el('h2', '', t('recentResults')), el('div', 'panel-meta', t('fileCount', { count: state.deliverables.length })), refresh);
  panel.append(head);
  if (state.deliverablesError) panel.append(el('div', 'empty', t('resultsFailed', { error: state.deliverablesError })));
  if (state.deliverables.length === 0) {
    panel.append(el('div', 'empty', t('noResults')));
    return panel;
  }
  const rows = el('div', 'rows');
  for (const item of state.deliverables) {
    const card = el('div', 'deliverable deliverable-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.title = `${item.path}\n${t('openDeliverable')}`;
    const extension = item.name.slice(item.name.lastIndexOf('.') + 1).toUpperCase();
    const thumb = el('div', 'deliverable-thumb');
    const kind = el('span', 'deliverable-kind', extension);
    kind.dataset.kind = extension.toLowerCase();
    const fallback = el('div', 'deliverable-fallback');
    fallback.append(kind, el('span', 'deliverable-fallback-label', categoryLabel(item.category) || t('file')));
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
    const copy = el('button', 'deliverable-copy', t('copy'));
    copy.type = 'button';
    copy.title = t('copyPath');
    copy.setAttribute('aria-label', t('copyPath'));
    copy.addEventListener('click', (event) => {
      event.stopPropagation();
      void host.writeClipboard(item.path).then(() => showNotice(() => t('pathCopied'))).catch(() => showNotice(() => t('copyFailed'), 'error'));
    });
    thumb.append(image, fallback, copy);
    const main = el('div', 'deliverable-body');
    main.append(el('div', 'title', item.name));
    main.append(el('div', 'meta-line', [categoryLabel(item.category), item.projectName, item.folder === '根目录' ? t('rootFolder') : item.folder, deliverableDate(item.mtime)].filter(Boolean).join(' · ')));
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

let stopNoteReorder: (() => void) | null = null;

const moveWorkbenchNote = (activeId: string, targetId: string): void => {
  if (notesPersistence === 'loading' || notesPersistence === 'failed') return;
  const from = state.notes.findIndex((note) => note.id === activeId);
  const to = state.notes.findIndex((note) => note.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  const notes = [...state.notes];
  const [note] = notes.splice(from, 1);
  if (!note) return;
  notes.splice(to, 0, note);
  state.notes = notes;
  saveWorkbenchNotes(notes);
  const scrollTop = document.querySelector('.notes-list')?.scrollTop ?? 0;
  preserveFormState(root, render);
  const list = document.querySelector('.notes-list');
  if (list) list.scrollTop = scrollTop;
  for (const row of document.querySelectorAll<HTMLElement>('.notes-list .note')) {
    if (row.dataset.noteId === activeId) row.querySelector<HTMLButtonElement>('.note-drag')?.focus({ preventScroll: true });
  }
};

const renderNotes = (): HTMLElement => {
  const panel = el('section', notesCollapsed ? 'panel notes-panel is-collapsed' : 'panel notes-panel');
  const head = el('div', 'panel-head');
  const meta = el('div', 'panel-meta');
  meta.append(el('span', '', t('notesCount', { count: state.notes.length })));
  const saveState = el('span', 'note-save-state', noteSaveLabel());
  saveState.setAttribute('aria-live', 'polite');
  meta.append(saveState);
  const toggle = el('button', 'note-toggle', notesCollapsed ? t('expand') : t('collapse'));
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(!notesCollapsed));
  toggle.setAttribute('aria-label', notesCollapsed ? t('expandNotes') : t('collapseNotes'));
  toggle.addEventListener('click', () => setNotesCollapsed(!notesCollapsed));
  meta.append(toggle);
  head.append(el('h2', '', t('stickyNotes')), meta);
  panel.append(head);

  if (notesCollapsed) {
    // Collapsed uses the same manual order, with the first note on top.
    const notes = state.notes;
    const board = el('div', 'note-pile-board');
    board.tabIndex = 0;
    board.setAttribute('role', 'button');
    board.setAttribute('aria-label', t('expandNotes'));
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
      copy.append(el('div', 'note-meta', new Date(note.createdAt).toLocaleString(workbenchLocale(), {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })));
      card.append(copy);
      board.append(card);
    }
    if (notes.length === 0) {
      board.append(el('div', 'note-pile-empty', t('noNotesCollapsed')));
    } else if (notes.length > 3) {
      board.append(el('span', 'note-pile-count', `+${notes.length - 3}`));
    }
    panel.append(board);
    return panel;
  }

  if (notesPersistence === 'loading') {
    panel.append(el('div', 'empty', t('notesLoading')));
    return panel;
  }
  const writable = notesPersistence !== 'failed';

  // A sticky note you write on, not a search field with a button: Enter sticks
  // it, Shift+Enter writes a second line.
  const form = el('div', 'note-composer');
  const input = el('textarea');
  input.rows = 2;
  input.placeholder = t('notePlaceholder');
  input.setAttribute('aria-label', t('newNote'));
  input.value = state.noteDraft;
  input.addEventListener('input', () => { state.noteDraft = input.value; });
  const actions = el('div', 'note-composer-row');
  actions.append(el('span', 'note-hint', t('noteKeyboardHint')));
  const add = el('button', 'note-stick', t('postNote'));
  add.type = 'button';
  add.disabled = !writable;
  actions.append(add);
  const submit = (): void => {
    if (!writable) return;
    const body = state.noteDraft.trim();
    if (!body) return;
    state.notes = [{
      id: `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      body,
      createdAt: Date.now(),
    }, ...state.notes];
    state.noteDraft = '';
    saveWorkbenchNotes(state.notes);
    render();
  };
  add.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  form.append(input, actions);
  panel.append(form);

  const list = el('div', 'notes-list');
  if (state.notes.length === 0) {
    list.append(el('div', 'empty', t('noNotes')));
  }
  for (const note of state.notes) {
    const row = el('div', 'note');
    row.dataset.noteId = note.id;
    row.style.setProperty('--note-tint', noteTint(note.id));
    const drag = el('button', 'note-drag', '⠿');
    drag.type = 'button';
    drag.disabled = !writable;
    drag.title = t('reorderNote');
    drag.setAttribute('aria-label', t('reorderNote'));
    const copy = el('div', 'note-copy');
    copy.append(el('div', 'note-body', note.body));
    copy.append(el('div', 'note-meta', new Date(note.createdAt).toLocaleString(workbenchLocale(), {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })));
    const remove = el('button', 'note-del', '×');
    remove.type = 'button';
    remove.disabled = !writable;
    remove.setAttribute('aria-label', t('deleteNote'));
    remove.addEventListener('click', () => {
      state.notes = state.notes.filter((entry) => entry.id !== note.id);
      saveWorkbenchNotes(state.notes);
      render();
    });
    row.append(drag, copy, remove);
    list.append(row);
  }
  stopNoteReorder = installNoteReorder(list, moveWorkbenchNote);
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
  input.placeholder = t('composerPlaceholder');
  input.setAttribute('aria-label', t('composerLabel'));
  composer.append(input);

  const row = el('div', 'composer-row');
  const startButton = el('button', 'primary', t('start'));
  const chips = el('div', 'toolbar');
  // One chip per kind: the workbench says what can be made, not just that a
  // creation page exists.
  const createEntries = [
    { label: t('creation.doc'), kind: 'doc' },
    { label: t('creation.deck'), kind: 'deck' },
    { label: t('creation.video'), kind: 'video' },
    { label: t('creation.page'), kind: 'page' },
  ] as const;
  for (const entry of createEntries) {
    const chip = el('button', 'chip', entry.label);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      void host.openPage('openchamber-builtin-creation', entry.kind).catch(() => {
        showNotice(() => t('creationFailed'), 'warn');
      });
    });
    chips.append(chip);
  }
  if (state.ready?.features?.projectDialog) {
    const projectChip = el('button', 'chip', t('createProject'));
    projectChip.type = 'button';
    projectChip.addEventListener('click', () => {
      void host.openProjectDialog().catch(() => {
        showNotice(() => t('projectDialogFailed'), 'warn');
      });
    });
    chips.append(projectChip);
  }
  const taskChip = el('button', 'chip', t('createTask'));
  taskChip.type = 'button';
  taskChip.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) {
      input.focus();
      showNotice(() => t('taskInputRequired'), 'warn');
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
    const instruction = t('taskPrompt', { text });
    void host.startSession({
      providerId: 'workbench',
      id: t('taskLabel'),
      title,
      url: 'https://superwagie.local/task',
      text: instruction.slice(0, 16_000),
      projectId: state.projectId || undefined,
      navigation: 'open',
    }).then((result) => {
      if (!result.sessionId) {
        showNotice(() => t('sessionNeedsProject'), 'warn');
        void host.toast({ kind: 'error', message: t('sessionNeedsProject') });
      }
    }).catch(() => {
      showNotice(() => t('sessionFailed'), 'error');
      void host.toast({ kind: 'error', message: t('sessionFailed') });
    });
  };

  const startWork = (): void => {
    const text = input.value.trim();
    if (!text) {
      showNotice(() => t('workInputRequired'), 'warn');
      return;
    }
    const title = text.split('\n')[0].slice(0, 80);
    void host.startSession({
      providerId: 'workbench',
      id: t('taskLabel'),
      title,
      url: 'https://superwagie.local/start',
      text: text.slice(0, 16_000),
      projectId: state.projectId || undefined,
      navigation: 'open',
    }).then((result) => {
      if (!result.sessionId) {
        showNotice(() => t('sessionNeedsProject'), 'warn');
        void host.toast({ kind: 'error', message: t('sessionNeedsProject') });
      }
    }).catch(() => {
      showNotice(() => t('sessionFailed'), 'error');
      void host.toast({ kind: 'error', message: t('sessionFailed') });
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
    count(t('today'), dueToday.length, dueToday.length > 0 ? t('count.due', { count: dueToday.length }) : t('count.noDue')),
    count(t('overdue'), overdue.length, overdue.length > 0 ? t('count.overdue', { count: overdue.length }) : t('count.noOverdue')),
    count(t('unscheduled'), unscheduled.length, unscheduled.length > 0 ? t('count.noDate') : t('count.allScheduled')),
    count(t('completedThisWeek'), weekDone.length, t('count.completed', { count: completed })),
  );
  side.append(renderCalendarCard(), sideCounts);

  const sessionPanel = el('section', 'panel sessions');
  const sessionHead = el('div', 'panel-head');
  sessionHead.append(el('h2', '', t('sessions')), el('div', 'panel-meta', t('recent')));
  sessionPanel.append(sessionHead);
  if (running.length > 0) sessionPanel.append(el('div', 'section-label', t('runningCount', { count: running.length })));
  const shown = new Map<string, GuestSessionRecord>();
  for (const session of [...running.slice(0, 3), ...recent]) shown.set(session.id, session);
  for (const session of shown.values()) {
    const item = el('div', 'task');
    item.tabIndex = 0;
    const main = el('div');
    main.append(el('div', 'title', session.title || t('untitledSession')));
    main.append(el('div', 'meta-line', new Date(session.updatedAt).toLocaleDateString(workbenchLocale())));
    item.append(main);
    item.addEventListener('click', () => void host.openSession(session.id));
    sessionPanel.append(item);
  }
  if (running.length === 0 && recent.length === 0) sessionPanel.append(el('div', 'empty', t('noSessions')));
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
  group.dataset.value = value;
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', ariaLabel);
  const paint = (): void => {
    for (const node of group.children) {
      if (node instanceof HTMLElement) {
        node.setAttribute('aria-pressed', String(node.dataset.value === group.dataset.value));
      }
    }
  };
  for (const option of options) {
    const button = el('button', '', option.label);
    button.type = 'button';
    button.dataset.value = option.value;
    button.addEventListener('click', () => {
      if (option.value === group.dataset.value) return;
      group.dataset.value = option.value;
      paint();
      onChange(option.value);
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
  editorHead.append(el('span', 'section-label', t('taskDetails')));
  const close = el('button', 'editor-close', '×');
  close.setAttribute('aria-label', t('closeTaskDetails'));
  close.addEventListener('click', () => {
    state.selection = null;
    render();
  });
  editorHead.append(close);
  editor.append(editorHead);

  const titleField = el('div', 'field');
  titleField.append(el('label', '', t('taskTitle')));
  const titleInput = el('input');
  titleInput.value = task.title;
  titleField.append(titleInput);

  const row = el('div', 'editor-row');
  const stateField = el('div', 'field');
  stateField.append(el('label', '', t('taskState')));
  const stateSelect = segmented(
    task.state,
    TASK_STATES.map((value) => ({ value, label: stateLabel(value) })),
    () => {},
    t('taskState'),
  );
  stateField.append(stateSelect);

  const priorityField = el('div', 'field');
  priorityField.append(el('label', '', t('priority')));
  const prioritySelect = segmented(
    task.priority,
    [{ value: 'low', label: t('priority.low') }, { value: 'normal', label: t('priority.normal') }, { value: 'high', label: t('priority.high') }],
    () => {},
    t('priority'),
  );
  priorityField.append(prioritySelect);

  const dueField = el('div', 'field');
  dueField.append(el('label', '', t('due')));
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
  noteField.append(el('label', '', t('description')));
  const noteInput = el('textarea');
  noteInput.value = task.note;
  noteField.append(noteInput);

  const actions = el('div', 'actions');
  const startBtn = el('button', 'btn primary', task.session ? t('anotherSession') : t('startSession'));
  startBtn.addEventListener('click', () => startSessionFor(entry));
  actions.append(startBtn);
  if (task.session) {
    const openBtn = el('button', 'btn', t('openSession'));
    openBtn.addEventListener('click', () => void host.openSession(task.session));
    actions.append(openBtn);
  }
  const doneBtn = el('button', 'btn', task.state === 'completed' ? t('markIncomplete') : t('markComplete'));
  doneBtn.addEventListener('click', () => toggleTask(entry));
  actions.append(doneBtn);
  const removeBtn = el('button', 'btn', t('deleteTask'));
  let removeArmed = false;
  removeBtn.addEventListener('click', () => {
    if (!removeArmed) {
      removeArmed = true;
      removeBtn.textContent = t('confirmDelete');
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

  const save = el('button', 'btn primary', t('save'));
  save.addEventListener('click', () => {
    if (!task.id) return;
    const title = titleInput.value.trim() || task.title;
    const due = dueInput.value;
    if (!due && dueTimeInput.value) {
      showNotice(() => t('dateRequired'), 'warn');
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
  const meta = el('div', 'mono', [t('taskLocation', { scope: entry.scope === 'global' ? t('myTasks') : t('projectTasks'), line: task.line }), task.origin === 'agent' ? t('fromChat') : ''].filter(Boolean).join(' · '));
  editor.append(titleField, row, noteField, actions, meta);
  return editor;
};

const renderTaskList = (): HTMLElement => {
  const panel = el('section', 'panel');
  const head = el('div', 'panel-head');
  const titleWrap = el('div', 'panel-meta');
  const title = el('h2', '', t('tasks'));
  const countChip = el('span', 'count-chip', '0');
  titleWrap.append(title, countChip);
  const filters = el('div', 'filter-row');
  const filter = segmented(
    state.filter,
    FILTERS.map(([value, key]) => ({ value, label: t(key) })),
    (value) => {
      state.filter = pick(FILTERS.map(([entry]) => entry), value) ?? state.filter;
      render();
    },
    t('filter'),
  );
  const priority = segmented(
    state.priority,
    [{ value: 'all', label: t('anyPriority') }, { value: 'high', label: t('priority.high') }, { value: 'normal', label: t('priority.normal') }, { value: 'low', label: t('priority.low') }],
    (value) => {
      state.priority = pick(FILTER_PRIORITIES, value) ?? state.priority;
      render();
    },
    t('priority'),
  );
  const search = el('input');
  search.className = 'task-search';
  search.placeholder = t('searchTasks');
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
    if (sorted.length === 0) rows.append(el('div', 'empty', t('noMatchingTasks')));
    for (const entry of sorted) {
      rows.append(renderTaskRow(entry));
      const selected = Boolean(state.selection && state.selection.scope === entry.scope && state.selection.id === entry.task.id && entry.task.id);
      if (selected) rows.append(renderTaskEditor(entry));
    }
    if (state.global && state.global.issues.length > 0) {
      rows.append(el('div', 'section-label', t('unreadableRows')));
      for (const issue of state.global.issues) rows.append(el('div', 'mono', t('parseIssue', { line: issue.line, error: issue.reason === '任务元数据不是有效的 JSON' ? t('invalidMetadata') : issue.reason })));
    }
  };
  paintRows();
  panel.append(rows);
  return panel;
};

const greeting = (): HTMLElement => {
  const hour = new Date().getHours();
  const salute = hour < 6 ? t('greeting.night') : hour < 12 ? t('greeting.morning') : hour < 18 ? t('greeting.afternoon') : t('greeting.evening');
  const tasks = allTasks();
  const today = todayISO();
  const due = tasks.filter((entry) => isDueToday(entry.task, today)).length;
  const late = tasks.filter((entry) => isOverdue(entry.task, today)).length;
  const unscheduled = tasks.filter((entry) => isOpen(entry.task) && !entry.task.due).length;
  const fact = late > 0
    ? t('greeting.overdue', { count: late })
    : due > 0
      ? t('greeting.due', { count: due })
      : unscheduled > 0
        ? t('greeting.unscheduled', { count: unscheduled })
        : t('noDueToday');
  const weekDue = tasks.filter((entry) => isDueThisWeek(entry.task, today)).length;
  const done = tasks.filter((entry) => entry.task.state === 'completed').length;
  const head = el('header', 'greeting');
  const copy = el('div', 'greeting-copy');
  copy.append(el('h1', '', t('greeting.heading', { salute, fact })));
  const summary = el('p', 'greeting-summary');
  summary.append(el('span', 'greeting-summary-copy', t('greeting.summary', { date: formatDay(), due: weekDue, done })));
  const clockItem = el('span', 'greeting-status');
  const clock = el('time', 'workbench-clock', formatClock());
  clock.dateTime = new Date().toISOString();
  clock.setAttribute('aria-label', t('currentTime'));
  clockItem.append(clock);
  const weatherItem = el('span', 'greeting-status workbench-weather', weatherText());
  weatherItem.hidden = !weather;
  summary.append(clockItem, weatherItem);

  // The right of the title row reads like a line written in a daybook: one
  // line, then who wrote it; the logo closes it.
  const soup = el('aside', 'soup');
  soup.setAttribute('aria-label', t('dailyQuote'));
  // Quote and signature share one right-aligned line; the logo closes it.
  const line = el('p', 'soup-line');
  const quote = el('span', 'soup-quote', `“${soupFor(new Date(), workbenchLocale())}”`);
  const sign = el('span', 'soup-sign');
  const logo = el('img', 'soup-logo');
  logo.src = 'brand-logo.png';
  logo.alt = '';
  sign.append(
    el('span', 'soup-name', `— ${soupAuthor(workbenchLocale())}`),
    el('span', 'soup-wordmark', workbenchLocale() === 'en' ? '' : 'SuperWagie'),
    logo,
  );

  line.append(quote, sign);
  soup.append(line);
  head.append(copy, summary, soup);
  return head;
};

const render = (): void => {
  if (!root) return;
  stopNoteReorder?.();
  stopNoteReorder = null;
  root.replaceChildren();
  installStyles();
  if (noticeCopy) hostNotice.element.textContent = noticeCopy();
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

let weather: { label: string; temp: string } | null = null;
const weatherText = (): string => weather ? `${weatherLabel(weather.label)} ${weather.temp}` : '';

// The daybook line's weather is optional: a failed or disabled read leaves the
// date alone instead of guessing.
const loadWeather = async (): Promise<void> => {
  try {
    const response = await host.request({ method: 'GET', path: '/api/weather' });
    if (response.status < 400) {
      const parsed: { weather?: { label?: string; temp?: string } | null } = JSON.parse(response.body);
      weather = parsed.weather?.label && parsed.weather.temp
        ? { label: parsed.weather.label, temp: parsed.weather.temp }
        : null;
    } else {
      weather = null;
    }
  } catch {
    weather = null;
  }
  const node = document.querySelector('.workbench-weather');
  if (node instanceof HTMLElement) {
    node.textContent = weatherText();
    node.hidden = !weather;
  }
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

let contextDirectory: string | null | undefined;
let directoryRevision = 0;
let lastSession: HostReadyContext['session'] = null;

/** Ready and directory events share one transition; locale-only ready is a no-op here. */
const changeDirectory = async (directory: string | null): Promise<void> => {
  if (directory === contextDirectory) return;
  contextDirectory = directory;
  const revision = ++directoryRevision;
  const projects = await host.listProjects().catch(() => null);
  if (revision !== directoryRevision) return;
  const nextProjects = projects?.projects ?? [];
  const active = directory ? nextProjects.find((project) => project.directory === directory) : null;
  state.projects = nextProjects;
  state.projectId = active?.id ?? nextProjects[0]?.id ?? '';
  const ids = creationProjectIds(nextProjects);
  const [globalTasks, projectTasks, snapshots, deliverables] = await Promise.all([
    loadTasks(host, 'global').catch(() => null),
    loadTasks(host, 'project').catch(() => null),
    Promise.all(ids.map((id) => host.listSessions(id).catch(() => null))),
    collectDeliverables(host, nextProjects).then(
      (items) => ({ items, error: '' }),
      (error) => ({ items: [], error: error instanceof Error ? error.message : String(error) }),
    ),
    connectSessions(),
  ]);
  if (revision !== directoryRevision) return;
  state.global = globalTasks;
  state.project = projectTasks;
  state.creationSessions = snapshots.flatMap((snapshot) => snapshot ? snapshot.sessions : []);
  state.deliverables = deliverables.items;
  state.deliverablesError = deliverables.error;
  render();
  void loadWeather();
};

host.onSession((session) => {
  if (session?.id === lastSession?.id && session?.busy === lastSession?.busy) return;
  lastSession = session;
  void refresh();
});

const updateDirectory = (directory: string | null): void => {
  void changeDirectory(directory).catch((error) => {
    showNotice(() => t('loadFailed', { error: error instanceof Error ? error.message : String(error) }), 'error');
    render();
  });
};

host.onDirectory(updateDirectory);

host.onReady((ready) => {
  applyHostReady(ready, document.documentElement);
  const firstReady = state.ready === null;
  const languageChanged = state.ready?.locale !== ready.locale;
  state.ready = ready;
  setWorkbenchLocale(ready.locale);
  document.title = t('title');
  if (firstReady && ready.features?.deviceStorage) void restoreDeviceNotes();
  if (contextDirectory !== ready.directory) {
    lastSession = ready.session;
    updateDirectory(ready.directory);
  } else if (!firstReady && languageChanged) {
    preserveFormState(root, render);
  }
});

setInterval(() => {
  const clock = document.querySelector('.workbench-clock');
  if (!clock) return;
  clock.textContent = formatClock();
  clock.dateTime = new Date().toISOString();
}, 1_000);

setInterval(() => {
  // A page left open overnight gets the new day's line without a reload.
  const quote = document.querySelector('.soup-quote');
  if (quote) quote.textContent = `“${soupFor(new Date(), workbenchLocale())}”`;
}, 30_000);

window.addEventListener('pagehide', () => {
  stopNoteReorder?.();
  host.dispose();
});
