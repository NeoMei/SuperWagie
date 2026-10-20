import type { HostClient } from '@openchamber/sdk';

import {
  appendTask,
  contentHash,
  newTaskId,
  parseTasks,
  patchTask,
  removeTask,
  type Task,
  type TaskIssue,
} from './model.ts';

export const GLOBAL_TASKS_PATH = '~/.config/openchamber/tasks.md';
export const PROJECT_TASKS_FILE = '任务.md';

export type TaskScope = 'global' | 'project';

/** The host calls this module needs; the real `HostClient` satisfies it. */
export type TaskFileHost = Pick<HostClient, 'stat' | 'readFile' | 'writeFile'>;

export interface LoadedTasks {
  scope: TaskScope;
  path: string;
  content: string;
  exists: boolean;
  tasks: Task[];
  issues: TaskIssue[];
  hash: string;
}

export const emptyLoaded = (scope: TaskScope, path: string): LoadedTasks => ({
  scope,
  path,
  content: '',
  exists: false,
  tasks: [],
  issues: [],
  hash: contentHash(''),
});

const pathFor = (scope: TaskScope): string => (scope === 'global' ? GLOBAL_TASKS_PATH : PROJECT_TASKS_FILE);

/** Read one scope. A project without an open directory returns null rather than an empty list. */
export const loadTasks = async (host: TaskFileHost, scope: TaskScope): Promise<LoadedTasks | null> => {
  const path = pathFor(scope);
  const stat = await host.stat(path).catch(() => null);
  if (!stat) {
    // A project path needs an open project; a global path must be readable.
    if (scope === 'project') return null;
    throw new Error('读不到全局任务文件');
  }
  if (stat.kind === 'missing') return emptyLoaded(scope, path);
  if (stat.kind !== 'file') return null;
  try {
    const { content } = await host.readFile(path);
    const parsed = parseTasks(content);
    return { scope, path, content, exists: true, tasks: parsed.tasks, issues: parsed.issues, hash: contentHash(content) };
  } catch {
    if (scope === 'project') return null;
    throw new Error('读不到全局任务文件');
  }
};

/** Write back only when the file on disk is still the one we read. */
export const saveTasks = async (
  host: TaskFileHost,
  loaded: LoadedTasks,
  nextContent: string,
): Promise<{ ok: true; loaded: LoadedTasks } | { ok: false; reason: 'conflict' | 'failed' }> => {
  const stat = await host.stat(loaded.path).catch(() => null);
  const exists = Boolean(stat && stat.kind === 'file');
  if (exists !== loaded.exists) return { ok: false, reason: 'conflict' };
  if (exists) {
    const current = await host.readFile(loaded.path).catch(() => null);
    if (!current || contentHash(current.content) !== loaded.hash) return { ok: false, reason: 'conflict' };
  }
  try {
    await host.writeFile(loaded.path, nextContent);
  } catch {
    return { ok: false, reason: 'failed' };
  }
  const parsed = parseTasks(nextContent);
  return {
    ok: true,
    loaded: {
      ...loaded,
      content: nextContent,
      exists: true,
      tasks: parsed.tasks,
      issues: parsed.issues,
      hash: contentHash(nextContent),
    },
  };
};

export interface NewTaskInput {
  title: string;
  note?: string;
  state?: Task['state'];
  origin?: Task['origin'];
  priority?: Task['priority'];
  due?: string;
  session?: string;
  schedule?: string;
}

export const addTask = async (
  host: TaskFileHost,
  loaded: LoadedTasks,
  input: NewTaskInput,
): Promise<{ ok: true; loaded: LoadedTasks; task: Task } | { ok: false; reason: 'conflict' | 'failed' }> => {
  const task: Task = {
    id: newTaskId(),
    title: input.title.trim(),
    note: input.note?.trim() ?? '',
    state: input.state ?? 'planned',
    origin: input.origin ?? 'user',
    priority: input.priority ?? 'normal',
    due: input.due ?? '',
    session: input.session ?? '',
    schedule: input.schedule ?? '',
    done: '',
    line: 0,
    raw: '',
  };
  const next = appendTask(loaded.content, task);
  const saved = await saveTasks(host, loaded, next);
  if (!saved.ok) return saved;
  const [created] = saved.loaded.tasks.filter((entry) => entry.id === task.id);
  if (!created) return { ok: false, reason: 'failed' };
  return { ok: true, loaded: saved.loaded, task: created };
};

export const updateTask = async (
  host: TaskFileHost,
  loaded: LoadedTasks,
  task: Task,
  patch: Partial<Pick<Task, 'title' | 'note' | 'state' | 'origin' | 'priority' | 'due' | 'session' | 'done'>>,
): Promise<{ ok: true; loaded: LoadedTasks } | { ok: false; reason: 'conflict' | 'failed' }> => {
  const next: Task = { ...task, ...patch, id: task.id ?? newTaskId() };
  const saved = await saveTasks(host, loaded, patchTask(loaded.content, next));
  return saved.ok ? { ok: true, loaded: saved.loaded } : saved;
};

export const deleteTask = async (
  host: TaskFileHost,
  loaded: LoadedTasks,
  task: Task,
): Promise<{ ok: true; loaded: LoadedTasks } | { ok: false; reason: 'conflict' | 'failed' }> => {
  const saved = await saveTasks(host, loaded, removeTask(loaded.content, task.line));
  return saved.ok ? { ok: true, loaded: saved.loaded } : saved;
};
