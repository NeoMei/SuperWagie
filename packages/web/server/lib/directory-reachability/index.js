import fs from 'node:fs';
import path from 'node:path';

import { isRecord } from '../shared/guards.js';
import { startProbeProcess } from './probe-process.js';

export const DIRECTORY_UNREACHABLE = 'DIRECTORY_UNREACHABLE';

const ANSWER_DEADLINE_MS = 3000;
const REPROBE_WAIT_MS = 100;
const JAM_AFTER_MS = 250;
const IN_PROCESS_PROBES = 2;
const UNREACHABLE_TTL_MS = 5000;
const PROBE_PROCESS_IDLE_MS = 60_000;
const STUCK_PROCESS_MS = 30_000;
const STUCK_PROCESS_MAX_MS = 600_000;
const MAX_ENTRIES = 1000;

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);
const ANSWERED_CODES = new Set(['EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG', 'EINVAL', 'ERR_INVALID_ARG_VALUE']);

export const isDirectoryPath = (value) => typeof value === 'string' && value.length > 0;

const errorCode = (error) => isRecord(error) && typeof error.code === 'string' ? error.code : 'UNKNOWN';

const volumeRootOf = (target, platform) => {
  if (platform === 'win32') return path.win32.parse(target).root || null;
  if (platform === 'darwin') return /^\/Volumes\/[^/]+/.exec(target)?.[0] ?? null;
  return null;
};

export const directoryUnreachableError = (directory) => Object.assign(
  new Error(`The folder does not answer: ${directory}. Its drive or network share may be offline.`),
  { code: DIRECTORY_UNREACHABLE, status: 503, statusCode: 503 },
);

