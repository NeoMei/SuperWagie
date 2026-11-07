import { recordStartupPerformance } from './startup-performance.js';

const READINESS_HOLD_POLL_MS = 75;
const READINESS_HOLD_MAX_MS = 6000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const classifyReadinessRoute = (path) => {
  const requestPath = path.replace(/^\/api(?=\/|$)/, '');
  if (/^\/session\/[^/]+\/message(?:\/|$)/.test(requestPath)) return 'session-messages';
  if (requestPath === '/session' || requestPath.startsWith('/session/')) return 'session';
  if (requestPath === '/event') return 'events';
  return 'other';
};

/** Hold one unsent request until the lifecycle permits an upstream read. */
export const createOpenCodeRequestReadiness = ({ getRuntime, readyGraceMs }) => {
  const isStillWaiting = () => {
    const runtime = getRuntime();
    const waitElapsed = runtime.openCodeNotReadySince === 0 ? 0 : Date.now() - runtime.openCodeNotReadySince;
    return (
      (!runtime.isOpenCodeReady && (runtime.openCodeNotReadySince === 0 || waitElapsed < readyGraceMs)) ||
      runtime.isRestartingOpenCode ||
      !runtime.openCodePort
    );
  };

  return async (req, res) => {
    const abandoned = () => res.writableEnded || res.destroyed || req.aborted;
    if (abandoned()) return false;
    if (!isStillWaiting()) return true;

    const holdStartedAt = performance.now();
    const routeClass = classifyReadinessRoute(req.path);
    const record = (outcome) => recordStartupPerformance('proxy.readiness-hold', {
      durationMs: performance.now() - holdStartedAt,
      outcome,
      routeClass,
    });
    const deadline = Date.now() + Math.min(readyGraceMs, READINESS_HOLD_MAX_MS);
    while (Date.now() < deadline) {
      if (abandoned()) { record('aborted'); return false; }
      await sleep(READINESS_HOLD_POLL_MS);
      if (abandoned()) { record('aborted'); return false; }
      if (!isStillWaiting()) { record('ready'); return true; }
    }

    record('timeout');
    if (!res.headersSent) res.status(503).json({ error: 'OpenCode is restarting', restarting: true });
    return false;
  };
};
