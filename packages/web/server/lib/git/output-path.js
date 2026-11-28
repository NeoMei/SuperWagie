import path from 'node:path';

// MSYS2 Git reports drive paths such as /c/repos even when called from Node.
// Convert only Git's filesystem-path output, never repository-relative files.
export const normalizeGitOutputPath = (value, platform = process.platform) => {
  if (platform !== 'win32') return value;
  return value.replace(/^\/([a-z])(?:\/|$)/i, (_, drive) => `${drive.toUpperCase()}:/`);
};

export const resolveGitOutputPath = (cwd, value, platform = process.platform) =>
  (platform === 'win32' ? path.win32 : path.posix).resolve(cwd, normalizeGitOutputPath(value, platform));
