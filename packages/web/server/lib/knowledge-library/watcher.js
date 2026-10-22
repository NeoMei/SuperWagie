/**
 * Directory watching for libraries.
 *
 * Events are a hint, never the truth: they mark a root dirty, a debounce turns
 * a burst of saves into one reconcile, and a periodic sweep runs even when no
 * event arrived. That split keeps a dropped event, an editor's atomic rename or
 * a platform without recursive watch from turning into silent staleness.
 */

import fs from 'node:fs';

export function createLibraryWatcher({
  fsWatch = fs.watch,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  onDirty = () => {},
  reconcileIntervalMs = 600_000,
  debounceMs = 2_000,
  minFlushGapMs = 30_000,
  now = Date.now,
} = {}) {
  const roots = new Map();
  let stopped = false;

  const clearEntry = (entry) => {
    if (entry.debounceTimer) cancelSchedule(entry.debounceTimer);
    if (entry.intervalTimer) cancelSchedule(entry.intervalTimer);
    entry.debounceTimer = null;
    entry.intervalTimer = null;
  };

  const flush = (root) => {
    const entry = roots.get(root);
    if (!entry || stopped) return;
    entry.debounceTimer = null;

    const remaining = entry.lastFlushAt === null ? 0 : minFlushGapMs - (now() - entry.lastFlushAt);
    if (remaining > 0) {
      entry.debounceTimer = schedule(() => flush(root), remaining);
      entry.debounceTimer?.unref?.();
      return;
    }

    entry.lastFlushAt = now();
    try {
      onDirty(root);
    } catch {
      /* a listener must not break the watcher */
    }
  };

  const markDirty = (root) => {
    const entry = roots.get(root);
    if (!entry || stopped || entry.debounceTimer) return;
    entry.debounceTimer = schedule(() => flush(root), debounceMs);
    entry.debounceTimer?.unref?.();
  };

  const scheduleSweep = (root, entry) => {
    entry.intervalTimer = schedule(() => {
      entry.intervalTimer = null;
      if (stopped || !roots.has(root)) return;
      markDirty(root);
      scheduleSweep(root, entry);
    }, reconcileIntervalMs);
    entry.intervalTimer?.unref?.();
  };

  return {
    watch(root) {
      if (stopped || roots.has(root)) return;
      const entry = { handle: null, debounceTimer: null, intervalTimer: null, lastFlushAt: null };
      roots.set(root, entry);

      try {
        entry.handle = fsWatch(root, { recursive: true }, () => markDirty(root));
        entry.handle?.on?.('error', () => {});
      } catch {
        // No recursive watch on this platform: the sweep alone keeps it current.
        entry.handle = null;
      }

      scheduleSweep(root, entry);
    },

    unwatch(root) {
      const entry = roots.get(root);
      if (!entry) return;
      clearEntry(entry);
      try {
        entry.handle?.close?.();
      } catch {
        /* already closed */
      }
      roots.delete(root);
    },

    stop() {
      stopped = true;
      for (const entry of roots.values()) {
        clearEntry(entry);
        try {
          entry.handle?.close?.();
        } catch {
          /* already closed */
        }
      }
      roots.clear();
    },

    watchedRoots: () => [...roots.keys()],
  };
}
