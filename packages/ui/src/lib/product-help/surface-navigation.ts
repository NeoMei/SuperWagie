import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isGuestActive } from '@/lib/guests/capabilities';
import { useGuestsStore } from '@/lib/guests/store';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { isWorkflowEnabled } from '@/lib/workflows/availability';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

export type ProductHelpSurface = 'chat' | 'sessions' | 'scheduled-tasks' | 'worktrees' | 'workbench'
  | 'files' | 'terminal' | 'changes' | 'context' | 'workflows';

const PANEL_MODES = { files: 'file', terminal: 'terminal', changes: 'diff', context: 'context', workflows: 'workflows' } as const;
const WORKBENCH_ID = 'openchamber-builtin-workbench';

/** These destinations share the desktop/web shell. Other shells keep their own navigation. */
export function isProductHelpSurfaceSupported(surface: ProductHelpSurface): boolean {
  if (isVSCodeRuntime() || isMobileSurfaceRuntime()) return false;
  if (surface === 'workbench') {
    return useGuestsStore.getState().guests.some(guest => guest.id === WORKBENCH_ID && guest.pageEntry && isGuestActive(guest));
  }
  if (surface === 'worktrees') {
    const projects = useProjectsStore.getState();
    return projects.projects.some(project => project.id === projects.activeProjectId);
  }
  if (surface in PANEL_MODES) {
    return Boolean(resolveEffectiveDirectory()?.trim())
      && (surface !== 'workflows' || isWorkflowEnabled(useUIStore.getState()));
  }
  return true;
}

/** Opens a registered destination without clicking its controls or starting work. */
export function navigateProductHelpSurface(surface: ProductHelpSurface): boolean {
  if (!isProductHelpSurfaceSupported(surface)) return false;
  const ui = useUIStore.getState();
  ui.setSettingsDialogOpen(false);
  switch (surface) {
    case 'chat': ui.closeMainSurfaces(); break;
    case 'sessions': ui.setSidebarOpen(true); break;
    case 'scheduled-tasks': ui.setScheduledTasksDialogOpen(true); break;
    case 'worktrees': ui.setWorktreesPageProjectId(useProjectsStore.getState().activeProjectId); break;
    case 'workbench': ui.setOpenGuestPage(WORKBENCH_ID); break;
    default: {
      const directory = resolveEffectiveDirectory();
      if (!directory) return false;
      ui.closeMainSurfaces();
      ui.openContextPanelTab(normalizeContextPanelDirectoryKey(directory), { mode: PANEL_MODES[surface] });
    }
  }
  return true;
}
