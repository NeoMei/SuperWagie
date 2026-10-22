type OpenFileProject = { id: string; path: string };
type OpenFileTarget = { projectId: string; projectPath: string; filePath: string };

/** Resolve a guest file path to the deepest registered project that owns it. */
export const resolveOpenFileTarget = (
  filePath: string,
  projects: readonly OpenFileProject[],
): OpenFileTarget | null => {
  const path = filePath.trim();
  if ((!path.startsWith('/') && !/^[A-Za-z]:\//.test(path))
    || path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) return null;
  const owner = projects
    .filter((entry) => path.startsWith(`${entry.path.replace(/\/+$/, '')}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (!owner) return null;
  return {
    projectId: owner.id,
    projectPath: owner.path.replace(/\/+$/, ''),
    filePath: path,
  };
};
