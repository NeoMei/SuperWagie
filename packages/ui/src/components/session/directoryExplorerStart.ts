const toSlashes = (value: string): string => value.trim().replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Where the add-project picker starts: the folder holding the most recently
 * added project, since a new project usually sits beside the previous ones.
 * Home when there is none. Windows homes retain their drive or network path;
 * Unix homes use `~/...` shorthand.
 */
export const initialBrowseQuery = (
  projects: ReadonlyArray<{ path: string; addedAt?: number }>,
  homeDirectory: string,
): string => {
  const home = toSlashes(homeDirectory);
  const windowsHome = /^[a-z]:(\/|$)/i.test(home) || home.startsWith('//');
  const homeQuery = windowsHome ? `${home}/` : '~/';
  let latest: { path: string; addedAt?: number } | null = null;
  for (const project of projects) {
    if (!project.path.trim()) continue;
    if (!latest || (project.addedAt ?? 0) >= (latest.addedAt ?? 0)) latest = project;
  }
  if (!latest) return homeQuery;
  const path = toSlashes(latest.path);
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (!parent) return homeQuery;
  if (home && parent === home) return homeQuery;
  if (!windowsHome && home && parent.startsWith(`${home}/`)) return `~${parent.slice(home.length)}/`;
  return `${parent}/`;
};
