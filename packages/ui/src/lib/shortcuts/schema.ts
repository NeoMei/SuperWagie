import { isDesktopShell } from '@/lib/desktop';
import { isMacOS } from '@/lib/utils';
import {
  getShortcutConflict,
  isValidShortcutCombo,
  isMenuAcceleratorCombo,
  normalizeCombo,
  parseShortcut,
  UNASSIGNED_SHORTCUT,
  type ShortcutCombo,
  type ShortcutConflict,
} from './bindings';
import { SHORTCUT_SCHEMA } from './config';
import { checksNativeOverrideConflicts, getProtectedNativeShortcutConflict, nativeShortcutPlatform, physicalShortcutCombo } from './native-conflicts';

export { SHORTCUT_SCHEMA } from './config';

export type ShortcutAction = (typeof SHORTCUT_SCHEMA)[number];
export type ShortcutActionId = ShortcutAction['id'];
export type ShortcutCategory = ShortcutAction['category'];
export type CustomizableShortcutAction = Extract<ShortcutAction, { customizable: true }>;
/** 'contextual-prefix' is kept in the union for the recording dialog's
    messaging even though no default layout produces it any more. */
export type ShortcutBindingConflictKind = ShortcutConflict | 'contextual-prefix';
export type ShortcutBindingConflict = {
  action: ShortcutAction;
  kind: ShortcutBindingConflictKind;
};

export function getShortcutAction(id: string): ShortcutAction | undefined {
  return SHORTCUT_SCHEMA.find((action) => action.id === id);
}

export function getCustomizableShortcutActions(): ReadonlyArray<CustomizableShortcutAction> {
  return SHORTCUT_SCHEMA.filter(
    (action): action is CustomizableShortcutAction => action.customizable,
  );
}

/** False for a native menu key on a runtime without that menu item. */
export function isShortcutAvailable(action: ShortcutAction): boolean {
  if (!('nativeMenu' in action)) return true;
  return isDesktopShell() && (action.nativeMenu === 'all' || !isMacOS());
}

export function isSingleChordShortcut(action: ShortcutAction): boolean {
  return 'singleChord' in action || 'nativeMenu' in action;
}

/** What the desktop app menu shows and listens to; empty means unassigned. */
export function getNativeMenuShortcutCombos(
  overrides?: Record<string, ShortcutCombo>,
): Record<string, ShortcutCombo> {
  const actions = SHORTCUT_SCHEMA.filter((action) => 'nativeMenu' in action);
  const combos = Object.fromEntries(actions
    .map((action) => [action.id, resolveShortcutCombo(action.id, overrides)]));
  // Imported snapshots can contain duplicate native keys. Retain raw settings,
  // but restore conflicting overrides before sending one atomic native snapshot.
  const platform = nativeShortcutPlatform();
  for (let pass = 0; pass < actions.length; pass += 1) {
    const occupied = new Map<string, typeof actions>();
    for (const action of actions) {
      if (platform === 'darwin' && action.nativeMenu === 'non-mac') continue;
      const combo = combos[action.id];
      if (!combo) continue;
      const key = physicalShortcutCombo(combo, platform);
      occupied.set(key, [...(occupied.get(key) ?? []), action]);
    }
    let changed = false;
    for (const group of occupied.values()) {
      if (group.length < 2) continue;
      for (const action of group) {
        if (combos[action.id] === action.defaultBinding) continue;
        combos[action.id] = action.defaultBinding;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return combos;
}

export function getEffectiveShortcutCombo(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (action && 'nativeMenu' in action) return getNativeMenuShortcutCombos(overrides)[actionId] ?? '';
  return resolveShortcutCombo(actionId, overrides);
}

function resolveShortcutCombo(actionId: string, overrides?: Record<string, ShortcutCombo>): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (!action) return '';
  const defaultBinding = action.defaultBinding === UNASSIGNED_SHORTCUT ? '' : action.defaultBinding;
  if (!action.customizable) return defaultBinding;

  const override = overrides?.[actionId];
  if (typeof override === 'string') {
    const normalized = normalizeCombo(override);
    if (normalized === UNASSIGNED_SHORTCUT) return '';
    if (isSingleChordShortcut(action) && parseShortcut(normalized)?.chords.length !== 1) return defaultBinding;
    if ('nativeMenu' in action && !isMenuAcceleratorCombo(override)) return defaultBinding;
    if (checksNativeOverrideConflicts(actionId) && getProtectedNativeShortcutConflict(actionId, normalized)) return defaultBinding;
    if (isValidShortcutCombo(normalized)) return normalized;
  }

  return defaultBinding;
}

export function getEffectiveShortcutPrefix(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (!action) return '';
  if (!action.customizable) return action.defaultBinding;

  const override = overrides?.[actionId];
  if (typeof override === 'string' && override.trim() !== '') {
    const normalized = normalizeCombo(override);
    if (normalized === UNASSIGNED_SHORTCUT) return UNASSIGNED_SHORTCUT;
    const chord = parseShortcut(normalized)?.chords[0];
    if (chord && (chord.modifiers.size > 0 || chord.key)) return normalized;
  }

  return action.defaultBinding;
}

export function getShortcutBindingConflicts(
  actionId: ShortcutActionId,
  combo: ShortcutCombo,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutBindingConflict[] {
  const conflicts: ShortcutBindingConflict[] = [];
  const action = getShortcutAction(actionId);
  if (!action) return conflicts;
  for (const candidate of SHORTCUT_SCHEMA) {
    if (candidate.id === actionId || !isShortcutAvailable(candidate)) continue;
    const candidateCombo = ('prefixStyle' in candidate && candidate.prefixStyle)
      ? getEffectiveShortcutPrefix(candidate.id, overrides)
      : getEffectiveShortcutCombo(candidate.id, overrides);
    const nativeConflict = isDesktopShell() && ('nativeMenu' in action || 'nativeMenu' in candidate);
    const platform = nativeShortcutPlatform();
    const kind = getShortcutConflict(
      nativeConflict ? physicalShortcutCombo(combo, platform) : combo,
      nativeConflict ? physicalShortcutCombo(candidateCombo, platform) : candidateCombo,
    );
    if (!kind) continue;
    conflicts.push({ action: candidate, kind });
  }
  return conflicts;
}
