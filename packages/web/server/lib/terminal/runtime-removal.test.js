import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalRuntime } from './runtime.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
const harnesses = [];

// Registered handlers exercise the real lifecycle. Fake PTYs have no PID, so
// even the process-group termination branch cannot signal an operating process.
const createHarness = () => {
  const routes = { get: new Map(), post: new Map(), delete: new Map() };
  const app = Object.fromEntries(Object.entries(routes).map(([verb, handlers]) => [verb, (route, handler) => handlers.set(route, handler)]));
  const processes = [];
  const spawnSteps = [];
  const gates = [];
  const events = [];
  const runtime = createTerminalRuntime({
    app, server: new EventEmitter(), path,
    fs: { promises: { stat: async () => ({ isDirectory: () => true }) } },
    buildAugmentedPath: () => '', searchPathFor: () => '/bin/sh', isExecutable: () => true,
    isRequestOriginAllowed: () => true, rejectWebSocketUpgrade() {},
    terminalTerminationGraceMs: 1,
    broadcastUiEvent: event => events.push(event),
    shutdownProcesses: async terminals => { for (const terminal of terminals) terminal.process.kill('SIGKILL'); },
    loadPtyProvider: async () => ({
      backend: 'fake-pty',
      spawn: async () => {
        await spawnSteps.shift()?.();
        const exits = new Set();
        const outputs = new Set();
        const child = {
          pid: undefined, killed: false, exited: false, resizes: [],
          write() {}, resize(cols, rows) { this.resizes.push([cols, rows]); },
          kill() { this.killed = true; },
          onData(handler) { outputs.add(handler); return { dispose: () => outputs.delete(handler) }; },
          onExit(handler) { exits.add(handler); return { dispose: () => exits.delete(handler) }; },
          emitData(text) { for (const handler of outputs) handler(text); },
          emitExit() { this.exited = true; for (const handler of exits) handler({ exitCode: 0, signal: 0 }); },
        };
        processes.push(child);
        return child;
      },
    }),
  });
  const call = (verb, route, request) => {
    const result = response();
    const done = Promise.resolve(routes[verb].get(route)(request, result)).then(() => result);
    return done;
  };
  const harness = {
    runtime, processes, events,
    create: body => call('post', '/api/terminal/create', { body: { cwd: '/repo', shell: 'sh', ...body } }),
    close: sessionId => call('delete', '/api/terminal/:sessionId', { params: { sessionId } }),
    restart: (sessionId, options) => call('post', '/api/terminal/:sessionId/restart', { params: { sessionId }, body: { shell: 'sh', ...options } }),
    resize: sessionId => call('post', '/api/terminal/:sessionId/resize', { params: { sessionId }, body: { cols: 91, rows: 31 } }),
    kill: body => call('post', '/api/terminal/force-kill', { body }),
    list: () => {
      const result = response();
      routes.get.get('/api/terminal/sessions')({ query: {} }, result);
      return result.body.sessions;
    },
    pauseSpawn: () => {
      const gate = deferred();
      const entered = deferred();
      gates.push(gate);
      spawnSteps.push(async () => { entered.resolve(); await gate.promise; });
      return { ...gate, entered: entered.promise };
    },
    release: () => { for (const gate of gates) gate.resolve(); },
  };
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  vi.useRealTimers();
  for (const harness of harnesses.splice(0)) {
    harness.release();
    await harness.runtime.shutdown();
  }
});

const action = (sessionId, actionId = 'build') => ({
  sessionId, mode: 'command', command: 'echo fixture',
  purpose: { type: 'project-action', actionId, executionId: sessionId },
});

