import { describe, expect, it, vi } from 'vitest';
import { activateDirectory } from './directory.js';

const deps = (overrides = {}) => ({
  validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
  readSettingsFromDisk: vi.fn(async () => ({ projects: [] })),
  sanitizeProjects: (projects) => projects,
  persistSettings: vi.fn(async (settings) => settings),
  ...overrides,
});

describe('activateDirectory', () => {
  it('reuses an existing project and keeps its metadata', async () => {
    const project = { id: 'existing', path: '/projects/existing', addedAt: 1, lastOpenedAt: 2 };
    const dependencies = deps({ readSettingsFromDisk: vi.fn(async () => ({ projects: [project] })) });
    const result = await activateDirectory(dependencies, '/projects/existing');
    expect(result.projectId).toBe('existing');
    expect(result.settings.projects).toEqual([project]);
  });

  it('surfaces the validator error without persisting', async () => {
    const dependencies = deps({ validateDirectoryPath: vi.fn(async () => ({ ok: false, error: 'not a directory' })) });
    await expect(activateDirectory(dependencies, '/nope')).rejects.toThrow('not a directory');
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });
});
