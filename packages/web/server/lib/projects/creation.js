import path from 'node:path';
import { z } from 'zod';

const CATEGORIES = { doc: '文档', deck: 'PPT', video: '视频', page: '网页' };
const briefSchema = z.string().min(1);

class CreationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'CreationError';
    this.statusCode = statusCode;
  }
}

const projectTitle = (value) => {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    // After the slice, so a title of dots and spaces cannot leave a hidden folder.
    .replace(/^[.\s]+/, '');
  return cleaned || '未命名';
};

const dateOf = (date) => {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

/**
 * Build the folder for a new project under `~/Documents/SuperWagie/<category>/`,
 * write the brief as `需求.md`, and activate it. The title and date name the
 * folder; the caller never composes a path, so a crafted title can only change
 * the leaf name and never the category root.
 */
export const createCreationProject = async ({ fsPromises, homedir, activate, kind, title, brief, now = new Date() }) => {
  if (!Object.hasOwn(CATEGORIES, kind)) throw new CreationError('unknown-kind');
  const category = CATEGORIES[kind];
  const parsedBrief = briefSchema.safeParse(brief);
  if (!parsedBrief.success) throw new CreationError('brief-required');

  const folder = `${projectTitle(title)} ${dateOf(now)}`;
  const base = path.join(homedir(), 'Documents', 'SuperWagie', category);
  let target = path.join(base, folder);
  let claimed = false;
  try {
    await fsPromises.mkdir(base, { recursive: true });
    // Claim a leaf exclusively, so two creators of the same title never share one folder.
    for (let suffix = 1; !claimed; suffix += 1) {
      if (suffix > 99) throw new CreationError('too-many-duplicates');
      try {
        await fsPromises.mkdir(target);
        claimed = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        target = path.join(base, `${folder}-${suffix + 1}`);
      }
    }
    await fsPromises.writeFile(path.join(target, '需求.md'), parsedBrief.data, 'utf8');
  } catch (error) {
    if (claimed) await fsPromises.rm(target, { recursive: true, force: true }).catch(() => {});
    if (error instanceof CreationError) throw error;
    throw new CreationError('create-failed', 500);
  }

  try {
    const activated = await activate(target);
    return { path: activated.path ?? target, projectId: activated.projectId };
  } catch (error) {
    // Only this call's own new folder is removed; an existing one is never touched.
    if (claimed) await fsPromises.rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
};
