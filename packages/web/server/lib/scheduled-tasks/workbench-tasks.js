import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const defaultDataDir = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

/**
 * The workbench is another view of the schedule: deleting it from the
 * scheduled tasks board removes the todo line that points at it, so the two
 * lists cannot drift apart. Files that do not exist are skipped.
 */
export const removeWorkbenchTasksForSchedule = async (scheduleID, projectPath, options = {}) => {
  if (!scheduleID) return 0;
  const dataDir = options.dataDir ?? defaultDataDir;
  const files = [path.join(dataDir, 'tasks.md')];
  if (projectPath) files.push(path.join(projectPath, '任务.md'));
  let removed = 0;
  for (const file of files) {
    let content;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const kept = lines.filter((line) => !(line.includes('"schedule"') && line.includes(scheduleID)));
    if (kept.length === lines.length) continue;
    removed += lines.length - kept.length;
    await fs.writeFile(file, kept.join('\n'), 'utf8');
  }
  return removed;
};