// Removing cancellation in DELETE revives the exited-ID case. Removing
// cancellation in other removals revives the matching cases below.
describe('terminal removal during creation', () => {
  for (const exited of [false, true]) {
    it(`cancels ${exited ? 'an exited-ID replacement' : 'a new-ID create'} when delete wins spawn`, async () => {
      const h = createHarness();
      if (exited) {
        await h.create({ sessionId: 'owned' });
        h.processes[0].emitExit();
      }
      const gate = h.pauseSpawn();
      const creation = h.create({ sessionId: 'owned' });
      await gate.entered;
      const closing = h.close('owned');
      expect(h.list()).toEqual([]);
      gate.resolve();
      const [created, closed] = await Promise.all([creation, closing]);
      expect(closed.body).toEqual({ success: true });
      expect(created.statusCode).toBe(400);
      expect(created.body).toEqual({ error: 'Terminal session was closed during creation' });
      expect(h.processes.at(-1).killed).toBe(true);
      expect(h.list()).toEqual([]);
    });

    it(`settles repeated deletes for ${exited ? 'an exited-ID replacement' : 'a new-ID create'}`, async () => {
      const h = createHarness();
      if (exited) { await h.create({ sessionId: 'owned' }); h.processes[0].emitExit(); }
      const gate = h.pauseSpawn();
      const creation = h.create({ sessionId: 'owned' });
      await gate.entered;
      const first = h.close('owned');
      const second = h.close('owned');
      gate.resolve();
      const [created, firstClose, secondClose] = await Promise.all([creation, first, second]);
      expect(created.statusCode).toBe(400);
      expect(firstClose.body).toEqual({ success: true });
      expect(secondClose.body).toEqual({ success: true });
      expect((await h.close('owned')).statusCode).toBe(404);
      expect(h.list()).toEqual([]);
    });

    it(`keeps delete successful when ${exited ? 'replacement' : 'initial'} spawn rejects`, async () => {
      const h = createHarness();
      if (exited) { await h.create({ sessionId: 'owned' }); h.processes[0].emitExit(); }
      const gate = h.pauseSpawn();
      const creation = h.create({ sessionId: 'owned' });
      await gate.entered;
      const closing = h.close('owned').then(result => ({ result }), error => ({ error }));
      gate.reject(new Error('fixture spawn failed'));
      const [created, closed] = await Promise.all([creation, closing]);
      expect(created.body).toEqual({ error: 'fixture spawn failed' });
      expect(closed.error).toBeUndefined();
      expect(closed.result.body).toEqual({ success: true });
      expect(h.list()).toEqual([]);
      expect((await h.create({ sessionId: 'owned' })).statusCode).toBe(200);
      expect(h.processes.at(-1).killed).toBe(false);
    });

    it(`joins shutdown during ${exited ? 'exited-ID recreation' : 'new-ID creation'}`, async () => {
      const h = createHarness();
      if (exited) { await h.create({ sessionId: 'owned' }); h.processes[0].emitExit(); }
      const gate = h.pauseSpawn();
      const creation = h.create({ sessionId: 'owned' });
      await gate.entered;
      const closing = h.runtime.shutdown();
      expect(h.runtime.shutdown()).toBe(closing);
      expect((await h.create({ sessionId: 'later' })).statusCode).toBe(400);
      gate.resolve();
      const [created] = await Promise.all([creation, closing]);
      expect(created.statusCode).toBe(400);
      expect(h.processes.at(-1).killed).toBe(true);
      expect(h.list()).toEqual([]);
    });
  }

  for (const filter of [{ sessionId: 'owned', cwd: '/unrelated' }, { cwd: '/repo' }, {}]) {
    for (const exited of [false, true]) {
      it(`force-kills ${exited ? 'an exited-ID replacement' : 'a pending ID'} scoped by ${JSON.stringify(filter)}`, async () => {
        const h = createHarness();
        await h.create({ sessionId: 'peer', cwd: '/elsewhere' });
        if (exited) { await h.create({ sessionId: 'owned' }); h.processes.at(-1).emitExit(); }
        const gate = h.pauseSpawn();
        const creation = h.create({ sessionId: 'owned' });
        await gate.entered;
        const killed = await h.kill(filter);
        expect(killed.body.killedSessionIds).toContain('owned');
        expect(killed.body.killedCount).toBe(Object.keys(filter).length ? 1 : 2);
        expect((await h.kill({ sessionId: 'owned' })).body.killedCount).toBe(0);
        gate.resolve();
        expect((await creation).statusCode).toBe(400);
        expect(h.processes.at(-1).killed).toBe(true);
        expect(h.list().map(session => session.sessionId)).toEqual(Object.keys(filter).length ? ['peer'] : []);
        expect(h.processes[0].killed).toBe(!Object.keys(filter).length);
      });
    }
  }

  it('leaves another pending ID and cwd alive when a scoped force-kill misses them', async () => {
    const h = createHarness();
    const gate = h.pauseSpawn();
    const creation = h.create({ sessionId: 'peer', cwd: '/elsewhere' });
    await gate.entered;
    expect((await h.kill({ sessionId: 'owned' })).body.killedCount).toBe(0);
    expect((await h.kill({ cwd: '/repo' })).body.killedCount).toBe(0);
    gate.resolve();
    expect((await creation).statusCode).toBe(200);
    expect(h.processes[0].killed).toBe(false);
  });

  it('reaps replacements when close wins recreation with a pending restart', async () => {
    const h = createHarness();
    await h.create({ sessionId: 'owned' });
    h.processes[0].emitExit();
    const createGate = h.pauseSpawn();
    const creation = h.create({ sessionId: 'owned' });
    await createGate.entered;
    const restartGate = h.pauseSpawn();
    const restarting = h.restart('owned');
    const closing = h.close('owned');
    restartGate.resolve();
    createGate.resolve();
    const [created, restarted, closed] = await Promise.all([creation, restarting, closing]);
    expect(closed.body).toEqual({ success: true });
    expect(created.statusCode).toBe(400);
    expect(restarted.statusCode).toBe(400);
    expect(h.processes.slice(1).every(child => child.killed)).toBe(true);
    expect(h.list()).toEqual([]);
  });

  it('keeps another client\'s adopted command execution alive when its unused requested ID is closed', async () => {
    const h = createHarness();
    const gate = h.pauseSpawn();
    const first = h.create(action('peer'));
    await gate.entered;
    const adopted = h.create(action('unused'));
    expect((await h.close('unused')).statusCode).toBe(404);
    expect((await h.kill({ sessionId: 'unused' })).body.killedCount).toBe(0);
    gate.resolve();
    const [created, duplicate] = await Promise.all([first, adopted]);
    expect(created.body.sessionId).toBe('peer');
    expect(duplicate.body.sessionId).toBe('peer');
    expect(h.processes).toHaveLength(1);
    expect(h.processes[0].killed).toBe(false);
    expect(h.list().map(session => session.sessionId)).toEqual(['peer']);
  });

  it('keeps a separately owned action run alive after an earlier pending run is cancelled', async () => {
    const h = createHarness();
    const gate = h.pauseSpawn();
    const cancelled = h.create(action('cancelled'));
    await gate.entered;
    const closing = h.close('cancelled');
    const peer = await h.create(action('peer'));
    expect(peer.body.sessionId).toBe('peer');
    gate.resolve();
    expect((await cancelled).statusCode).toBe(400);
    expect((await closing).body).toEqual({ success: true });
    expect(h.processes[0].killed).toBe(false);
    expect(h.processes[1].killed).toBe(true);
    expect(h.list().map(session => session.sessionId)).toEqual(['peer']);
  });

  it('keeps a later owner of the same ID safe from retired process callbacks', async () => {
    const h = createHarness();
    await h.create({ sessionId: 'reused' });
    h.processes[0].emitExit();
    const gate = h.pauseSpawn();
    const recreation = h.create({ sessionId: 'reused' });
    await gate.entered;
    const closing = h.close('reused');
    gate.resolve();
    await closing;
    expect((await recreation).statusCode).toBe(400);
    const retired = h.processes.at(-1);
    expect((await h.create({ sessionId: 'reused' })).statusCode).toBe(200);
    const current = h.processes.at(-1);
    const eventCount = h.events.length;
    retired.emitData('late retired output');
    retired.emitExit();
    expect(h.events).toHaveLength(eventCount);
    expect(current.killed).toBe(false);
    expect(h.list().map(session => [session.sessionId, session.status])).toEqual([['reused', 'running']]);
  });

  it('preserves an exited action record when a replacement fails before explicit removal', async () => {
    const h = createHarness();
    await h.create(action('old'));
    h.processes[0].emitData('retained output');
    h.processes[0].emitExit();
    const gate = h.pauseSpawn();
    const replacement = h.create(action('new'));
    await gate.entered;
    gate.reject(new Error('fixture spawn failed'));
    expect((await replacement).body).toEqual({ error: 'fixture spawn failed' });
    expect(h.list().map(session => [session.sessionId, session.status])).toEqual([['old', 'exited']]);
    expect(h.processes).toHaveLength(1);
  });

  it('cancels pending recreation of an exited record removed by action supersession', async () => {
    const h = createHarness();
    await h.create(action('old'));
    h.processes[0].emitExit();
    const gate = h.pauseSpawn();
    const recreation = h.create({ sessionId: 'old' });
    await gate.entered;
    expect((await h.create(action('new'))).statusCode).toBe(200);
    gate.resolve();
    expect((await recreation).statusCode).toBe(400);
    expect(h.processes.at(-1).killed).toBe(true);
    expect(h.list().map(session => session.sessionId)).toEqual(['new']);
    expect(h.processes[1].killed).toBe(false);
  });

  it('cancels pending recreation when its exited record expires', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const h = createHarness();
    await h.create({ sessionId: 'expired' });
    h.processes[0].emitExit();
    const gate = h.pauseSpawn();
    const creation = h.create({ sessionId: 'expired' });
    await gate.entered;
    vi.advanceTimersByTime(35 * 60 * 1000);
    expect(h.list()).toEqual([]);
    gate.resolve();
    expect((await creation).statusCode).toBe(400);
    expect(h.processes.at(-1).killed).toBe(true);
    expect(h.list()).toEqual([]);
  });
});

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const liveProcesses = h => h.processes.filter(child => !child.exited && !child.killed);
const replace = (h, operation) => operation === 'create' ? h.create({ sessionId: 'owned' }) : h.restart('owned');

