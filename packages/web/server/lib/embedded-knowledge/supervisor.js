/**
 * Embedded knowledge process supervision.
 *
 * SuperWagie owns the bundled backend: it starts it, waits for `GET /health`,
 * restarts it with backoff when it dies, and stops it on shutdown. It never
 * repairs the backend's data, never kills a process it did not start, and
 * never blocks server startup on a backend failure — the feature degrades to
 * `unavailable` and the rest of the app keeps working.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import net from 'node:net';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  let state = 'stopped';
  let child = null;
  let healthTimer = null;
  let consecutiveFailures = 0;
  let failure = null;
  let starting = null;
  let stopping = null;

  const setState = (next, detail = {}) => {
    state = next;
    try {
      onStateChange(next, detail);
    } catch (error) {
      log.warn?.('[EmbeddedKnowledge] state listener failed', error?.message ?? error);
    }
  };

  const probe = async () => {
    try {
      const response = await fetchImpl(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (!response.ok) return false;
      const payload = await response.json();
      return payload?.status === 'ok';
    } catch {
      return false;
    }
  };

  const waitForHealthy = async (deadline) => {
    while (Date.now() < deadline) {
      if (await probe()) return true;
      await sleep(500);
    }
    return false;
  };

  const isAlive = (process) => Boolean(process) && child === process && process.exitCode === null && !process.signalCode;

  const killChild = async (signal) => {
    if (!isAlive(child)) return;
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };

  const stopChild = async () => {
    if (!child) return;
    const current = child;
    await killChild('SIGTERM');
    const deadline = Date.now() + 5_000;
    while (current.exitCode === null && Date.now() < deadline) await sleep(100);
    if (current.exitCode === null) await killChild('SIGKILL');
    child = null;
  };

  const startHealthLoop = () => {
    if (healthTimer) cancelSchedule(healthTimer);
    healthTimer = schedule(async () => {
      const healthy = await probe();
      if (healthy) {
        consecutiveFailures = 0;
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures < 2) return;
      consecutiveFailures = 0;
      log.warn?.('[EmbeddedKnowledge] health probe failed twice, restarting');
      await stopChild();
      await start();
    }, healthIntervalMs);
    healthTimer?.unref?.();
  };

  const clearHealthLoop = () => {
    if (!healthTimer) return;
    cancelSchedule(healthTimer);
    healthTimer = null;
  };

  const spawnOnce = async () => {
    const binary = resolveBinaryPath();
    if (!binary) {
      setState('not-installed');
      return false;
    }

    const spawned = spawnImpl(binary, spawnArgs(), {
      cwd: cwd ?? dataDir,
      env: managed ? buildEnv() : { ...process.env, ...buildEnv() },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    child = spawned;
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
    spawned.on('exit', () => lostOwnership('backend_exited'));
    spawned.on('error', (error) => {
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
      const healthy = await probe();
      if (!isAlive(spawned)) {
        conflict = healthy || /address already in use|EADDRINUSE/i.test(stderrTail) || (await isPortOccupied(port));
        if (child === spawned) child = null;
        break;
      }
      if (healthy) return true;
      await sleep(500);
    }

    await stopChild();
    if (conflict) {
      failure = managed ? 'managed_worker_unowned' : null;
      setState('port-conflict', { port });
      return false;
    }
    failure ??= 'backend_start_timeout';
    return false;
  };

  const start = async () => {
    if (state === 'running' || state === 'starting') return state;
    if (starting) return starting;

    starting = (async () => {
      failure = null;
      if (await probe()) {
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
      if (await isPortOccupied(port)) {
        setState('port-conflict', { port });
        return state;
      }

      for (let attempt = 0; attempt < backoffMs.length; attempt += 1) {
        if (attempt > 0) await sleep(backoffMs[attempt]);
        setState('starting', { attempt });
        if (await spawnOnce() && (!managed || isAlive(child))) {
          failure = null;
          setState('running');
          startHealthLoop();
          return state;
        }
        if (state === 'port-conflict' || state === 'not-installed') return state;
      }

      setState('unavailable', { reason: 'retries-exhausted' });
      return state;
    })().finally(() => {
      starting = null;
    });

    return starting;
  };

  const stop = async () => {
    if (stopping) return stopping;
    stopping = (async () => {
      clearHealthLoop();
      await stopChild();
      setState('stopped');
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
