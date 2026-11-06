import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from '../../../../../../scripts/perf/cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../../../../../..');

test('purpose connection tests animate while pending and retain explicit results without replay', { timeout: 120_000 }, async () => {
  const { createServer } = await import('vite');
  mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repo, 'tmp/model-test-feedback-'));
  writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import '@/index.css';
    const purposes = ['embedding', 'image-generation'];
    let configuration = {
      version: 1, revision: 1, enterpriseMode: false, credentialSources: { status: 'available', sources: [] },
      purposes: purposes.map(id => ({ id, labelKey: 'modelConfiguration.purpose.' + id, status: 'available', consumerIds: id === 'embedding' ? ['knowledge-library'] : ['superppt'], required: true, probeProtocols: ['openai-compatible'] })),
      presets: [],
      connections: [{ id: 'fixture-connection', name: 'SuperWagie test connection', providerId: 'fixture', protocol: 'openai-compatible', baseUrl: 'https://models.example.test/v1', hasApiKey: true }],
      bindings: purposes.map(purpose => ({ purpose, connectionId: 'fixture-connection', model: purpose === 'embedding' ? 'text-embedding-fixture' : 'image-generation-fixture', parameters: purpose === 'embedding' ? { dimensions: 1024 } : {}, verification: { status: 'untested' } })),
    };
    const pending = new Map();
    window.modelTestRequests = [];
    window.finishModelTest = (purpose, status) => {
      const resolve = pending.get(purpose);
      if (!resolve) throw new Error('No pending fixture test for ' + purpose);
      pending.delete(purpose);
      configuration = { ...configuration, revision: configuration.revision + 1, bindings: configuration.bindings.map(binding => binding.purpose === purpose ? { ...binding, verification: { status, testedAt: '2026-11-06T08:00:00Z', ...(status === 'failed' ? { errorCode: 'model_configuration_provider_http_400' } : {}) } } : binding) };
      resolve(Response.json(configuration));
    };
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method !== 'GET') {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        window.modelTestRequests.push({ path: url.pathname, method, body });
        const purpose = purposes.find(id => url.pathname === '/api/model-configuration/bindings/' + id + '/test');
        if (method === 'POST' && purpose) {
          if (pending.has(purpose)) throw new Error('Duplicate fixture model test');
          if (body?.revision !== configuration.revision) return Response.json({ error: 'model_configuration_revision_conflict' }, { status: 409 });
          return new Promise(resolve => pending.set(purpose, resolve));
        }
        return Response.json({ error: 'fixture_mutation_disabled' }, { status: 409 });
      }
      if (url.pathname === '/api/model-configuration') return Response.json(configuration);
      if (url.pathname === '/api/config/settings') return Response.json({});
      if (url.pathname.includes('knowledge')) return Response.json({ status: 'unavailable', reason: 'backend_unavailable' });
      if (url.pathname.endsWith('/fs/home')) return Response.json({ home: '/fixture' });
      if (url.pathname.endsWith('/location')) return Response.json({ directory: '/fixture', project: { directory: '/fixture' } });
      return Response.json([]);
    };
    const [{ I18nProvider, useI18nStore }, { RuntimeAPIContext }, { createWebAPIs }, { ModelConfigurationPage }, { CSSVariableGenerator }, { getDefaultTheme }] = await Promise.all([
      import('@/lib/i18n'), import('@/contexts/runtimeAPIContext'), import('@web/api/index'),
      import('@/components/sections/model-configuration/ModelConfigurationPage'), import('@/lib/theme/cssGenerator'), import('@/lib/theme/themes'),
    ]);
    useI18nStore.getState().setLocale('en');
    new CSSVariableGenerator().apply(getDefaultTheme(false));
    window.setModelAppearance = (dark, locale) => { new CSSVariableGenerator().apply(getDefaultTheme(dark)); document.documentElement.classList.toggle('dark', dark); useI18nStore.getState().setLocale(locale); };
    createRoot(document.getElementById('root')).render(<RuntimeAPIContext.Provider value={createWebAPIs()}><I18nProvider><main style={{ height: '100vh' }}><ModelConfigurationPage /></main></I18nProvider></RuntimeAPIContext.Provider>);
  `);
  const server = await createServer({
    configFile: false, root: fixture, cacheDir: path.join(fixture, '.vite'), logLevel: 'error', css: { postcss: repo },
    define: { 'process.env': {}, global: 'globalThis', __APP_VERSION__: '"fixture"' },
    resolve: { alias: { '@': path.join(repo, 'packages/ui/src'), '@web': path.join(repo, 'packages/web/src'), '@openchamber/ui': path.join(repo, 'packages/ui/src'), '@openchamber/sdk/schemas': path.join(repo, 'packages/sdk/src/schemas.ts'), '@openchamber/sdk': path.join(repo, 'packages/sdk/src/index.ts') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo, fixture] } },
  });
  const profile = resolveProfileDir(undefined, 'model-test-feedback');
  let chrome;
  let cdp;
  try {
    await server.listen();
    const port = await reservePort();
    chrome = launchChrome({ chrome: resolveChrome(), profileDir: profile.dir, port, headless: true });
    const target = await createPageTarget(port);
    cdp = new CdpClient(target.webSocketDebuggerUrl); await cdp.connect();
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    const errors = [];
    cdp.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text));
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
      return result.result.value;
    };
    const until = async (expression, message) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await wait(50); }
      assert.fail(message + ': ' + (await evaluate('document.body.innerText')).slice(0, 2400));
    };
    const clickButton = async (label, byAria = false) => {
      const expression = `(() => { const button = [...document.querySelectorAll('button')].find(item => !item.closest('[hidden]') && (item.${byAria ? "getAttribute('aria-label')" : 'textContent'}) === ${JSON.stringify(label)}); return button && !button.disabled; })()`;
      await until(expression, label + ' is unavailable');
      const point = await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(item => !item.closest('[hidden]') && (item.${byAria ? "getAttribute('aria-label')" : 'textContent'}) === ${JSON.stringify(label)}); button.scrollIntoView({ block: 'center' }); const r = button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    const panel = purpose => `[role="region"][aria-label="${purpose === 'embedding' ? 'Text embedding' : 'Image generation'} connection test"]`;
    const panelText = purpose => `document.querySelector(${JSON.stringify(panel(purpose))})?.innerText ?? ''`;
    const motion = async (purpose, selector = panel(purpose)) => evaluate(`(() => { const region = document.querySelector(${JSON.stringify(selector)}); return {
      spinner: [...region.querySelectorAll('[data-spinner] path')].map(item => item.getAttribute('opacity')).join(','),
      bar: [...region.querySelectorAll('[role="progressbar"], [role="progressbar"] *')].map(item => item.getAttribute('style') ?? '').join('|'),
    }; })()`);
    const assertTesting = async purpose => {
      await until(`!!document.querySelector(${JSON.stringify(panel(purpose) + ' [role="progressbar"]')})`, purpose + ' test did not immediately show its own progress panel');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(panel(purpose) + ' [role="progressbar"]')}).hasAttribute('aria-valuenow')`), false, 'A model probe cannot report a fabricated percentage');
      assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(panel(purpose) + ' [data-spinner]')})`), true, 'A running test needs its visible waiting indicator');
      assert.equal(await evaluate(`(${panelText(purpose)}).includes('Testing connection')`), true);
    };
    const capture = async (purpose, name, width = 1280, dark = false) => {
      await evaluate(`document.querySelector(${JSON.stringify(panel(purpose))}).dataset.fixtureFeedback = ''`);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await evaluate(`window.setModelAppearance(${dark}, 'zh-CN')`);
      await wait(80);
      await evaluate(`document.querySelector('[data-fixture-feedback]').scrollIntoView({ block: 'center' })`);
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'Model test feedback overflows the viewport');
      assert.equal(await evaluate(`(() => { const region = document.querySelector('[data-fixture-feedback]'); const box = region.getBoundingClientRect(); return region.scrollWidth <= region.clientWidth && box.left >= 0 && box.right <= innerWidth; })()`), true, 'Model test feedback must stay within a narrow pane');
      if (process.env.MODEL_TEST_EVIDENCE_DIR) {
        mkdirSync(process.env.MODEL_TEST_EVIDENCE_DIR, { recursive: true });
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        writeFileSync(path.join(process.env.MODEL_TEST_EVIDENCE_DIR, `${purpose}-${name}-${width}-${dark ? 'dark' : 'light'}-zh-CN.png`), Buffer.from(screenshot.data, 'base64'));
      }
      await evaluate(`window.setModelAppearance(false, 'en'); document.querySelector('[data-fixture-feedback]').removeAttribute('data-fixture-feedback')`);
      await wait(50);
    };
    const assertTerminal = async (purpose, status) => {
      await until(`(${panelText(purpose)}).includes(${JSON.stringify(status === 'verified' ? 'Connection test passed' : 'Connection test failed')})`, purpose + ' did not retain its terminal result');
      assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(panel(purpose) + ' [role="progressbar"]')})`), false, 'A finished test must stop its progress indicator');
      assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(panel(purpose) + ' [data-spinner]')})`), false, 'A finished test must stop spinning');
      const before = await motion(purpose); await wait(350);
      assert.deepEqual(await motion(purpose), before, 'Terminal feedback must remain still');
    };

    await cdp.send('Page.navigate', { url: server.resolvedUrls.local[0] });
    await until(`!!document.querySelector('[data-model-purpose="embedding"]')`, 'The real model overview did not render');
    assert.deepEqual(await evaluate('window.modelTestRequests'), [], 'Opening model settings must not run probes');
    await clickButton('Test Text embedding', true);
    await assertTesting('embedding');
    const embeddingFrames = [await motion('embedding')];
    for (let index = 0; index < 4; index++) { await wait(350); embeddingFrames.push(await motion('embedding')); }
    assert.ok(new Set(embeddingFrames.map(frame => frame.spinner)).size > 1, 'The shared spinner must visibly change during a deferred test');
    assert.ok(new Set(embeddingFrames.map(frame => frame.bar)).size > 1, 'The indeterminate waiting bar must change during a deferred test');
    assert.equal(await evaluate('window.modelTestRequests.length'), 1, 'Waiting must not dispatch another test');
    await capture('embedding', 'testing');
    await capture('embedding', 'testing', 390);
    await evaluate(`window.finishModelTest('embedding', 'verified')`);
    await assertTerminal('embedding', 'verified');
    await capture('embedding', 'verified', 1280);

    await clickButton('Configure Image generation', true);
    await clickButton('Test saved binding');
    await assertTesting('image-generation');
    assert.equal(await evaluate('window.modelTestRequests.length'), 2);
    await capture('image-generation', 'testing', 1280);
    await capture('image-generation', 'testing', 390);
    await capture('image-generation', 'testing', 1280, true);

    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await until(`matchMedia('(prefers-reduced-motion: reduce)').matches`, 'Reduced motion preference was not applied');
    await wait(100);
    const reduced = await motion('image-generation'); await wait(1250);
    assert.deepEqual(await motion('image-generation'), reduced, 'Reduced motion must freeze the spinner and waiting bar while preserving pending feedback');
    await assertTesting('image-generation');
    await capture('image-generation', 'testing-reduced-motion', 390);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await wait(100);
    await evaluate(`document.querySelector(${JSON.stringify(panel('image-generation'))}).dataset.fixturePausedFeedback = ''`);
    await clickButton('Overview');
    await until(`!!document.querySelector('[data-fixture-paused-feedback]')?.closest('[hidden]')`, 'Leaving the purpose tab did not hide its pending test');
    const hidden = await motion('image-generation', '[data-fixture-paused-feedback]'); await wait(1250);
    assert.deepEqual(await motion('image-generation', '[data-fixture-paused-feedback]'), hidden, 'An offscreen purpose test must pause both waiting indicators');
    assert.equal(await evaluate('window.modelTestRequests.length'), 2, 'Tab changes must not redispatch a test');
    await clickButton('Purposes');
    await assertTesting('image-generation');
    const resumed = await motion('image-generation'); await wait(1250);
    assert.notDeepEqual(await motion('image-generation'), resumed, 'Returning to the pending purpose must restore its waiting animation');
    await evaluate(`document.querySelector('[data-fixture-paused-feedback]').removeAttribute('data-fixture-paused-feedback')`);
    await evaluate(`window.finishModelTest('image-generation', 'failed')`);
    await assertTerminal('image-generation', 'failed');
    await capture('image-generation', 'failed', 1280);
    await capture('image-generation', 'failed', 390);
    await wait(300);
    assert.equal(await evaluate('window.modelTestRequests.length'), 2, 'A failed model test must wait for an explicit retry');
    await clickButton('Test saved binding');
    await assertTesting('image-generation');
    assert.equal(await evaluate(`(${panelText('image-generation')}).includes('Connection test failed')`), false, 'Retry feedback must represent the new request');
    await evaluate(`window.finishModelTest('image-generation', 'verified')`);
    await assertTerminal('image-generation', 'verified');
    await capture('image-generation', 'verified', 1280);
    assert.deepEqual(await evaluate('window.modelTestRequests'), [
      { path: '/api/model-configuration/bindings/embedding/test', method: 'POST', body: { revision: 1 } },
      { path: '/api/model-configuration/bindings/image-generation/test', method: 'POST', body: { revision: 2 } },
      { path: '/api/model-configuration/bindings/image-generation/test', method: 'POST', body: { revision: 3 } },
    ], 'Only the three explicit probe clicks may dispatch model requests');
    assert.deepEqual(errors, [], 'The real model settings page must not throw browser exceptions');
  } finally {
    if (cdp) { try { await cdp.send('Browser.close', {}, { timeoutMs: 2000 }); } catch {} cdp.close(); }
    profile.removeAfter(chrome);
    await server.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
