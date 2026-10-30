import os from 'node:os';

// Do not let the invoking shell redirect checkout operations to another Git
// directory, worktree, index or injected config.
export function knowledgeGitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  // Git for Windows rejects Node's \\.\nul device path as a config filename.
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull, GIT_NO_REPLACE_OBJECTS: '1' };
}
