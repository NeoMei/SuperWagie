import path from 'node:path';

export const BEHAVIOR_FILE_NAME = 'AGENTS.md';

/**
 * The behavior file a fresh install starts with.
 *
 * OpenCode reads the global `AGENTS.md` on every session, so one seed here
 * reaches chat replies, reasoning and subagent reports. The text is deliberately
 * small: it states the language, not the product's workflow. A user who edits
 * or replaces the file keeps their version; this module only fills an absence.
 */
export const DEFAULT_BEHAVIOR = `## 语言

- 始终使用简体中文回答，包括思考过程、工具调用说明和子代理回报。
- 代码、命令、文件路径、标识符保持原样。
`;

const writeAtomically = async (fsPromises, filePath, content) => {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsPromises.writeFile(temporary, content, 'utf8');
    await fsPromises.rename(temporary, filePath);
  } catch (error) {
    await fsPromises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
};

/**
 * Seed the global behavior file when the user has none.
 *
 * An existing file, including an empty one, is never rewritten: the Behavior
 * page owns it from the first edit. A user who deletes it gets the default back
 * on the next start, which is what "default" means for a product file.
 *
 * @param {object} dependencies
 * @param {typeof import('node:fs/promises')} dependencies.fsPromises
 * @param {string} dependencies.configDir the OpenCode global config directory
 * @returns {Promise<{ written: boolean, path: string }>}
 */
export const ensureDefaultBehavior = async ({ fsPromises, configDir }) => {
  const filePath = path.join(configDir, BEHAVIOR_FILE_NAME);
  try {
    await fsPromises.access(filePath);
    return { written: false, path: filePath };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fsPromises.mkdir(configDir, { recursive: true });
  await writeAtomically(fsPromises, filePath, DEFAULT_BEHAVIOR);
  return { written: true, path: filePath };
};
