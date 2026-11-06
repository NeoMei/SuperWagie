import { isDesktopShell } from '@/lib/desktop';
import { isMacOS, isWindows } from '@/lib/utils';
import { normalizeCombo } from './bindings';
import policy from './native-menu-policy.json';

type NativePlatform = 'darwin' | 'win32' | 'linux';

export const nativeShortcutPlatform = (): NativePlatform => isMacOS() ? 'darwin' : isWindows() ? 'win32' : 'linux';

export function physicalShortcutCombo(combo: string, platform: NativePlatform): string {
  return normalizeCombo(combo).split(' ').map(chord => [...new Set(chord.split('+').flatMap(part => {
    if (part === 'mod') return platform === 'darwin' ? 'super' : 'ctrl';
    return part === 'plus' ? ['shift', '='] : part;
  }))].sort().join('+')).join(' ');
}

/** Fixed menu owners cannot be released by replacing an in-app registry binding. */
export function getProtectedNativeShortcutConflict(actionId: string, combo: string, platform?: NativePlatform): string | undefined {
  if (!platform && !isDesktopShell()) return undefined;
  const targetPlatform = platform ?? nativeShortcutPlatform();
  const leader = physicalShortcutCombo(combo, targetPlatform).split(' ')[0];
  return policy.fixed.find(item => item.action !== actionId
    && (item.platform === 'all' || item.platform === targetPlatform
      || (item.platform === 'non-mac' && targetPlatform !== 'darwin')
      || (item.platform === 'non-win' && targetPlatform !== 'win32'))
    && physicalShortcutCombo(item.combo, targetPlatform) === leader)?.combo;
}

export function checksNativeOverrideConflicts(actionId: string): boolean {
  return Object.hasOwn(policy.defaults, actionId) || [
    'save_file', 'find_in_file', 'cycle_thinking_variant', 'sessions_bulk_delete', 'sessions_select_all',
    'permission_allow_once', 'permission_allow_always', 'permission_deny', 'diff_next_file', 'diff_previous_file',
  ].includes(actionId);
}
