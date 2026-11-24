import { recordStartupPerformance } from './startup-performance.js';
import { OPENCODE_PROXY_ERROR_HEADER } from '../../proxy-headers.js';

const READINESS_HOLD_POLL_MS = 75;
const READINESS_HOLD_MAX_MS = 6000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Only callers that can prove no prompt was forwarded may attach this header. */
export const markUnforwardedPrompt = (req, res) => {
  const url = req.originalUrl ?? req.url;
  if (res.headersSent || req.method !== 'POST' || !/^\/api\/session\/[^/?]+\/prompt\/?(?:\?|$)/i.test(url)) return;
  res.setHeader(OPENCODE_PROXY_ERROR_HEADER, 'opencode-unreachable');
};

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
    if (!res.headersSent) {
      markUnforwardedPrompt(req, res);
      res.status(503).json({ error: 'OpenCode is restarting', restarting: true });
    }
    return false;
  };
};
