/**
 * Embedded knowledge process supervision.
 *
 * SuperWagie owns the bundled backend: it starts it, waits for `GET /health`,
 * restarts it with backoff when it stops responding, and stops it on shutdown. It never
 * repairs the backend's data, never kills a process it did not start, and
 * never blocks server startup on a backend failure — the feature degrades to
 * `unavailable` and the rest of the app keeps working.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const sleep = (ms, signal) => delay(ms, undefined, { signal });
const macLocalTemp = '/private/tmp';

// System Bash creates a watchdog in the worker's private process group.
// Only the watchdog reads the host's pipe. EOF also arrives after SIGKILL, and
// the watchdog can reap the group even if the worker cannot handle a signal.
const macWorkerLauncher = [
  'stage_dir=$1; shift',
  '(',
  '  IFS= read -r line || :',
  '  if [ -n "$stage_dir" ]; then',
  '    /bin/rm -f -- "$1"',
  '    /bin/rmdir -- "$stage_dir"',
  '  fi',
  '  kill -KILL -- "-$$"',
  ') <&0 >/dev/null 2>&1 &',
  'exec "$@" </dev/null',
].join('\n');

async function stageMacExecutable(binary, workingDirectory, signal) {
  // Preserve PATH lookup for callers that pass a bare command name.
  if (!binary.includes('/')) return null;
  const source = path.resolve(workingDirectory ?? process.cwd(), binary);
  const sourceInfo = await stat(source).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!sourceInfo?.isFile() || sourceInfo.dev === (await stat(macLocalTemp)).dev) return null;

  signal.throwIfAborted();
  const directory = await mkdtemp(path.join(macLocalTemp, 'superwagie-knowledge-exec-'));
  const executable = path.join(directory, path.basename(source));
  try {
    signal.throwIfAborted();
    await copyFile(source, executable);
    signal.throwIfAborted();
    return { directory, executable };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const isPortOccupied = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });

export function createEmbeddedKnowledgeSupervisor({
  resolveBinaryPath,
  buildEnv = () => ({}),
  managed = false,
  spawnArgs = () => [],
  port,
  dataDir,
  cwd,
  spawnImpl = nodeSpawn,
  fetchImpl = fetch,
  onStateChange = () => {},
  log = console,
  startupTimeoutMs = 30_000,
  healthIntervalMs = 15_000,
  probeTimeoutMs = 2_000,
  backoffMs = [0, 5_000, 20_000, 60_000, 300_000],
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
} = {}) {
  if (!port) throw new Error('Embedded knowledge supervisor requires a port');

  const baseUrl = `http://127.0.0.1:${port}`;
  const watchOwner = process.platform === 'darwin';
  let state = 'stopped';
  let child = null;
  let workerGroup = null;
  let healthTimer = null;
  let failure = null;
  let starting = null;
  let stopping = null;
  let stoppingChild = null;
  let stopGeneration = 0;

  const setState = (next, detail = {}) => {
    state = next;
    try {
      onStateChange(next, detail);
    } catch (error) {
      log.warn?.('[EmbeddedKnowledge] state listener failed', error?.message ?? error);
    }
  };

  const probe = async (startupSignal) => {
    try {
      const timeout = AbortSignal.timeout(probeTimeoutMs);
      const response = await fetchImpl(`${baseUrl}/health`, {
        signal: startupSignal ? AbortSignal.any([startupSignal, timeout]) : timeout,
      });
      if (!response.ok) return false;
      const payload = await response.json();
      return payload?.status === 'ok';
    } catch {
      return false;
    }
  };

  const isAlive = (process) => Boolean(process) && child === process && process.exitCode === null && !process.signalCode;

  const groupIsAlive = () => {
    if (!workerGroup) return false;
    try {
      return process.kill(-workerGroup, 0);
    } catch (error) {
      if (error.code !== 'ESRCH') return true;
      workerGroup = null;
      return false;
    }
  };

  const killChild = (process, signal) => {
    if (!isAlive(process)) return;
    try {
      process.kill(signal);
    } catch {
      /* already gone */
    }
  };

  const stopChild = async () => {
    if (stoppingChild) return stoppingChild;
    const current = child;
    if (!isAlive(current) && !groupIsAlive()) return true;
    const waitForExit = async (isRunning, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (isRunning() && Date.now() < deadline) await sleep(100);
      return !isRunning();
    };
    stoppingChild = (async () => {
      killChild(current, 'SIGTERM');
      if (!await waitForExit(() => isAlive(current), 5_000)) killChild(current, 'SIGKILL');
      // The leader can exit before the watchdog has reaped a descendant
      // holding the port. Wait before probing or spawning a replacement.
      const stopped = await waitForExit(() => isAlive(current) || groupIsAlive(), 1_000);
      if (!stopped) {
        failure = 'backend_stop_timeout';
        setState('unavailable', { reason: 'stop-timeout' });
      }
      return stopped;
    })().finally(() => {
      stoppingChild = null;
    });
    return stoppingChild;
  };

  const startHealthLoop = () => {
    clearHealthLoop();
    const current = child;
    if (!isAlive(current)) return;
    let consecutiveFailures = 0;
    const scheduleProbe = () => {
      const timer = schedule(async () => {
        if (healthTimer !== timer || !isAlive(current)) return;
        const healthy = await probe();
        if (healthTimer !== timer || !isAlive(current)) return;
        consecutiveFailures = healthy ? 0 : consecutiveFailures + 1;
        if (consecutiveFailures < 2) {
          scheduleProbe();
          return;
        }
        log.warn?.('[EmbeddedKnowledge] health probe failed twice, restarting');
        const generation = stopGeneration;
        if (await stopChild() && generation === stopGeneration) await start();
      }, healthIntervalMs);
      healthTimer = timer;
      timer?.unref?.();
    };
    scheduleProbe();
  };

  const clearHealthLoop = () => {
    if (!healthTimer) return;
    cancelSchedule(healthTimer);
    healthTimer = null;
  };

  const spawnOnce = async (signal) => {
    const binary = resolveBinaryPath();
    if (!binary) {
      setState('not-installed');
      return false;
    }

    const workingDirectory = cwd ?? dataDir;
    let staged;
    try {
      if (watchOwner) staged = await stageMacExecutable(binary, workingDirectory, signal);
    } catch (error) {
      signal.throwIfAborted();
      log.warn?.('[EmbeddedKnowledge] worker executable staging failed', error.code);
      failure = 'backend_spawn_failed';
      return false;
    }
    const discardStage = async () => {
      if (!staged) return;
      try {
        await rm(staged.directory, { recursive: true, force: true });
      } catch (error) {
        log.warn?.('[EmbeddedKnowledge] worker executable cleanup failed', error.code);
      }
    };
    let spawned;
    try {
      signal.throwIfAborted();
      const args = spawnArgs();
      // Bash privileged mode ignores inherited startup files and shell options.
      spawned = spawnImpl(watchOwner ? '/bin/bash' : binary, watchOwner
        ? ['-p', '-c', macWorkerLauncher, 'embedded-knowledge', staged?.directory ?? '', staged?.executable ?? binary, ...args]
        : args, {
        cwd: workingDirectory,
        env: managed ? buildEnv() : { ...process.env, ...buildEnv() },
        stdio: [watchOwner ? 'pipe' : 'ignore', 'ignore', 'pipe'],
        detached: watchOwner,
        windowsHide: true,
      });
    } catch (error) {
      await discardStage();
      throw error;
    }

    child = spawned;
    if (watchOwner) workerGroup = spawned.pid;
    let stderrTail = '';
    spawned.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2_000);
    });
    const lostOwnership = (reason) => {
      if (child !== spawned) return;
      child = null;
      failure = reason;
      clearHealthLoop();
      if (state === 'running') setState('unavailable', { reason: 'exited' });
    };
    spawned.on('exit', (code) => lostOwnership(
      watchOwner && (code === 126 || code === 127) ? 'backend_spawn_failed' : 'backend_exited',
    ));
    spawned.on('error', (error) => {
      if (!spawned.pid) void discardStage();
      log.warn?.('[EmbeddedKnowledge] spawn failed', error?.message ?? error);
      lostOwnership('backend_spawn_failed');
    });

    let conflict = false;
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(spawned)) {
        conflict = /address already in use|EADDRINUSE/i.test(stderrTail) || (await isPortOccupied(port));
        if (child === spawned) child = null;
        break;
      }
      const healthy = await probe(signal);
      signal.throwIfAborted();
      if (!isAlive(spawned)) {
        conflict = healthy || /address already in use|EADDRINUSE/i.test(stderrTail) || (await isPortOccupied(port));
        if (child === spawned) child = null;
        break;
      }
      if (healthy) return true;
      await sleep(500, signal);
    }

    signal.throwIfAborted();
    const stopped = await stopChild();
    signal.throwIfAborted();
    if (!stopped) return false;
    if (conflict) {
      failure = managed ? 'managed_worker_unowned' : null;
      setState('port-conflict', { port });
      return false;
    }
    failure ??= 'backend_start_timeout';
    return false;
  };

  const start = async () => {
    if (stopping) {
      await stopping;
      return state;
    }
    if (starting) return starting.promise;
    if (state === 'running') return state;

    const controller = new AbortController();
    const { signal } = controller;
    const promise = (async () => {
      failure = null;
      if (child || workerGroup) {
        const stopped = await stopChild();
        signal.throwIfAborted();
        if (!stopped) return state;
      }
      const healthy = await probe(signal);
      signal.throwIfAborted();
      if (healthy) {
        if (managed) {
          failure = 'managed_worker_unowned';
          setState('port-conflict', { port });
          return state;
        }
        failure = null;
        setState('running', { adopted: true });
        startHealthLoop();
        return state;
      }

      // A listener that is not our backend would make every spawn fail with
      // EADDRINUSE; say so once instead of retrying the whole ladder.
      const occupied = await isPortOccupied(port);
      signal.throwIfAborted();
      if (occupied) {
        setState('port-conflict', { port });
        return state;
      }

      for (let attempt = 0; attempt < backoffMs.length; attempt += 1) {
        if (attempt > 0) await sleep(backoffMs[attempt], signal);
        setState('starting', { attempt });
        signal.throwIfAborted();
        const spawned = await spawnOnce(signal);
        signal.throwIfAborted();
        if (spawned && (!managed || isAlive(child))) {
          failure = null;
          setState('running');
          startHealthLoop();
          return state;
        }
        if (state === 'port-conflict' || state === 'not-installed' || failure === 'backend_stop_timeout') return state;
      }

      setState('unavailable', { reason: 'retries-exhausted' });
      return state;
    })().catch((error) => {
      if (signal.aborted) return 'stopped';
      throw error;
    }).finally(() => {
      if (starting?.controller === controller) starting = null;
    });

    starting = { controller, promise };
    return promise;
  };

  const stop = async () => {
    if (stopping) return stopping;
    stopGeneration += 1;
    starting?.controller.abort();
    starting = null;
    stopping = (async () => {
      clearHealthLoop();
      if (await stopChild()) setState('stopped');
    })().finally(() => {
      stopping = null;
    });
    return stopping;
  };

  const retry = async () => {
    await stop();
    return start();
  };

  const restartOwned = async () => {
    // A healthy backend adopted from another owner must keep running with
    // that owner's environment. Restarting it is outside this supervisor.
    if (state === 'running' && !child) return null;
    const result = await retry();
    return result === 'running' && !child ? null : result;
  };

  return {
    start,
    stop,
    retry,
    restartOwned,
    getState: () => state,
    getError: () => failure,
    ownsProcess: () => isAlive(child),
    getBaseUrl: () => baseUrl,
  };
}
