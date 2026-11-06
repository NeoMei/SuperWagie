import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from '../../../../../../scripts/perf/cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../../../../../..');

test('user center hands off to the actual Models quick setup from Settings and the sidebar dialog', { timeout: 120_000 }, async () => {
  const { createServer } = await import('vite');
  mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repo, 'tmp/platform-account-navigation-'));
  writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import '@/index.css';
    const user = { id: 'fixture-user', name: 'Fixture reviewer', email: 'reviewer@example.test' };
    window.mutations = [];
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method !== 'GET') {
        window.mutations.push({ path: url.pathname, method });
        return Response.json({ error: 'fixture_mutation_disabled' }, { status: 409 });
      }
      if (url.pathname.endsWith('/api/platform-account/session')) return Response.json({ status: 'signed-in', user, expiresAt: '2027-01-01T12:00:00Z' });
      if (url.pathname.endsWith('/api/platform-account/profile')) return Response.json({ id: user.id, username: 'fixture-reviewer', displayName: user.name, email: user.email, avatarAvailable: false, version: '1' });
      if (url.pathname.endsWith('/api/platform-account')) return Response.json({ status: 'signed-in', user, accounts: [{ id: 'fixture-team', name: 'Fixture team', kind: 'team', role: 'owner' }], accountId: 'fixture-team', expiresAt: '2027-01-01T12:00:00Z', membership: [], credits: { available: '0', reserved: '0' }, consoleUrl: null, modelService: 'unavailable' });
      if (url.pathname.endsWith('/api/model-configuration')) return Response.json({ version: 1, revision: 1, enterpriseMode: false, credentialSources: { status: 'available', sources: [] }, purposes: [], presets: [], connections: [], bindings: [] });
      if (url.pathname.endsWith('/api/config/settings')) return Response.json({});
      if (url.pathname.endsWith('/fs/home')) return Response.json({ home: '/fixture' });
      if (url.pathname.endsWith('/location')) return Response.json({ directory: '/fixture', project: { directory: '/fixture' } });
      return Response.json([]);
    };
    const [{ I18nProvider, useI18nStore }, { RuntimeAPIContext }, { createWebAPIs }, { SidebarFooter }, { SettingsView }, { useUIStore }, { CSSVariableGenerator }, { getDefaultTheme }] = await Promise.all([
      import('@/lib/i18n'), import('@/contexts/runtimeAPIContext'), import('@web/api/index'),
      import('@/components/session/sidebar/shell/SidebarFooter'), import('@/components/views/SettingsView'),
      import('@/stores/useUIStore'), import('@/lib/theme/cssGenerator'), import('@/lib/theme/themes'),
    ]);
    useI18nStore.getState().setLocale('en');
    const fromSettings = new URLSearchParams(location.search).get('entry') === 'settings';
    useUIStore.setState({ isSettingsDialogOpen: fromSettings, settingsPage: 'platform-account', settingsJumpRequest: null });
    new CSSVariableGenerator().apply(getDefaultTheme(false));
    function EntryPoints() {
      const settingsOpen = useUIStore(state => state.isSettingsDialogOpen);
      return <><SidebarFooter onOpenSettings={() => useUIStore.getState().setSettingsDialogOpen(true)} onOpenShortcuts={() => {}} onOpenAbout={() => {}} onOpenUpdate={() => {}} showUpdateButton={false} />
        {settingsOpen ? <div data-fixture-settings-window style={{ height: '90vh' }}><SettingsView isWindowed forceMobile={false} /></div> : null}</>;
    }
    createRoot(document.getElementById('root')).render(<RuntimeAPIContext.Provider value={createWebAPIs()}><I18nProvider><EntryPoints /></I18nProvider></RuntimeAPIContext.Provider>);
  `);
  const server = await createServer({
    configFile: false, root: fixture, cacheDir: path.join(fixture, '.vite'), logLevel: 'error',
    css: { postcss: repo },
    define: { 'process.env': {}, global: 'globalThis', __APP_VERSION__: '"fixture"' },
    resolve: { alias: { '@': path.join(repo, 'packages/ui/src'), '@web': path.join(repo, 'packages/web/src'), '@openchamber/ui': path.join(repo, 'packages/ui/src'), '@openchamber/sdk/schemas': path.join(repo, 'packages/sdk/src/schemas.ts'), '@openchamber/sdk': path.join(repo, 'packages/sdk/src/index.ts') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo, fixture] } },
  });
  const profile = resolveProfileDir(undefined, 'account-navigation');
  let chrome;
  let cdp;
  try {
    await server.listen();
    const port = await reservePort();
    chrome = launchChrome({ chrome: resolveChrome(), profileDir: profile.dir, port, headless: true });
    const target = await createPageTarget(port);
    cdp = new CdpClient(target.webSocketDebuggerUrl); await cdp.connect();
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
      return result.result.value;
    };
    const until = async (expression, description) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await wait(50);
      }
      assert.fail(description + ': ' + (await evaluate('document.body.innerText')).slice(0, 2000));
    };
    const click = async (selector) => {
      const point = await evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    for (const entry of ['sidebar', 'settings']) {
      await cdp.send('Page.navigate', { url: server.resolvedUrls.local[0] + '?entry=' + entry });
      if (entry === 'sidebar') {
        await until(`!!document.querySelector('button[aria-label="User center"]')`, 'Sidebar account entry did not render');
        await click('button[aria-label="User center"]');
      }
      await until(`!![...document.querySelectorAll('button')].find(button => button.textContent === 'Set up models')`, 'User center model setup action did not render');
      await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Set up models').setAttribute('data-fixture-setup', '')`);
      await click('button[data-fixture-setup]');
      await until(`!!document.querySelector('[data-fixture-settings-window] [data-settings-item="models.quick-setup"]')`, entry + ' did not reach the actual Settings Models page');
      await until(`!![...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent.includes('LLMRouter quick setup'))`, entry + ' did not open quick setup');
      const dialogs = await evaluate(`[...document.querySelectorAll('[role="dialog"]')].map(dialog => dialog.textContent)`);
      assert.equal(dialogs.filter(text => text.includes('Set up models')).length, 0, 'The independent user center still covers Settings');
      assert.equal(await evaluate(`document.querySelector('button[aria-label="User center"]').getAttribute('aria-pressed')`), 'false');
      assert.deepEqual(await evaluate('window.mutations'), [], 'Navigation must not issue keys or request model/payment mutations');
    }
  } finally {
    if (cdp) { try { await cdp.send('Browser.close', {}, { timeoutMs: 2000 }); } catch {} cdp.close(); }
    profile.removeAfter(chrome);
    await server.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
