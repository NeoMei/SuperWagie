/**
 * Markdown task model.
 *
 * A task is one GFM checkbox line plus a trailing `<!-- sw {...} -->` block for
 * the fields Markdown has no syntax for. Everything else on the line is kept
 * byte for byte, so a file edited outside the app stays readable and unknown
 * metadata survives a round trip.
 */

import { z } from 'zod';

export type TaskState = 'planned' | 'in_progress' | 'waiting' | 'blocked' | 'completed' | 'cancelled';
/** Who created the task. Who does it is decided while working, not stored. */
export type TaskOrigin = 'user' | 'agent';
export type TaskPriority = 'low' | 'normal' | 'high';

export interface Task {
  /** Stable id from the metadata block; null until the task is first edited in the app. */
  id: string | null;
  title: string;
  note: string;
  state: TaskState;
  origin: TaskOrigin;
  priority: TaskPriority;
  /** ISO date (YYYY-MM-DD), or empty. */
  due: string;
  /** HH:mm for the reminder that runs on the due date, or empty. */
  dueTime: string;
  /** Linked OpenChamber session id, or empty. */
  session: string;
  /** Scheduled reminder id when the task has a due time, or empty. */
  schedule: string;
  /** ISO date the task was completed, or empty. */
  done: string;
  /** 1-based line number in the source file. */
  line: number;
  /** Original line text, for issues and round-trip checks. */
  raw: string;
}

export interface TaskIssue {
  line: number;
  reason: string;
  raw: string;
}

export interface ParsedTasks {
  tasks: Task[];
  issues: TaskIssue[];
  /** Heading each task sits under, keyed by task line. */
  sections: Map<number, string>;
}

export const TASK_STATES: readonly TaskState[] = ['planned', 'in_progress', 'waiting', 'blocked', 'completed', 'cancelled'];
export const TASK_ORIGINS: readonly TaskOrigin[] = ['user', 'agent'];
export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high'];
// Older files used a status called inbox; it now reads as planned.
const LEGACY_STATES: readonly string[] = ['inbox'];

const TASK_LINE = /^(\s*)([-*+]) \[([ xX])\]\s+(.*)$/;
const META_BLOCK = /\s*<!--\s*sw\s+(\{[\s\S]*\})\s*-->\s*$/;

type MetaValue = string | number | boolean;
type TaskMeta = Record<string, MetaValue>;

const metaSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

const parseMeta = (text: string): TaskMeta | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = metaSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const textOf = (value: MetaValue | undefined): string => z.string().safeParse(value).data ?? '';
const stateOf = (value: MetaValue | undefined): TaskState | undefined => TASK_STATES.find((state) => state === value);
const originOf = (value: MetaValue | undefined): TaskOrigin | undefined => TASK_ORIGINS.find((origin) => origin === value);
const priorityOf = (value: MetaValue | undefined): TaskPriority | undefined => TASK_PRIORITIES.find((priority) => priority === value);

/** FNV-1a, enough to tell "the file changed under us" apart from "it did not". */
export const contentHash = (content: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

export const newTaskId = (now = Date.now(), random = Math.random): string => {
  const time = now.toString(36);
  const noise = Math.floor(random() * 0x100000000).toString(36).padStart(6, '0');
  return `tsk_${time}_${noise}`;
};

export const parseTasks = (content: string): ParsedTasks => {
  const tasks: Task[] = [];
  const issues: TaskIssue[] = [];
  const sections = new Map<number, string>();
  let section = '';

  content.split('\n').forEach((raw, index) => {
    const line = index + 1;
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      section = heading[1].trim();
      return;
    }

    const match = TASK_LINE.exec(raw);
    if (!match) return;
    sections.set(line, section);

    const checked = match[3].toLowerCase() === 'x';
    let body = match[4].trim();
    let meta: TaskMeta = {};
    const metaMatch = META_BLOCK.exec(body);
    if (metaMatch) {
      const parsed = parseMeta(metaMatch[1]);
      if (!parsed) {
        issues.push({ line, reason: '任务元数据不是有效的 JSON', raw });
        tasks.push({
          id: null,
          title: body.slice(0, metaMatch.index).trim(),
          note: '',
          state: checked ? 'completed' : 'planned',
          origin: 'user',
          priority: 'normal',
          due: '',
          dueTime: '',
          session: '',
          schedule: '',
          done: '',
          line,
          raw,
        });
        return;
      }
      meta = parsed;
      body = body.slice(0, metaMatch.index).trim();
    }

    const declaredState = textOf(meta.state);
    const state = stateOf(meta.state)
      ?? (LEGACY_STATES.includes(declaredState) ? 'planned' : checked ? 'completed' : 'planned');
    tasks.push({
      id: textOf(meta.id).trim() || null,
      title: body,
      note: textOf(meta.note),
      state,
      origin: originOf(meta.origin) ?? 'user',
      priority: priorityOf(meta.priority) ?? 'normal',
      due: textOf(meta.due),
      dueTime: textOf(meta.dueTime),
      session: textOf(meta.session),
      schedule: textOf(meta.schedule),
      done: textOf(meta.done),
      line,
      raw,
    });
  });

  return { tasks, issues, sections };
};

