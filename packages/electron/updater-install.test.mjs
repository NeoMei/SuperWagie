import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { keepSessionCookies } from './browser-panel-cookies.mjs';

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const extract = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'production function boundaries must exist');
  return source.slice(from, to);
};
const installSource = extract('const UPDATE_INSTALL_GRACE_MS =', '\nconst buildInstalledAppsCachePath');
const flushSource = extract('const RENDERER_STORAGE_FLUSH_TIMEOUT_MS =', '\nconst prepareForQuit');
const beforeQuitSource = extract("app.on('before-quit',", '\nconst handleSecondInstance');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();

function timers() {
  const pending = new Map();
  return {
    pending,
    setTimeout(callback, ms) { const timer = { callback, ms }; pending.set(timer, timer); return timer; },
    clearTimeout(timer) { pending.delete(timer); },
    fire(ms) {
      const timer = [...pending.values()].find(item => item.ms === ms);
      assert.ok(timer, `a ${ms}ms timer must be pending`);
      pending.delete(timer);
      timer.callback();
    },
  };
}

// Run the production function without importing Electron or starting its server.
// Only native updater, shutdown and timer operations are controlled here.
function installer({ shutdown = async () => {}, flush = async () => {}, linux = false, installLinux = async () => {}, handoff = () => {} } = {}) {
  const clock = timers();
  const state = { updateInstallPending: false, quitRequested: false, installingUpdate: false, quitConfirmationPending: true, pendingUpdate: { downloadedFile: '/fixture/update.deb' } };
  const events = [];
  const updater = new EventEmitter();
  const relaunches = [];
  let scheduled;
  updater.quitAndInstall = () => { events.push('install'); handoff(state); };
  const install = vm.runInNewContext(`${installSource}\ninstallDownloadedUpdate;`, {
    Promise, Error, state, autoUpdater: updater,
    log: { info() {}, warn() {}, error() {} },
    setImmediate(callback) { scheduled = callback; },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    shutdownBackgroundServices: async () => { events.push('shutdown'); await shutdown(); },
    flushRendererStorage: async () => { events.push('flush'); await flush(); events.push('flushed'); },
    isLinuxPackageInstall: () => linux, readLinuxPackageType: () => 'deb',
    installLinuxPackage: installLinux,
    performConfirmedQuit: options => { relaunches.push({ relaunch: options.relaunch, pending: state.updateInstallPending, installing: state.installingUpdate }); },
  });
  const result = install();
  // Attach a rejection handler before an asynchronous updater error can fire.
  result.catch(() => {});
  return { state, events, updater, relaunches, clock, result, start: () => scheduled() };
}

test('ordinary install preserves pending arbitration until renderer storage finishes', async () => {
  const cleanup = deferred();
  const storage = deferred();
  const h = installer({ shutdown: () => cleanup.promise, flush: () => storage.promise,
    handoff(state) {
      assert.equal(state.quitRequested, true);
      assert.equal(state.installingUpdate, true);
      assert.equal(state.quitConfirmationPending, false);
    },
  });
  assert.equal(h.state.updateInstallPending, true);
  assert.deepEqual(h.events, []);
  const running = h.start();
  await turn();
  assert.deepEqual(h.events, ['shutdown']);
  cleanup.resolve();
  await turn();
  assert.deepEqual(h.events, ['shutdown', 'flush']);
  assert.equal(h.state.updateInstallPending, true);
  assert.equal(h.state.quitRequested, false);
  assert.equal(h.state.installingUpdate, false);
  assert.equal([...h.clock.pending.values()].some(timer => timer.ms === 15_000), false);
  storage.resolve();
  await running;
  assert.deepEqual(h.events, ['shutdown', 'flush', 'flushed', 'install']);
  assert.equal(h.state.updateInstallPending, false);
  assert.equal([...h.clock.pending.values()].some(timer => timer.ms === 40_000), false);
  let replied = false;
  h.result.then(() => { replied = true; });
  await turn();
  assert.equal(replied, false);
  h.clock.fire(15_000);
  assert.equal(await h.result, null);
  assert.equal(h.updater.listenerCount('error'), 0);
});

