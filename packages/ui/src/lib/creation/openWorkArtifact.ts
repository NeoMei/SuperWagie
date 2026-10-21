import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getFileExtension } from '@/lib/toolHelpers';
import { latestArtifactPath } from './latestArtifact';

const OUTPUT_EXTENSIONS = new Set(['docx', 'doc', 'pdf', 'pptx', 'ppt', 'xlsx', 'xls', 'mp4', 'mov', 'html', 'htm']);
const OUTPUT_FOLDERS = new Set(['导出', '交付']);
const SKIP_FOLDERS = new Set([
  'generation', 'planning', 'jobs', 'images', 'assets', 'output', 'node_modules',
  '.git', '.superppt', 'dist', 'build', 'renders',
]);

type FoundFile = { path: string; name: string; mtime: number };

const openFileInPanel = (path: string, directory: string): boolean => {
  const project = useProjectsStore.getState().projects
    .filter((entry) => path.startsWith(`${entry.path.replace(/\/+$/, '')}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (project) useProjectsStore.getState().setActiveProject(project.id);
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return false;
  // The workbench and other guest pages cover the chat and its context panel.
  useUIStore.getState().setOpenGuestPage(null);
  useUIStore.getState().openContextFile(project?.path ?? directory, path, { preview: true });
  return true;
};

/**
 * Open the newest deliverable of a work, preferring the path named in the
 * session's final answer. The folder convention is only the fallback for a
 * session whose messages have not loaded yet.
 */
export const openLatestWorkArtifact = async (directory: string, sessionId?: string | null): Promise<boolean> => {
  if (sessionId) {
    const named = latestArtifactPath(sessionId, directory);
    if (named && openFileInPanel(named, directory)) return true;
  }
  const files = getRegisteredRuntimeAPIs()?.files;
  if (!files?.listDirectory) return false;
  const found: FoundFile[] = [];
  const walk = async (path: string, depth: number, output: boolean): Promise<void> => {
    const listing = await files.listDirectory(path).catch(() => null);
    if (!listing) return;
    for (const entry of listing.entries) {
      if (entry.isDirectory) {
        if (depth >= 4 || entry.name.startsWith('.')) continue;
        const nextOutput = output || OUTPUT_FOLDERS.has(entry.name);
        if (!nextOutput && SKIP_FOLDERS.has(entry.name)) continue;
        await walk(entry.path, depth + 1, nextOutput);
        continue;
      }
      if (!output && depth > 0) continue;
      if (!OUTPUT_EXTENSIONS.has(getFileExtension(entry.name))) continue;
      found.push({ path: entry.path, name: entry.name, mtime: entry.modifiedTime ?? 0 });
    }
  };
  await walk(directory, 0, false);
  const newest = found.sort((left, right) => right.mtime - left.mtime)[0];
  return newest ? openFileInPanel(newest.path, directory) : false;
};
