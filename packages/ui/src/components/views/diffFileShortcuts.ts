import { useKeybinds } from '@/hooks/useKeybind';

/** Retained Changes views only navigate while visible and outside another input owner. */
export function useDiffFileShortcuts({ visible, files, currentPath, select }: {
  visible: boolean;
  files: readonly { path: string }[];
  currentPath: string | null | undefined;
  select: (path: string) => void;
}): void {
  const step = (event: KeyboardEvent, delta: -1 | 1): boolean | void => {
    if (!visible) return false;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable
      || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest('[role="dialog"]'))) return false;
    if (files.length === 0) return;
    const index = currentPath ? files.findIndex(file => file.path === currentPath) : -1;
    const next = files[index === -1 ? (delta > 0 ? 0 : files.length - 1) : index + delta];
    if (next) select(next.path);
  };
  useKeybinds({ diff_next_file: event => step(event, 1), diff_previous_file: event => step(event, -1) });
}