test('updater error during storage flush rolls back and prevents a later installer handoff', async () => {
  const storage = deferred();
  const h = installer({ flush: () => storage.promise });
  const running = h.start();
  await turn();
  assert.deepEqual(h.events, ['shutdown', 'flush']);
  const error = new Error('installer rejected');
  h.updater.emit('error', error);
  await assert.rejects(h.result, error);
  assert.equal(h.state.updateInstallPending, false);
  assert.equal(h.state.quitRequested, false);
  assert.equal(h.state.installingUpdate, false);
  assert.deepEqual(h.relaunches, [{ relaunch: true, pending: false, installing: false }]);
  storage.resolve();
  await running;
  assert.deepEqual(h.events, ['shutdown', 'flush', 'flushed']);
  assert.equal(h.clock.pending.size, 0);
  assert.equal(h.updater.listenerCount('error'), 0);
});

test('background shutdown deadline still waits for storage before handing over', async () => {
  const h = installer({ shutdown: () => new Promise(() => {}) });
  const running = h.start();
  await turn();
  h.clock.fire(40_000);
  await running;
  assert.deepEqual(h.events, ['shutdown', 'flush', 'flushed', 'install']);
  assert.equal([...h.clock.pending.values()].some(timer => timer.ms === 40_000), false);
  h.clock.fire(15_000);
  await h.result;
});

test('installer rejection after storage flush reaches the caller and relaunches the current version', async () => {
  const error = new Error('invalid signature');
  const h = installer({ handoff() { throw error; } });
  await h.start();
  await assert.rejects(h.result, error);
  assert.deepEqual(h.events, ['shutdown', 'flush', 'flushed', 'install']);
  assert.deepEqual(h.relaunches, [{ relaunch: true, pending: false, installing: false }]);
  assert.equal(h.state.quitRequested, false);
  assert.equal(h.clock.pending.size, 0);
  assert.equal(h.updater.listenerCount('error'), 0);
});

for (const cancelled of [false, true]) {
  test(`Linux package ${cancelled ? 'cancellation' : 'success'} keeps its confirmed-quit path`, async () => {
    const packageInstall = deferred();
    const h = installer({ linux: true, flush() { assert.fail('Linux persists through confirmed quit'); },
      installLinux(input) { assert.equal(input.packageType, 'deb'); assert.equal(input.file, '/fixture/update.deb'); return packageInstall.promise; },
    });
    const running = h.start();
    await turn();
    assert.equal(h.state.updateInstallPending, true);
    assert.equal(h.updater.listenerCount('error'), 0);
    if (cancelled) packageInstall.reject(new Error('password prompt cancelled'));
    else packageInstall.resolve();
    await running;
    if (cancelled) await assert.rejects(h.result, /password prompt cancelled/);
    else assert.equal(await h.result, null);
    assert.deepEqual(h.events, ['shutdown']);
    assert.deepEqual(h.relaunches, [{ relaunch: true, pending: false, installing: false }]);
    assert.equal(h.clock.pending.size, 0);
  });
}

function storageFlush({ stalledPage = false } = {}) {
  const clock = timers();
  const events = [];
  const writes = [];
  const panelSession = { cookies: {
    get: async () => [{ name: 'sid', value: 'fixture', domain: 'example.test', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: true }],
    set: async details => { writes.push(details); events.push('cookie-persistent'); },
    flushStore: async () => { events.push('cookie-store'); },
  }, flushStorageData() { events.push('panel-storage'); } };
  const flush = vm.runInNewContext(`${flushSource}\nflushRendererStorage;`, {
    Promise, keepSessionCookies, BROWSER_PANEL_PARTITION: 'persist:openchamber-browser',
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: {
      executeJavaScript: async () => { events.push('renderer'); if (stalledPage) await new Promise(() => {}); },
    } }] },
    session: { fromPartition(partition) { assert.equal(partition, 'persist:openchamber-browser'); return panelSession; },
      defaultSession: { flushStorageData() { events.push('default-storage'); } } },
    log: { warn() { assert.fail('storage fixture must flush successfully'); } },
    setTimeout: clock.setTimeout,
  });
  return { flush, clock, events, writes };
}

test('production flush converts browser session cookies before committing both storage sessions', async () => {
  const h = storageFlush();
  const before = Date.now() / 1000;
  await h.flush();
  assert.deepEqual(h.events, ['renderer', 'cookie-persistent', 'cookie-store', 'default-storage', 'panel-storage']);
  assert.equal(h.writes.length, 1);
  const cookie = h.writes[0];
  assert.equal(cookie.url, 'https://example.test/');
  assert.equal(cookie.domain, undefined);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'lax');
  assert.ok(cookie.expirationDate >= before + 400 * 24 * 60 * 60);
});