/** Metadata written back: known fields first, unknown keys from the source line after. */
const metaFor = (task: Task, previous: TaskMeta): string => {
  const meta: TaskMeta = {};
  if (task.id) meta.id = task.id;
  meta.state = task.state;
  meta.origin = task.origin;
  // Dropped fields from older files.
  delete meta.owner;
  if (task.priority !== 'normal') meta.priority = task.priority;
  if (task.due) meta.due = task.due;
  if (task.dueTime) meta.dueTime = task.dueTime;
  if (task.session) meta.session = task.session;
  if (task.schedule) meta.schedule = task.schedule;
  if (task.note) meta.note = task.note;
  if (task.done) meta.done = task.done;
  // Fields the user just cleared stay cleared; everything else unknown is
  // carried over so older files keep metadata this version does not know.
  const clearable = new Set(['due', 'dueTime', 'schedule']);
  for (const [key, value] of Object.entries(previous)) {
    if (key in meta || clearable.has(key)) continue;
    meta[key] = value;
  }
  return JSON.stringify(meta);
};

const renderLine = (task: Task, previous: TaskMeta, indent = '', marker = '-'): string => {
  const checkbox = task.state === 'completed' ? 'x' : ' ';
  const meta = metaFor(task, previous);
  return `${indent}${marker} [${checkbox}] ${task.title}${meta !== '{}' ? ` <!-- sw ${meta} -->` : ''}`;
};

const previousMetaOf = (raw: string): TaskMeta => {
  const match = META_BLOCK.exec(raw);
  return match ? parseMeta(match[1]) ?? {} : {};
};

const indentOf = (raw: string): string => {
  const match = TASK_LINE.exec(raw);
  return match?.[1] ?? '';
};

const markerOf = (raw: string): string => {
  const match = TASK_LINE.exec(raw);
  return match?.[2] ?? '-';
};

/** Replace one task line, leaving every other byte alone. */
export const patchTask = (content: string, updated: Task): string => {
  const lines = content.split('\n');
  const index = updated.line - 1;
  if (index < 0 || index >= lines.length) return content;
  lines[index] = renderLine(updated, previousMetaOf(lines[index]), indentOf(lines[index]), markerOf(lines[index]));
  return lines.join('\n');
};

/** Add a task at the end of the file. Missing trailing newlines are normalized. */
export const appendTask = (content: string, task: Task): string => {
  const body = content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
  return `${body}${renderLine(task, {})}\n`;
};

export const removeTask = (content: string, line: number): string => {
  const lines = content.split('\n');
  if (line < 1 || line > lines.length) return content;
  lines.splice(line - 1, 1);
  return lines.join('\n');
};

/** Lines that hold a task, for conflict checks and tests. */
export const taskLineNumbers = (content: string): number[] =>
  content.split('\n').flatMap((line, index) => (TASK_LINE.test(line) ? [index + 1] : []));

export const isTaskLine = (line: string): boolean => TASK_LINE.test(line);

export const todayISO = (now = new Date()): string => {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const isOverdue = (task: Task, today = todayISO()): boolean =>
  Boolean(task.due) && task.state !== 'completed' && task.state !== 'cancelled' && task.due < today;

export const isDueToday = (task: Task, today = todayISO()): boolean =>
  Boolean(task.due) && task.state !== 'completed' && task.state !== 'cancelled' && task.due === today;

export const isDoneThisWeek = (task: Task, today = todayISO()): boolean => {
  if (!task.done) return false;
  const date = new Date(`${today}T00:00:00`);
  const offset = (date.getDay() + 6) % 7;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const done = new Date(`${task.done}T00:00:00`);
  return done >= monday && done <= sunday;
};

export const isDueThisWeek = (task: Task, today = todayISO()): boolean => {
  if (!task.due || task.state === 'completed' || task.state === 'cancelled') return false;
  const start = new Date(`${today}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const due = new Date(`${task.due}T00:00:00`);
  return due >= start && due < end;
};
