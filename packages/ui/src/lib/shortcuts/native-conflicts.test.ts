import { expect, test } from 'bun:test';
import { getProtectedNativeShortcutConflict, physicalShortcutCombo } from './native-conflicts';

test('fixed native owners cannot be replaced through a different registry action', () => {
  expect(getProtectedNativeShortcutConflict('save_file', 'mod+b', 'darwin')).toBe('mod+b');
  expect(getProtectedNativeShortcutConflict('new_window', 'ctrl+b', 'win32')).toBe('mod+b');
  expect(getProtectedNativeShortcutConflict('new_window', 'ctrl+b', 'darwin')).toBeUndefined();
  expect(getProtectedNativeShortcutConflict('new_window', 'mod+shift+f', 'linux')).toBe('mod+shift+f');
  expect(getProtectedNativeShortcutConflict('save_file', 'mod+b s', 'darwin')).toBe('mod+b');
  expect(getProtectedNativeShortcutConflict('save_file', 'mod+k b', 'darwin')).toBeUndefined();
  expect(getProtectedNativeShortcutConflict('open_command_palette', 'mod+p', 'darwin')).toBeUndefined();
});

test('physical equality resolves aliases and duplicate primary modifiers on each platform', () => {
  expect(physicalShortcutCombo('mod+ctrl+b', 'win32')).toBe(physicalShortcutCombo('ctrl+b', 'win32'));
  expect(physicalShortcutCombo('cmd+option+u', 'darwin')).toBe(physicalShortcutCombo('mod+alt+u', 'darwin'));
  expect(physicalShortcutCombo('mod+plus', 'darwin')).toBe(physicalShortcutCombo('mod+shift+=', 'darwin'));
});
