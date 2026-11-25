import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from './cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const closeTimeout = 2_000;

export const closeChrome = async (chrome, cdp) => {
  if (cdp?.socket.readyState === WebSocket.OPEN) {
    await cdp.send('Browser.close', {}, { timeoutMs: closeTimeout }).catch(() => {});
  }
  cdp?.close();
  if (!chrome?.pid || chrome.exitCode !== null || chrome.signalCode !== null) return;
  try {
    await once(chrome, 'exit', { signal: AbortSignal.timeout(closeTimeout) });
  } catch (error) {
    if (error.code !== 'ABORT_ERR') throw error;
    if (chrome.exitCode !== null || chrome.signalCode !== null) return;
    const exit = once(chrome, 'exit', { signal: AbortSignal.timeout(closeTimeout) });
    chrome.kill('SIGKILL');
    await exit;
  }
};

export const createBrowserFixture = (t, name) => {
  const temp = path.join(repo, 'tmp');
  mkdirSync(temp, { recursive: true });
  const directory = mkdtempSync(path.join(temp, name + '-'));

  let server;
  let profile;
  let chrome;
  let cdp;
  t.after(async () => {
    try {
      await closeChrome(chrome, cdp);
    } finally {
      try {
        await server?.close();
      } finally {
        profile?.removeAfter(chrome?.pid ? chrome : undefined);
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  const run = async (runTest, plugins = []) => {
    const { createServer } = await import('vite');
    server = await createServer({
      configFile: false,
      root: directory,
      cacheDir: path.join(directory, '.vite'),
      logLevel: 'error',
      css: { postcss: repo },
      define: { 'process.env': {}, global: 'globalThis', __APP_VERSION__: '"fixture"' },
      // Vite's scan cannot see the dev JSX runtime injected during transforms.
      optimizeDeps: { include: ['react/jsx-dev-runtime'] },
      resolve: { alias: {
        '@': path.join(repo, 'packages/ui/src'),
        '@web': path.join(repo, 'packages/web/src'),
        '@openchamber/ui': path.join(repo, 'packages/ui/src'),
        '@openchamber/sdk/schemas': path.join(repo, 'packages/sdk/src/schemas.ts'),
        '@openchamber/sdk': path.join(repo, 'packages/sdk/src/index.ts'),
      } },
      plugins,
      server: { host: '127.0.0.1', port: 0, fs: { allow: [repo, directory] } },
    });
    await server.listen();
    const url = server.resolvedUrls.local[0];
    const port = await reservePort();
    const executable = resolveChrome();
    profile = resolveProfileDir(undefined, name);
    chrome = launchChrome({ chrome: executable, profileDir: profile.dir, port, headless: true });
    await once(chrome, 'spawn');

    const target = await createPageTarget(port);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    const errors = [];
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
    });
    await cdp.send('Runtime.enable', {}, { timeoutMs: 10_000 });
    await cdp.send('Page.enable', {}, { timeoutMs: 10_000 });

    let readyLoader;
    cdp.on('Page.lifecycleEvent', ({ frameId, loaderId, name: eventName }) => {
      if (frameId === target.id && eventName === 'DOMContentLoaded') readyLoader = loaderId;
    });
    await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, { timeoutMs: 10_000 });

    const navigate = async (query = '') => {
      const destination = new URL(query, url).href;
      const { loaderId, errorText } = await cdp.send('Page.navigate', { url: destination }, { timeoutMs: 15_000 });
      assert.equal(errorText, undefined, `Could not navigate to ${destination}`);
      assert.ok(loaderId, `No document loaded for ${destination}`);
      const deadline = Date.now() + 30_000;
      while (loaderId !== readyLoader && Date.now() < deadline) await wait(25);
      assert.equal(readyLoader, loaderId, `DOM did not load for ${destination}\n${errors.join('\n')}`);
    };

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      }, { timeoutMs: 15_000 });
      assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
      return result.result.value;
    };
    await runTest({ cdp, errors, evaluate, navigate, url });
  };
  return { directory, run };
};
