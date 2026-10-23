import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { draftSpaceTarget, panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getFileExtension } from '@/lib/toolHelpers';
import { latestArtifactPath } from './latestArtifact';

const OUTPUT_EXTENSIONS = new Set(['docx', 'doc', 'pdf', 'pptx', 'ppt', 'xlsx', 'xls', 'mp4', 'mov', 'html', 'htm']);
const OUTPUT_FOLDERS = new Set(['导出', '交付']);
const SKIP_FOLDERS = new Set([
  'generation', 'planning', 'jobs', 'images', 'assets', 'output', 'node_modules',
  '.git', '.superppt', 'dist', 'build', 'renders',
]);

type FoundFile = { path: string; name: string; mtime: number };
type WorkArtifactOpenResult =
  | { opened: true }
  | { opened: false; reason: 'refused' }
  | { opened: false; reason: 'not-found'; panelDirectory: string; contentDirectory: string; canOpenFolder: () => boolean };

// Imperative equivalent of FilesView's hook inputs for the main chat. A
// pending space changes the content route, not the directory owning its tabs.
const currentPanel = () => {
  const directory = resolveEffectiveDirectory();
  const { currentSessionId, newSessionDraft } = useSessionUIStore.getState();
  const requestId = currentSessionId === null && newSessionDraft.open ? newSessionDraft.pendingWorktreeRequestId : null;
  const draftSpace = draftSpaceTarget(requestId, useSpacesStore.getState().journey);
  return { directory, contentDirectory: panelContentDirectory(draftSpace, directory) };
};

const fileExists = async (path: string, directory: string): Promise<boolean> => {
  const files = getRegisteredRuntimeAPIs()?.files;
  if (!files?.statFile) return true;
  return files.statFile(path, { directory }).then((stat) => stat.isFile).catch(() => false);
};

/**
 * Open the newest deliverable of a work, preferring the path named in the
 * session's final answer. The folder convention is only the fallback for a
 * session whose messages have not loaded yet.
 */
export const openLatestWorkArtifact = async (directory: string, sessionId?: string | null): Promise<WorkArtifactOpenResult> => {
  const panel = currentPanel();
  const panelDirectory = panel.directory;
  const contentDirectory = panel.contentDirectory;
  if (!panelDirectory || !contentDirectory) return { opened: false, reason: 'refused' };
  const runtimeKey = getRuntimeKey();
  const canOpen = (path: string) => {
    const current = currentPanel();
    return getRuntimeKey() === runtimeKey && current.directory === panelDirectory
      && current.contentDirectory === contentDirectory
      && spaceIdOfDirectory(contentDirectory) === spaceIdOfDirectory(path);
  };
  if (!canOpen(directory)) return { opened: false, reason: 'refused' };
  const openFileInPanel = (path: string): WorkArtifactOpenResult => {
    if (!canOpen(path) || path.lastIndexOf('/') <= 0) return { opened: false, reason: 'refused' };
    useUIStore.getState().setOpenGuestPage(null);
    useUIStore.getState().openContextFile(panelDirectory, path, { preview: true });
    return { opened: true };
  };
  if (sessionId) {
    const named = latestArtifactPath(sessionId, directory);
    if (named) {
      if (!canOpen(named)) return { opened: false, reason: 'refused' };
      const exists = await fileExists(named, directory);
      if (!canOpen(named)) return { opened: false, reason: 'refused' };
      if (exists) return openFileInPanel(named);
    }
  }
  const files = getRegisteredRuntimeAPIs()?.files;
  const notFound = (): WorkArtifactOpenResult => ({
    opened: false, reason: 'not-found', panelDirectory, contentDirectory, canOpenFolder: () => canOpen(directory),
  });
  if (!files?.listDirectory) return notFound();
  const found: FoundFile[] = [];
  let refused = false;
  const walk = async (path: string, depth: number, output: boolean): Promise<void> => {
    if (refused || !canOpen(path)) return;
    const listing = await files.listDirectory(path).catch(() => null);
    if (!listing || !canOpen(path)) return;
    for (const entry of listing.entries) {
      if (refused) return;
      if (!canOpen(entry.path)) { refused = true; return; }
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
  if (refused || !canOpen(directory)) return { opened: false, reason: 'refused' };
  const newest = found.sort((left, right) => right.mtime - left.mtime)[0];
  return newest ? openFileInPanel(newest.path) : notFound();
};