describe('terminal replacement ownership', () => {
  for (const firstOperation of ['create', 'restart']) {
    const secondOperation = firstOperation === 'create' ? 'restart' : 'create';
    for (const releaseSecondFirst of [false, true]) {
      it(`keeps one owned process for ${firstOperation} then ${secondOperation}, releasing ${releaseSecondFirst ? 'second' : 'first'} spawn first`, async () => {
        const h = createHarness();
        await h.create({ sessionId: 'owned' });
        h.processes[0].emitExit();
        const firstGate = h.pauseSpawn();
        const first = replace(h, firstOperation);
        await firstGate.entered;
        const secondGate = h.pauseSpawn();
        const second = replace(h, secondOperation);
        await nextTurn();
        if (releaseSecondFirst) {
          secondGate.resolve();
          await nextTurn();
          firstGate.resolve();
        } else {
          firstGate.resolve();
          await first;
          secondGate.resolve();
        }
        const results = await Promise.all([first, second]);
        expect(results.map(result => result.statusCode)).toEqual([200, 200]);
        expect(liveProcesses(h)).toHaveLength(1);
        expect(h.processes).toHaveLength(firstOperation === 'create' ? 3 : 2);
        const current = liveProcesses(h)[0];
        await h.resize('owned');
        expect(current.resizes).toEqual([[91, 31]]);
        const eventCount = h.events.length;
        for (const child of h.processes.filter(child => child !== current)) {
          child.emitData('stale output');
          child.emitExit();
        }
        expect(h.events).toHaveLength(eventCount);
        expect(h.list().map(session => [session.sessionId, session.status])).toEqual([['owned', 'running']]);
        await h.close('owned');
        expect(liveProcesses(h)).toEqual([]);
      });
    }

    it(`releases the queue after ${firstOperation} spawn fails`, async () => {
      const h = createHarness();
      await h.create({ sessionId: 'owned' });
      h.processes[0].emitData('retained output');
      h.processes[0].emitExit();
      const gate = h.pauseSpawn();
      const first = replace(h, firstOperation);
      await gate.entered;
      const second = replace(h, secondOperation);
      gate.reject(new Error('first spawn failed'));
      const results = await Promise.all([first, second]);
      expect(results[0].body).toEqual({ error: 'first spawn failed' });
      expect(results[1].statusCode).toBe(200);
      expect(liveProcesses(h)).toHaveLength(1);
      expect(h.list()[0].status).toBe('running');
      await h.close('owned');
      expect(liveProcesses(h)).toEqual([]);
    });

    for (const removal of ['close', 'force-kill', 'shutdown']) {
      for (const rejectSpawn of [false, true]) {
        it(`${removal} invalidates ${firstOperation} then ${secondOperation} with ${rejectSpawn ? 'failed' : 'late'} spawn`, async () => {
          const h = createHarness();
          await h.create({ sessionId: 'peer', cwd: '/elsewhere' });
          await h.create({ sessionId: 'owned' });
          h.processes[1].emitExit();
          const gate = h.pauseSpawn();
          const first = replace(h, firstOperation);
          await gate.entered;
          const second = replace(h, secondOperation);
          const removing = removal === 'close' ? h.close('owned')
            : removal === 'force-kill' ? h.kill({ sessionId: 'owned' }) : h.runtime.shutdown();
          if (removal === 'shutdown') {
            expect(h.runtime.shutdown()).toBe(removing);
            expect((await h.create({ sessionId: 'later' })).statusCode).toBe(400);
          } else {
            expect(h.list().map(session => session.sessionId)).toEqual(['peer']);
          }
          if (rejectSpawn) gate.reject(new Error('retired spawn failed'));
          else gate.resolve();
          const [firstResult, secondResult] = await Promise.all([first, second, removing]);
          expect(firstResult.statusCode).toBe(400);
          expect(secondResult.statusCode).toBe(400);
          if (rejectSpawn) expect(firstResult.body).toEqual({ error: 'retired spawn failed' });
          expect(h.processes.slice(2).every(child => child.killed)).toBe(true);
          expect(liveProcesses(h)).toHaveLength(removal === 'shutdown' ? 0 : 1);
          expect(h.list().map(session => session.sessionId)).toEqual(removal === 'shutdown' ? [] : ['peer']);
          if (removal !== 'shutdown') {
            expect((await h.create({ sessionId: 'owned' })).statusCode).toBe(200);
            const current = h.processes.at(-1);
            const eventCount = h.events.length;
            for (const child of h.processes.slice(1, -1)) { child.emitData('retired'); child.emitExit(); }
            expect(current.killed).toBe(false);
            expect(h.events).toHaveLength(eventCount);
            expect(h.list().map(session => [session.sessionId, session.status])).toEqual([['peer', 'running'], ['owned', 'running']]);
          }
        });
      }
    }

    it(`does not block another ID while ${firstOperation} and ${secondOperation} wait`, async () => {
      const h = createHarness();
      await h.create({ sessionId: 'owned' });
      h.processes[0].emitExit();
      const gate = h.pauseSpawn();
      const first = replace(h, firstOperation);
      await gate.entered;
      const second = replace(h, secondOperation);
      expect((await h.create({ sessionId: 'peer', cwd: '/elsewhere' })).statusCode).toBe(200);
      expect((await h.restart('peer')).statusCode).toBe(200);
      const peer = h.processes.at(-1);
      await h.kill({ cwd: '/repo' });
      gate.resolve();
      await Promise.all([first, second]);
      expect(peer.killed).toBe(false);
      expect(liveProcesses(h)).toEqual([peer]);
      expect(h.list().map(session => session.sessionId)).toEqual(['peer']);
    });
  }

  it('retains a committed recreation when its queued restart spawn fails', async () => {
    const h = createHarness();
    await h.create({ sessionId: 'owned' });
    h.processes[0].emitExit();
    const createGate = h.pauseSpawn();
    const creating = h.create({ sessionId: 'owned' });
    await createGate.entered;
    const restartGate = h.pauseSpawn();
    const restarting = h.restart('owned');
    await nextTurn();
    createGate.resolve();
    expect((await creating).statusCode).toBe(200);
    await restartGate.entered;
    const committed = h.processes.at(-1);
    restartGate.reject(new Error('later spawn failed'));
    expect((await restarting).body).toEqual({ error: 'later spawn failed' });
    expect(liveProcesses(h)).toEqual([committed]);
    await h.resize('owned');
    expect(committed.resizes).toEqual([[91, 31]]);
    expect((await h.restart('owned')).statusCode).toBe(200);
    expect(committed.killed).toBe(true);
    expect(liveProcesses(h)).toHaveLength(1);
  });

  it('serializes queued restarts and terminates their superseded processes', async () => {
    const h = createHarness();
    await h.create({ sessionId: 'owned' });
    const gate = h.pauseSpawn();
    const first = h.restart('owned');
    await gate.entered;
    const second = h.restart('owned');
    gate.resolve();
    expect((await Promise.all([first, second])).map(result => result.statusCode)).toEqual([200, 200]);
    expect(h.processes.map(child => child.killed)).toEqual([true, true, false]);
    expect(liveProcesses(h)).toEqual([h.processes[2]]);
  });

  it('keeps compatible creation single-flight while replacement is queued behind restart', async () => {
    const h = createHarness();
    await h.create({ sessionId: 'owned' });
    h.processes[0].emitExit();
    const gate = h.pauseSpawn();
    const restarting = h.restart('owned');
    await gate.entered;
    const firstCreate = h.create({ sessionId: 'owned' });
    const duplicate = h.create({ sessionId: 'owned' });
    expect((await h.create({ sessionId: 'owned', shell: 'bash' })).statusCode).toBe(400);
    gate.resolve();
    expect((await Promise.all([restarting, firstCreate, duplicate])).map(result => result.statusCode)).toEqual([200, 200, 200]);
    expect(h.processes).toHaveLength(2);
    expect(liveProcesses(h)).toHaveLength(1);
  });

  it('rechecks running-session compatibility after a queued restart changes cwd', async () => {
    const h = createHarness();
    await h.create({ sessionId: 'owned' });
    h.processes[0].emitExit();
    const gate = h.pauseSpawn();
    const restarting = h.restart('owned', { cwd: '/other' });
    await gate.entered;
    const creating = h.create({ sessionId: 'owned' });
    gate.resolve();
    expect((await restarting).statusCode).toBe(200);
    expect((await creating).body).toEqual({ error: 'Terminal session belongs to a different working directory' });
    expect(h.processes).toHaveLength(2);
    expect(liveProcesses(h)).toEqual([h.processes[1]]);
    expect(h.list()[0].cwd).toBe('/other');
  });

  it('rejects a queued restart after recreation commits command mode', async () => {
    const h = createHarness();
    await h.create({ sessionId: 'owned' });
    h.processes[0].emitExit();
    const gate = h.pauseSpawn();
    const creating = h.create({ sessionId: 'owned', mode: 'command', command: 'echo fixture' });
    await gate.entered;
    const restarting = h.restart('owned');
    gate.resolve();
    expect((await creating).statusCode).toBe(200);
    expect((await restarting).body).toEqual({ error: 'Command-mode terminal sessions cannot be restarted' });
    expect(h.processes).toHaveLength(2);
    expect(liveProcesses(h)).toEqual([h.processes[1]]);
    expect(h.list()[0].mode).toBe('command');
  });

  it('keeps a new same-ID owner queued after close safe from the old restart', async () => {
    const h = createHarness();
    await h.create({ sessionId: 'owned' });
    const gate = h.pauseSpawn();
    const restarting = h.restart('owned');
    await gate.entered;
    await h.close('owned');
    const creating = h.create({ sessionId: 'owned' });
    gate.resolve();
    expect((await restarting).statusCode).toBe(400);
    expect((await creating).statusCode).toBe(200);
    const current = h.processes.at(-1);
    const eventCount = h.events.length;
    for (const child of h.processes.slice(0, -1)) { child.emitData('retired'); child.emitExit(); }
    expect(h.events).toHaveLength(eventCount);
    expect(liveProcesses(h)).toEqual([current]);
    expect(h.list().map(session => [session.sessionId, session.status])).toEqual([['owned', 'running']]);
  });
});
