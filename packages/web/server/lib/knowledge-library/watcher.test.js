import { describe, expect, it } from 'vitest';

import { createLibraryWatcher } from './watcher.js';

/**
 * A scheduler that records callbacks so a test decides when time moves.
 * Timers are keyed by the same numeric id `clearTimeout` would receive.
 */
const createScheduler = () => {
  let nextId = 1;
  const timers = new Map();
  const scheduler = (fn, ms) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { fn, ms });
    return id;
  };
  const cancel = (id) => timers.delete(id);
  const pending = (ms) => [...timers.values()].filter((timer) => timer.ms === ms);
  const run = (ms) => {
    const due = pending(ms);
    for (const timer of due) {
      for (const [id, value] of timers) {
        if (value === timer) timers.delete(id);
      }
      timer.fn();
    }
    return due.length;
  };
  return { schedule: scheduler, cancel, pending, run, timers };
};

describe('library watcher', () => {
  it('coalesces a burst of events into one reconcile', () => {
    const scheduler = createScheduler();
    let handler;
    const dirty = [];
    const watcher = createLibraryWatcher({
      fsWatch: (_path, _options, callback) => {
        handler = callback;
        return { close() {}, on() {} };
      },
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
      onDirty: (root) => dirty.push(root),
    });

    watcher.watch('/tmp/root');
    handler('rename', 'a.md');
    handler('rename', 'b.md');
    expect(scheduler.pending(2_000)).toHaveLength(1);

    scheduler.run(2_000);
    expect(dirty).toEqual(['/tmp/root']);
  });

  it('keeps working when recursive watch is unavailable', () => {
    const scheduler = createScheduler();
    const dirty = [];
    const watcher = createLibraryWatcher({
      fsWatch: () => {
        throw Object.assign(new Error('no recursive watch'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
      },
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
      onDirty: (root) => dirty.push(root),
    });

    watcher.watch('/tmp/root');
    expect(watcher.watchedRoots()).toEqual(['/tmp/root']);

    scheduler.run(600_000);
    scheduler.run(2_000);
    expect(dirty).toEqual(['/tmp/root']);
  });

  it('does not flush more often than the minimum gap', () => {
    const scheduler = createScheduler();
    let handler;
    let clock = 1_000;
    const dirty = [];
    const watcher = createLibraryWatcher({
      fsWatch: (_path, _options, callback) => {
        handler = callback;
        return { close() {}, on() {} };
      },
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
      onDirty: (root) => dirty.push(root),
      now: () => clock,
    });

    watcher.watch('/tmp/root');
    handler('rename');
    scheduler.run(2_000);
    expect(dirty).toHaveLength(1);

    clock += 5_000;
    handler('rename');
    scheduler.run(2_000);
    expect(dirty).toHaveLength(1); // still inside the gap

    clock += 25_000;
    scheduler.run(25_000);
    expect(dirty).toHaveLength(2);
  });

  it('stops watching on unwatch and on stop', () => {
    const scheduler = createScheduler();
    let handler;
    let closed = 0;
    const dirty = [];
    const watcher = createLibraryWatcher({
      fsWatch: (_path, _options, callback) => {
        handler = callback;
        return {
          close() {
            closed += 1;
          },
          on() {},
        };
      },
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
      onDirty: (root) => dirty.push(root),
    });

    watcher.watch('/tmp/a');
    watcher.watch('/tmp/b');
    expect(watcher.watchedRoots()).toEqual(['/tmp/a', '/tmp/b']);

    watcher.unwatch('/tmp/a');
    expect(watcher.watchedRoots()).toEqual(['/tmp/b']);
    expect(closed).toBe(1);

    handler('rename');
    scheduler.run(2_000);
    expect(dirty).toEqual(['/tmp/b']);

    watcher.stop();
    expect(watcher.watchedRoots()).toEqual([]);
    expect(closed).toBe(2);
  });
});
