import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_TITLE = 200;
const MAX_NOTE = 4000;

const text = (value, max) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw.length > max ? raw.slice(0, max) : raw;
};

const invalid = (message, status = 400) => {
  const error = new Error(message);
  error.statusCode = status;
  return error;
};

const parseDue = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?$/.exec(raw);
  if (!match) throw invalid('taskDue must be YYYY-MM-DD or YYYY-MM-DDTHH:mm');
  const [, date, time] = match;
  const parsed = new Date(`${date}T${time ?? '00:00'}:00`);
  if (Number.isNaN(parsed.getTime())) throw invalid('taskDue is not a valid date');
  return { date, time: time ?? null };
};

/**
 * Adds a todo to the workbench's Markdown file. A due date also creates the
 * built-in one-off reminder, so the list and the scheduler carry one task.
 * The reminder lands in the same project the task session runs in, which is
 * the scope the scheduled tasks board opens by default.
 */
export const createTask = async ({
  taskFile,
  input,
  directory,
  resolveProjectID,
  scheduledTaskService,
}) => {
  const title = text(input.taskTitle ?? input.title, MAX_TITLE);
  if (!title) throw invalid('taskTitle is required');
  const note = text(input.taskNote ?? input.note, MAX_NOTE);
  const priority = ['low', 'normal', 'high'].includes(input.taskPriority) ? input.taskPriority : 'normal';
  const due = parseDue(input.taskDue ?? input.due);

  // A date alone is still a plan the user expects to see in the scheduled
  // tasks board, so it gets a morning reminder; an explicit time wins.
  const reminderTime = due ? (due.time ?? '09:00') : '';
  let scheduleID = '';
  if (due) {
    const projectID = await resolveProjectID({
      projectId: text(input.projectId, 200) || undefined,
      directory: text(input.directory, 4096) || directory,
    });
    const created = await scheduledTaskService.upsert(projectID, {
      name: title,
      enabled: true,
      schedule: { kind: 'once', date: due.date, time: reminderTime },
      execution: { kind: 'notify', prompt: title, useDefaults: true },
    });
    scheduleID = created?.task?.id ?? '';
  }

  const id = `tsk_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const metadata = {
    id,
    state: 'planned',
    origin: 'agent',
    ...(priority !== 'normal' ? { priority } : {}),
    ...(due ? { due: due.date, dueTime: reminderTime } : {}),
    ...(scheduleID ? { schedule: scheduleID } : {}),
  };
  const line = `- [ ] ${title} <!-- sw ${JSON.stringify(metadata)} -->`;
  await fsp.mkdir(path.dirname(taskFile), { recursive: true });
  await fsp.appendFile(taskFile, `${line}\n`, 'utf8');

  return {
    task: {
      id,
      title,
      note,
      due: due?.date ?? '',
      dueTime: reminderTime,
      priority,
      scheduleId: scheduleID,
    },
  };
};