const touchOnDisk = async (target) => {
  try {
    const directory = await fs.promises.opendir(target, { bufferSize: 1 });
    try {
      await directory.read();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOTDIR') throw error;
    await fs.promises.stat(target);
  }
};

export const createDirectoryReachability = ({
  touch = touchOnDisk,
  startProcess = startProbeProcess,
  platform = process.platform,
  now = Date.now,
  answerDeadlineMs = ANSWER_DEADLINE_MS,
  stuckProcessMs = STUCK_PROCESS_MS,
} = {}) => {
  const paths = platform === 'win32' ? path.win32 : path;
  const entries = new Map();
  const queue = [];
  const started = new Set();
  const inHelper = new Set();
  let inProcess = 0;
  let processFailed = false;
  let probeProcess = null;
  let stuckMs = stuckProcessMs;
  let stuckTimer = null;
  let disposed = false;
  let idleTimer = null;

  const touchInProcess = async (target) => {
    try {
      await touch(target);
      return null;
    } catch (error) {
      return errorCode(error);
    }
  };

  const hasUnanswered = () => inProcess > 0 || [...entries.values()].some((entry) => entry.running !== null);

  const stopProcessWhenIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!probeProcess) return;
      if (hasUnanswered()) stopProcessWhenIdle();
      else probeProcess.stop();
    }, PROBE_PROCESS_IDLE_MS);
    idleTimer.unref?.();
  };

  const startInProcess = (queued) => {
    inProcess += 1;
    started.add(queued);
    const jam = setTimeout(moveToProcess, JAM_AFTER_MS);
    jam.unref?.();
    void touchInProcess(queued.target).then((code) => {
      clearTimeout(jam);
      inProcess -= 1;
      started.delete(queued);
      queued.resolve(code);
      const next = queue.shift();
      if (next) startInProcess(next);
    });
  };

  const touchInProcessOrQueue = (queued) => {
    if (processFailed || inProcess < IN_PROCESS_PROBES) startInProcess(queued);
    else queue.push(queued);
  };

  const replaceStuckProcess = () => {
    stuckTimer = null;
    if (!probeProcess || inHelper.size === 0) {
      stuckMs = stuckProcessMs;
      return;
    }
    stuckMs = Math.min(stuckMs * 2, STUCK_PROCESS_MAX_MS);
    probeProcess.stop();
  };

  const touchInHelper = (helper, queued) => {
    stopProcessWhenIdle();
    inHelper.add(queued);
    stuckTimer ??= setTimeout(replaceStuckProcess, stuckMs);
    stuckTimer.unref?.();
    void helper.touch(queued.target).then((code) => {
      inHelper.delete(queued);
      if (code !== undefined) {
        queued.resolve(code);
        return;
      }
      if (disposed) return;
      if (processFailed) touchInProcessOrQueue(queued);
      else touchInHelper(runningProcess(), queued);
    });
  };

  const runningProcess = () => {
    if (!probeProcess) {
      const starting = startProcess((failed) => {
        if (probeProcess === starting) probeProcess = null;
        if (!failed) return;
        processFailed = true;
        const retry = setTimeout(() => {
          processFailed = false;
          if (started.size > 0) moveToProcess();
        }, stuckProcessMs);
        retry.unref?.();
        for (const queued of queue.splice(0)) startInProcess(queued);
      });
      probeProcess = starting;
    }
    return probeProcess;
  };

  function moveToProcess() {
    if (processFailed || disposed) return;
    const helper = runningProcess();
    for (const queued of [...queue.splice(0), ...started]) {
      if (!inHelper.has(queued)) touchInHelper(helper, queued);
    }
  }

  const touchCode = (target) => new Promise((resolve) => {
    if (probeProcess) touchInHelper(probeProcess, { target, resolve });
    else touchInProcessOrQueue({ target, resolve });
  });

  const judge = async (target) => {
    const code = await touchCode(target);
    if (code === null || ANSWERED_CODES.has(code)) return 'available';
    if (!MISSING_CODES.has(code)) return 'unreachable';
    const root = volumeRootOf(target, platform);
    if (!root || root === target) return root ? 'unreachable' : 'missing';
    return await touchCode(root) === null ? 'missing' : 'unreachable';
  };

  const prune = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= MAX_ENTRIES) return;
      if (!entry.running) entries.delete(key);
    }
  };

  const probe = (target, entry) => {
    entry.running ??= judge(target).then((result) => {
      entry.last = result;
      entry.settledAt = now();
      entry.running = null;
      return result;
    });
    return entry.running;
  };

  const within = (running, deadlineMs) => new Promise((resolve) => {
    const timer = setTimeout(resolve, deadlineMs, null);
    void running.then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });

  const suspectAncestor = (target) => {
    for (let current = paths.dirname(target); ; current = paths.dirname(current)) {
      if (entries.get(current)?.last === 'unreachable') return current;
      if (current === paths.dirname(current)) return null;
    }
  };

  const markUnreachable = (target, entry) => {
    entry.last = 'unreachable';
    const parent = paths.dirname(target);
    if (parent !== target && entries.get(parent)?.last !== 'unreachable') void answer(parent);
    return 'unreachable';
  };

  async function answer(target) {
    const entry = entries.get(target) ?? { last: null, settledAt: 0, running: null };
    entries.delete(target);
    entries.set(target, entry);
    prune();
    const wasUnreachable = entry.last === 'unreachable';
    if (wasUnreachable && !entry.running && now() - entry.settledAt < UNREACHABLE_TTL_MS) return 'unreachable';
    const result = await within(probe(target, entry), wasUnreachable ? REPROBE_WAIT_MS : answerDeadlineMs);
    return result === null || result === 'unreachable' ? markUnreachable(target, entry) : result;
  }

  const check = async (directory) => {
    const target = paths.resolve(directory);
    const suspect = suspectAncestor(target);
    if (suspect && await answer(suspect) === 'unreachable') return 'unreachable';
    return answer(target);
  };

  return {
    check,
    isUnreachable: async (directory) => await check(directory) === 'unreachable',
    dispose: () => {
      disposed = true;
      if (stuckTimer) clearTimeout(stuckTimer);
      if (idleTimer) clearTimeout(idleTimer);
      probeProcess?.stop();
    },
  };
};

export const directoryReachability = createDirectoryReachability();

export const isWindowsDirectoryOffline = async (directory) => (
  process.platform === 'win32' && directoryReachability.isUnreachable(directory)
);

export const readProjectPath = async (directory, read, isOffline = isWindowsDirectoryOffline) => {
  if (await isOffline(directory)) throw directoryUnreachableError(directory);
  if (process.platform !== 'win32') return read();
  // The drive can disconnect between the probe and the actual stat or realpath.
  let timer;
  try {
    return await Promise.race([
      read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(directoryUnreachableError(directory)), 2000);
      }),
    ]);
  } catch (error) {
    if (MISSING_CODES.has(error?.code) && await isOffline(directory)) throw directoryUnreachableError(directory);
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
