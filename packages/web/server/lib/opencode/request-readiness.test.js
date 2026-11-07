import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeRequestReadiness } from './request-readiness.js';

const response = () => ({
  writableEnded: false,
  destroyed: false,
  headersSent: false,
  statusCode: null,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; this.writableEnded = true; return this; },
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('OpenCode request readiness', () => {
  it('passes an already ready request without scheduling a poll', async () => {
    vi.useFakeTimers();
    const wait = createOpenCodeRequestReadiness({ getRuntime: () => ({ openCodePort: 1234, isOpenCodeReady: true }), readyGraceMs: 20_000 });
    expect(await wait({ path: '/api/session/ses_one/prompt' }, response())).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['/session/ses_one/prompt', '/api/session/ses_one/prompt'])('holds %s until the next readiness poll and records only its route class', async (path) => {
    vi.useFakeTimers();
    vi.stubEnv('OPENCHAMBER_STARTUP_PERF', 'true');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const runtime = { openCodePort: null, isOpenCodeReady: false, isRestartingOpenCode: true, openCodeNotReadySince: 0 };
    const wait = createOpenCodeRequestReadiness({ getRuntime: () => runtime, readyGraceMs: 20_000 });
    let completed = false;
    const pending = wait({ path }, response()).then((result) => { completed = true; return result; });
    runtime.openCodePort = 1234;
    runtime.isOpenCodeReady = true;
    runtime.isRestartingOpenCode = false;
    await vi.advanceTimersByTimeAsync(74);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(true);
    expect(log).toHaveBeenCalledWith('[startup-performance]', expect.objectContaining({ phase: 'proxy.readiness-hold', outcome: 'ready', routeClass: 'session' }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('ses_one');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps a restarting request at six seconds with bounded polling', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const wait = createOpenCodeRequestReadiness({ getRuntime: () => { reads += 1; return { openCodePort: null, isOpenCodeReady: false, isRestartingOpenCode: true }; }, readyGraceMs: 20_000 });
    const res = response();
    let completed = false;
    const pending = wait({ path: '/api/session/ses_one/prompt' }, res).then((result) => { completed = true; return result; });
    await vi.advanceTimersByTimeAsync(5999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'OpenCode is restarting', restarting: true });
    expect(reads).toBe(81);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['aborted', 'destroyed', 'writableEnded'])('does not release a request marked %s during a readiness poll', async (field) => {
    vi.useFakeTimers();
    const runtime = { openCodePort: null, isOpenCodeReady: false, isRestartingOpenCode: true };
    const wait = createOpenCodeRequestReadiness({ getRuntime: () => runtime, readyGraceMs: 6000 });
    const req = { path: '/api/session/ses_one/prompt', aborted: false };
    const res = response();
    const pending = wait(req, res);
    if (field === 'aborted') req.aborted = true;
    else res[field] = true;
    runtime.openCodePort = 1234;
    runtime.isOpenCodeReady = true;
    runtime.isRestartingOpenCode = false;
    await vi.advanceTimersByTimeAsync(75);
    expect(await pending).toBe(false);
    expect(res.statusCode).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
