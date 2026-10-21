import { createProjectIdFromPath } from './project-id.js';

export class ProjectDirectoryError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ProjectDirectoryError';
    this.statusCode = statusCode;
  }
}

/**
 * Validate a directory, add it to the project list when it is new, and make it
 * active. The route and the creation service share this one activation path so
 * a folder the server creates for a new project lands in the list exactly as a
 * folder the user picked does.
 */
export const activateDirectory = async (
  { validateDirectoryPath, readSettingsFromDisk, sanitizeProjects, persistSettings },
  requestedPath,
) => {
  const validated = await validateDirectoryPath(requestedPath);
  if (!validated.ok) throw new ProjectDirectoryError(validated.error, 400);

  const resolvedPath = validated.directory;
  const currentSettings = await readSettingsFromDisk();
  const existingProjects = sanitizeProjects(currentSettings.projects) || [];
  const existing = existingProjects.find((project) => project.path === resolvedPath) || null;

  const nextProjects = existing
    ? existingProjects
    : [
        ...existingProjects,
        {
          id: createProjectIdFromPath(resolvedPath),
          path: resolvedPath,
          addedAt: Date.now(),
          lastOpenedAt: Date.now(),
        },
      ];

  const projectId = existing ? existing.id : nextProjects[nextProjects.length - 1].id;
  const settings = await persistSettings({
    projects: nextProjects,
    activeProjectId: projectId,
    lastDirectory: resolvedPath,
  });

  return { path: resolvedPath, projectId, settings };
};
