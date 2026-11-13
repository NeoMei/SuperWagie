import { hasDesktopInvoke, invokeDesktop } from '@/lib/desktop';

/**
 * What Cmd/Ctrl+W closes in the desktop app.
 *
 * The window menu owns the shortcut, so the page cannot catch the key itself.
 * A surface with a tab of its own (a file open in Files) registers here; the
 * desktop shell is told whether one is registered, and while one is, the
 * shortcut arrives as an `openchamber:close-tab` event instead of closing the
 * window. A higher-priority covering page wins over file tabs; among equal
 * priorities the last registered surface wins.
 */
type CloseTarget = { close: () => void; priority: number };
const handlers: CloseTarget[] = [];
let listening = false;

const report = (): void => {
  if (!hasDesktopInvoke()) return;
  void invokeDesktop('desktop_set_close_tab_target', { active: handlers.length > 0 });
};

const handleCloseTab = (): void => {
  let target: CloseTarget | undefined;
  for (const candidate of handlers) {
    if (!target || candidate.priority >= target.priority) target = candidate;
  }
  target?.close();
};

export const registerCloseTabTarget = (close: () => void, priority = 0): (() => void) => {
  if (!listening) {
    window.addEventListener('openchamber:close-tab', handleCloseTab);
    listening = true;
  }
  const target = { close, priority };
  handlers.push(target);
  report();
  return () => {
    const index = handlers.lastIndexOf(target);
    if (index >= 0) handlers.splice(index, 1);
    report();
  };
};