test('production flush commits storage after its deadline when a renderer does not answer', async () => {
  const h = storageFlush({ stalledPage: true });
  const flushing = h.flush();
  await turn();
  assert.deepEqual(h.events, ['renderer', 'cookie-persistent', 'cookie-store']);
  h.clock.fire(500);
  await flushing;
  assert.deepEqual(h.events, ['renderer', 'cookie-persistent', 'cookie-store', 'default-storage', 'panel-storage']);
});

function beforeQuit(state, platform) {
  const events = [];
  let handler;
  vm.runInNewContext(beforeQuitSource, {
    state, process: { platform },
    app: { on(name, callback) { assert.equal(name, 'before-quit'); handler = callback; } },
    closeAllDevTunnels: () => events.push('close-tunnels'),
    requestQuitWithConfirmation: () => events.push('confirm'),
    performConfirmedQuit: () => events.push('confirmed-quit'),
  });
  return { events, quit() {
    let prevented = false;
    handler({ preventDefault() { prevented = true; } });
    return prevented;
  } };
}

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`${platform} regular quit cannot interrupt deferred flush, while installer-owned quit proceeds`, async () => {
    const storage = deferred();
    let quit;
    const h = installer({ shutdown() { h.state.backgroundShutdownComplete = true; }, flush: () => storage.promise,
      handoff(state) {
        // quitAndInstall can synchronously quit before pending is cleared.
        assert.equal(state.updateInstallPending, true);
        assert.equal(quit.quit(), false);
      },
    });
    quit = beforeQuit(h.state, platform);
    const running = h.start();
    await turn();
    assert.equal(h.state.backgroundShutdownComplete, true);
    assert.deepEqual(h.events, ['shutdown', 'flush']);
    assert.equal(quit.quit(), true);
    assert.equal(h.state.quitRequested, false);
    assert.equal(h.state.updateInstallPending, true);
    assert.deepEqual(quit.events, []);
    storage.resolve();
    await running;
    assert.deepEqual(h.events, ['shutdown', 'flush', 'flushed', 'install']);
    assert.deepEqual(quit.events, ['close-tunnels']);
    assert.equal(h.state.quitRequested, true);
    h.clock.fire(15_000);
    await h.result;
  });

  test(`${platform} install failure releases the before-quit guard for confirmed relaunch`, async () => {
    const storage = deferred();
    const h = installer({ shutdown() { h.state.backgroundShutdownComplete = true; }, flush: () => storage.promise });
    const quit = beforeQuit(h.state, platform);
    const running = h.start();
    await turn();
    h.updater.emit('error', new Error('install failed during flush'));
    await assert.rejects(h.result, /install failed during flush/);
    assert.equal(h.state.updateInstallPending, false);
    assert.equal(h.state.installingUpdate, false);
    assert.deepEqual(h.relaunches, [{ relaunch: true, pending: false, installing: false }]);
    // performConfirmedQuit's preparation marks the subsequent exit confirmed.
    h.state.quitConfirmed = true;
    assert.equal(quit.quit(), false);
    assert.equal(h.state.quitRequested, true);
    assert.deepEqual(quit.events, ['close-tunnels']);
    storage.resolve();
    await running;
    assert.equal(h.events.includes('install'), false);
  });
}

test('ordinary macOS quit still requests confirmation when no install is pending', () => {
  const state = { updateInstallPending: false, installingUpdate: false, quitConfirmed: false, backgroundShutdownComplete: true };
  const quit = beforeQuit(state, 'darwin');
  assert.equal(quit.quit(), true);
  assert.equal(state.quitRequested, true);
  assert.deepEqual(quit.events, ['close-tunnels', 'confirm']);
});

test('ordinary quit still prepares an incomplete backend shutdown when no install is pending', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const state = { updateInstallPending: false, installingUpdate: false, quitConfirmed: true, backgroundShutdownComplete: false };
    const quit = beforeQuit(state, platform);
    assert.equal(quit.quit(), true);
    assert.equal(state.quitRequested, true);
    assert.deepEqual(quit.events, ['close-tunnels', 'confirmed-quit']);
  }
});
