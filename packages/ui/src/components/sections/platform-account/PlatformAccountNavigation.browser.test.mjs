import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from '../../../../../../scripts/perf/cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../../../../../..');

test('user center navigation stays read-only and explicit key activation refreshes model settings', { timeout: 120_000 }, async () => {
  const { createServer } = await import('vite');
  mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repo, 'tmp/platform-account-navigation-'));
  writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import '@/index.css';
    const user = { id: 'fixture-user', name: 'Fixture reviewer', email: 'reviewer@example.test' };
    const scenario = new URLSearchParams(location.search).get('scenario');
    let keyState = { accountId: 'fixture-team', enterpriseMode: false, activation: null };
    let runNumber = 0;
    const modelRows = [
      ['agent', 'SuperWagie Chat'], ['auxiliary', 'SuperWagie Fast'],
      ['embedding', 'SuperWagie Embedding'], ['vision', 'SuperWagie Vision'],
      ['rerank', 'SuperWagie Rerank'], ['tts', 'SuperWagie Speech'],
      ['image-generation', 'SuperWagie Image'],
    ];
    const testRows = (verified) => modelRows.map(([purpose, modelId]) => ({
      id: purpose, purpose, modelId, applied: verified || purpose !== 'image-generation', status: verified || purpose !== 'image-generation' ? 'verified' : 'failed',
      testedAt: '2026-11-06T00:01:00Z', errorCode: verified || purpose !== 'image-generation' ? null : 'account_key_test_failed',
    }));
    const keyResult = (verified) => ({ accountId: 'fixture-team', enterpriseMode: false, activation: {
      operationId: 'fixture-key-operation', status: verified ? 'ready' : 'failed', stage: 'test',
      key: { id: 'fixture-key-record', last4: 'K7m2', createdAt: '2026-11-06T00:00:00Z', expiresAt: null },
      modelId: 'SuperWagie Chat', connectionId: 'fixture-connection', providerId: 'superwagie',
      test: { status: verified ? 'verified' : 'failed', testedAt: '2026-11-06T00:01:00Z', errorCode: verified ? null : 'model_configuration_provider_unreachable' },
      errorCode: verified ? null : 'model_configuration_provider_unreachable', actions: ['retest'],
      testRunId: 'fixture-test-run-' + runNumber, tests: testRows(verified),
    } });
    let finishKeyMutation;
    window.setKeyProgress = (stage) => {
      if (stage === 'test') runNumber += 1;
      const result = keyResult(false);
      keyState = { ...result, activation: { ...result.activation,
        status: stage === 'issue' ? 'issuing' : stage === 'configure' ? 'configuring' : 'testing',
        stage, key: stage === 'issue' ? null : result.activation.key, test: null, errorCode: null, actions: [],
        testRunId: stage === 'test' ? result.activation.testRunId : null,
        tests: stage === 'test' ? result.activation.tests.map((row, index) => ({ ...row, applied: false, status: index < 3 ? 'testing' : 'queued', testedAt: null, errorCode: null })) : [],
      } };
    };
    window.advanceModelTests = () => {
      keyState = { ...keyState, activation: { ...keyState.activation, tests: keyState.activation.tests.map((row, index) => ({
        ...row, applied: false, status: index < 4 ? 'verified' : 'testing', testedAt: index < 4 ? '2026-11-06T00:01:00Z' : null,
      })) } };
    };
    window.finishKeyMutation = (verified) => {
      if (!finishKeyMutation) throw new Error('No fixture key request is pending');
      keyState = keyResult(verified);
      const finish = finishKeyMutation; finishKeyMutation = null;
      finish(Response.json(keyState));
    };
    window.mutations = []; window.reads = [];
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method !== 'GET') {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        window.mutations.push({ path: url.pathname, method, body });
        if (url.pathname === '/api/model-configuration/bootstrap/account-key' && method === 'POST' && scenario === 'progress' && body?.accountId === 'fixture-team' && ['activate', 'retest'].includes(body.action)) {
          if (finishKeyMutation) throw new Error('Overlapping fixture key requests');
          // A retest can still read the previous receipt while the server
          // validates configuration. It must not appear as this test's result.
          if (keyState.activation) keyState = { ...keyState, activation: { ...keyState.activation, actions: [] } };
          return new Promise((resolve) => { finishKeyMutation = resolve; });
        }
        if (url.pathname === '/api/model-configuration/bootstrap/account-key' && method === 'POST' && ['activation', 'retry'].includes(scenario) && body?.accountId === 'fixture-team') {
          if (body.action === 'activate' && !keyState.activation) { runNumber += 1; keyState = keyResult(scenario !== 'retry'); return Response.json(keyState); }
          if (body.action === 'retest' && keyState.activation) { runNumber += 1; keyState = keyResult(true); return Response.json(keyState); }
        }
        return Response.json({ error: 'fixture_mutation_disabled' }, { status: 409 });
      }
      window.reads.push(url.pathname);
      if (url.pathname === '/api/model-configuration/bootstrap/account-key') return Response.json(keyState);
      if (url.pathname.endsWith('/api/platform-account/session')) return Response.json({ status: 'signed-in', user, expiresAt: '2027-01-01T12:00:00Z' });
      if (url.pathname.endsWith('/api/platform-account/profile')) return Response.json({ id: user.id, username: 'fixture-reviewer', displayName: user.name, email: user.email, avatarAvailable: false, version: '1' });
      if (url.pathname.endsWith('/api/platform-account')) return Response.json({ status: 'signed-in', user, accounts: [{ id: 'fixture-team', name: 'Fixture team', kind: 'team', role: 'owner' }], accountId: 'fixture-team', expiresAt: '2027-01-01T12:00:00Z', membership: [{ id: 'fixture-membership', product_id: 'superwagie', status: 'active', paid_through: '2027-01-01T00:00:00Z', offer: { name: 'Fixture membership' } }], credits: { available: '240000000', reserved: '8000000' }, consoleUrl: 'https://unihub.example.test/console', modelService: 'available' });
      if (url.pathname.endsWith('/api/platform-account/commerce')) return Response.json({ accountId: 'fixture-team', role: 'owner', financialAccess: true, missingScopes: [], payments: { mode: 'sandbox', canRecharge: true, canPurchase: true }, wallets: [{ productId: '', asset: 'CNY/6', amount: '120000000' }, { productId: 'superwagie', asset: 'CNY/6', amount: '30000000' }, { productId: 'llmrouter', asset: 'CNY/6', amount: '86400000' }], offers: [], orders: [], intents: [], rechargeHistoryScope: 'this-instance' });
      if (url.pathname.endsWith('/summary')) return Response.json({ visibility: 'account', calls_total: '47', settled_calls: '46', pending_calls: '1', unknown_calls: '0', missing_usage_calls: '0', unknown_time: '0', usage: {}, usage_complete: false, usage_coverage: { legacy_token_calls: '0', native_metered_calls: '0' }, charges_by_asset: { 'CREDIT/6': '32400000' }, refunds_by_asset: {} });
      if (url.pathname.endsWith('/calls')) return Response.json({ items: [], has_more: false });
      if (url.pathname.endsWith('/api/model-configuration')) return Response.json({ version: 1, revision: 1, enterpriseMode: false, credentialSources: { status: 'available', sources: [] }, purposes: [], presets: [], connections: [], bindings: [] });
      if (url.pathname.endsWith('/api/config/settings')) return Response.json({});
      if (url.pathname.endsWith('/fs/home')) return Response.json({ home: '/fixture' });
      if (url.pathname.endsWith('/location')) return Response.json({ directory: '/fixture', project: { directory: '/fixture' } });
      return Response.json([]);
    };
    const [{ I18nProvider, useI18nStore }, { RuntimeAPIContext }, { createWebAPIs }, { SidebarFooter }, { SettingsView }, { useUIStore }, { CSSVariableGenerator }, { getDefaultTheme }, { ModelConfigurationPage }] = await Promise.all([
      import('@/lib/i18n'), import('@/contexts/runtimeAPIContext'), import('@web/api/index'),
      import('@/components/session/sidebar/shell/SidebarFooter'), import('@/components/views/SettingsView'),
      import('@/stores/useUIStore'), import('@/lib/theme/cssGenerator'), import('@/lib/theme/themes'),
      import('@/components/sections/model-configuration/ModelConfigurationPage'),
    ]);
    useI18nStore.getState().setLocale('en');
    const fromSettings = new URLSearchParams(location.search).get('entry') === 'settings';
    useUIStore.setState({ isSettingsDialogOpen: fromSettings, settingsPage: 'platform-account', settingsJumpRequest: null });
    new CSSVariableGenerator().apply(getDefaultTheme(false));
    window.setAppearance = (dark, locale) => { new CSSVariableGenerator().apply(getDefaultTheme(dark)); document.documentElement.classList.toggle('dark', dark); useI18nStore.getState().setLocale(locale); };
    function EntryPoints() {
      const settingsOpen = useUIStore(state => state.isSettingsDialogOpen);
      return <><SidebarFooter onOpenSettings={() => useUIStore.getState().setSettingsDialogOpen(true)} onOpenShortcuts={() => {}} onOpenAbout={() => {}} onOpenUpdate={() => {}} showUpdateButton={false} />
        {settingsOpen ? <div data-fixture-settings-window style={{ height: '90vh' }}><SettingsView isWindowed forceMobile={false} /></div> : null}
        {scenario ? <div hidden data-fixture-mounted-model-settings><ModelConfigurationPage /></div> : null}</>;
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
    const browserErrors = [];
    cdp.on('Runtime.exceptionThrown', (event) => browserErrors.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text));
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
      const point = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({ block: 'center' }); const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    for (const entry of ['sidebar', 'settings']) {
      await cdp.send('Page.navigate', { url: server.resolvedUrls.local[0] + '?entry=' + entry });
      if (entry === 'sidebar') {
        await until(`!!document.querySelector('button[aria-label="User center"]')`, 'Sidebar account entry did not render');
        await click('button[aria-label="User center"]');
      }
      await until(`!!document.querySelector('[data-platform-account-tab="keys"]')`, 'API Key navigation did not render');
      await until(`document.body.innerText.includes('Fixture membership')`, 'Account overview did not show authoritative membership');
      assert.equal(await evaluate(`document.querySelector('[data-platform-account-tab="billing"]').getAttribute('aria-current')`), 'page');
      assert.equal(await evaluate(`!!document.querySelector('#unihub-recharge-amount')`), false, 'Opening account overview must not open a payment form');
      await click('[data-platform-account-tab="orders"]');
      await until(`document.querySelector('[data-platform-account-tab="orders"]').getAttribute('aria-current') === 'page'`, 'Orders navigation failed');
      assert.equal(await evaluate(`document.body.innerText.includes('Fixture membership')`), false, 'Orders should have their own content');
      await click('[data-platform-account-tab="billing"]');
      if (entry === 'sidebar') {
        for (const appearance of [{ width: 1280, dark: false, locale: 'zh-CN' }, { width: 1280, dark: true, locale: 'en' }, { width: 390, dark: false, locale: 'zh-CN' }]) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: appearance.width, height: 1000, deviceScaleFactor: 1, mobile: false });
          await evaluate(`window.setAppearance(${appearance.dark}, ${JSON.stringify(appearance.locale)})`);
          await wait(150);
          assert.equal(await evaluate(`/UniHub|LLMRouter/i.test(document.body.innerText)`), false, 'Overview must hide backend services');
          assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'Account layout overflows the viewport');
          assert.equal(await evaluate(`(() => { const wallet = [...document.querySelectorAll('h2')].find(heading => /^(My wallet|我的钱包)$/.test(heading.textContent))?.closest('section'); if (!wallet) return false; const bounds = wallet.getBoundingClientRect(); return wallet.scrollWidth <= wallet.clientWidth && [...wallet.querySelectorAll('button')].every(button => { const rect = button.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right; }); })()`), true, 'Wallet amounts and actions must fit inside the card');
          assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-platform-account-tab="profile"]')).display !== 'none'`), true);
          if (process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR) {
            mkdirSync(process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR, { recursive: true });
            const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
            writeFileSync(path.join(process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR, `account-${appearance.width}-${appearance.dark ? 'dark' : 'light'}-${appearance.locale}.png`), Buffer.from(screenshot.data, 'base64'));
          }
        }
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
        await evaluate(`window.setAppearance(false, 'en')`);
      }
      await click('[data-platform-account-tab="keys"]');
      await until(`document.body.innerText.includes('Activate and configure')`, 'Key activation entry did not render');
      assert.equal(await evaluate(`document.body.innerText.includes('Connection test passed')`), false);
      assert.equal(await evaluate(`document.body.innerText.includes('••••')`), false, 'An unopened key must not show a fabricated mask');
      if (entry === 'sidebar' && process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR) {
        await evaluate(`window.setAppearance(false, 'zh-CN')`);
        await wait(100);
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        writeFileSync(path.join(process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR, 'account-key-empty-zh-CN.png'), Buffer.from(screenshot.data, 'base64'));
      }
      await click('[data-platform-account-tab="usage"]');
      await until(`document.body.innerText.includes('47')`, 'SuperWagie usage did not render');
      assert.equal(await evaluate(`/UniHub|LLMRouter/i.test(document.body.innerText)`), false, 'Backend services must not appear in the account UI');
      assert.equal(await evaluate(`window.reads.some(path => /llmrouter|model-pool/.test(path) || (path.includes('model-configuration') && path !== '/api/model-configuration/bootstrap/account-key'))`), false, 'Navigation may read account-key state but must not query other service reports or global model configuration');
      assert.equal(await evaluate(`!![...document.querySelectorAll('button')].find(button => /Set up models|配置模型|Open account console|打开账户控制台/.test(button.textContent))`), false);
      assert.deepEqual(await evaluate('window.mutations'), [], 'Navigation must not issue keys or request model/payment mutations');
    }
    for (const scenario of ['activation', 'retry']) {
      await cdp.send('Page.navigate', { url: server.resolvedUrls.local[0] + '?entry=sidebar&scenario=' + scenario });
      await until(`!!document.querySelector('button[aria-label="User center"]')`, 'Sidebar account entry did not render');
      await click('button[aria-label="User center"]');
      await until(`!!document.querySelector('[data-platform-account-tab="keys"]')`, 'Key navigation did not render');
      await click('[data-platform-account-tab="keys"]');
      await until(`!![...document.querySelectorAll('button')].find(button => button.textContent === 'Activate and configure' && !button.disabled)`, 'Activation button did not become ready');
      assert.deepEqual(await evaluate('window.mutations'), [], 'Opening an activation scenario must still be read-only');
      const priorConfigurationReads = await evaluate(`window.reads.filter(path => path === '/api/model-configuration').length`);
      assert.ok(priorConfigurationReads > 0, 'Model settings consumer must be mounted before activation');
      await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Activate and configure'); button.dataset.fixtureActivate = ''; })()`);
      await click('[data-fixture-activate]');
      await until(`document.body.innerText.includes('•••• K7m2')`, 'Issued key suffix did not render');
      await until(`window.reads.filter(path => path === '/api/model-configuration').length > ${priorConfigurationReads}`, 'Saved configuration did not refresh the mounted model settings consumer');
      assert.equal(await evaluate(`/fixture-key-record|fixture-key-operation|UniHub|LLMRouter/.test(document.body.innerText)`), false, 'Internal key identifiers and backend services must stay hidden');
      assert.deepEqual(await evaluate('window.mutations'), [{ path: '/api/model-configuration/bootstrap/account-key', method: 'POST', body: { accountId: 'fixture-team', action: 'activate' } }]);
      if (scenario === 'retry') {
        await until(`document.body.innerText.includes('A connection test failed or a feature could not be applied')`, 'Failed probe did not remain visible');
        assert.equal(await evaluate(`document.body.innerText.includes('Connection test passed')`), false);
        await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Test and apply to features'); button.dataset.fixtureRetest = ''; })()`);
        if (process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR) {
          const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
          writeFileSync(path.join(process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR, 'account-key-test-failed-en.png'), Buffer.from(screenshot.data, 'base64'));
        }
        await click('[data-fixture-retest]');
        assert.deepEqual(await evaluate('window.mutations'), [
          { path: '/api/model-configuration/bootstrap/account-key', method: 'POST', body: { accountId: 'fixture-team', action: 'activate' } },
          { path: '/api/model-configuration/bootstrap/account-key', method: 'POST', body: { accountId: 'fixture-team', action: 'retest' } },
        ]);
      }
      await until(`document.body.innerText.includes('Connection test passed')`, 'Verified probe did not report success');
      assert.equal(await evaluate(`document.body.innerText.includes('SuperWagie Chat')`), true);
      if (scenario === 'activation') {
        for (const appearance of [{ width: 1280, dark: false, locale: 'zh-CN' }, { width: 1280, dark: true, locale: 'en' }, { width: 390, dark: false, locale: 'zh-CN' }]) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: appearance.width, height: 1000, deviceScaleFactor: 1, mobile: false });
          await evaluate(`window.setAppearance(${appearance.dark}, ${JSON.stringify(appearance.locale)})`);
          await wait(100);
          assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'Key activation result overflows the viewport');
          if (process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR) {
            const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
            writeFileSync(path.join(process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR, `account-key-ready-${appearance.width}-${appearance.dark ? 'dark' : 'light'}-${appearance.locale}.png`), Buffer.from(screenshot.data, 'base64'));
          }
        }
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      }
    }
    await cdp.send('Page.navigate', { url: server.resolvedUrls.local[0] + '?entry=sidebar&scenario=progress' });
    await until(`!!document.querySelector('button[aria-label="User center"]')`, 'Progress scenario entry did not render');
    await click('button[aria-label="User center"]');
    await until(`!!document.querySelector('[data-platform-account-tab="keys"]')`, 'Progress scenario navigation did not render');
    await click('[data-platform-account-tab="keys"]');
    const progressPanel = '[role="region"][aria-label="Setup and connection test"]';
    const panelText = `document.querySelector(${JSON.stringify(progressPanel)})?.innerText ?? ''`;
    const stepTexts = `[...document.querySelectorAll(${JSON.stringify(progressPanel + ' ol li')})].map(item => item.innerText)`;
    const assertSteps = async (statuses) => {
      await until(`(() => { const steps = ${stepTexts}; return steps.length === 3 && ${JSON.stringify(statuses)}.every((status, index) => steps[index].includes(status)); })()`, 'Setup step statuses did not update to ' + statuses.join(', '));
      assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(progressPanel)}).length`), 1, 'Setup must keep one visible progress and result panel');
    };
    const clickPanelButton = async (label) => {
      await until(`!![...document.querySelectorAll(${JSON.stringify(progressPanel + ' button')})].find(button => button.textContent === ${JSON.stringify(label)} && !button.disabled)`, label + ' did not become available');
      await evaluate(`(() => { const button = [...document.querySelectorAll(${JSON.stringify(progressPanel + ' button')})].find(button => button.textContent === ${JSON.stringify(label)}); button.dataset.fixtureProgressAction = ''; button.scrollIntoView({ block: 'center' }); })()`);
      await click('[data-fixture-progress-action]');
      await evaluate(`document.querySelector('[data-fixture-progress-action]')?.removeAttribute('data-fixture-progress-action')`);
    };
    const captureProgress = async (name, width = 1440, locale = 'en') => {
      await evaluate(`document.querySelector(${JSON.stringify(progressPanel)}).dataset.fixtureProgressPanel = ''`);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await evaluate(`window.setAppearance(false, ${JSON.stringify(locale)}); document.querySelector('[data-fixture-progress-panel]').scrollIntoView({ block: 'start' })`);
      if (width >= 1024) await evaluate(`(() => { let element = document.querySelector('[data-fixture-progress-panel]').parentElement; while (element) { if (/(auto|scroll)/.test(getComputedStyle(element).overflowY)) element.scrollTop = 0; element = element.parentElement; } })()`);
      await wait(100);
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'Setup progress overflows the viewport');
      assert.equal(await evaluate(`(() => { const panel = document.querySelector('[data-fixture-progress-panel]'); return panel.scrollWidth <= panel.clientWidth; })()`), true, 'Setup progress overflows its panel');
      if (process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR) {
        mkdirSync(process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR, { recursive: true });
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        writeFileSync(path.join(process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR, `key-progress-${name}-${width}-${locale}.png`), Buffer.from(screenshot.data, 'base64'));
      }
      if (locale !== 'en') { await evaluate(`window.setAppearance(false, 'en')`); await wait(50); }
    };
    await assertSteps(['Pending', 'Pending', 'Pending']);
    assert.deepEqual(await evaluate('window.mutations'), [], 'Opening the process panel must remain read-only');
    await clickPanelButton('Activate and configure');
    await until(`(${panelText}).includes('Submitting setup request…')`, 'Initial POST must show submission progress before its first receipt');
    assert.equal(await evaluate(`(${panelText}).includes('Connection test passed')`), false);
    await evaluate(`window.setKeyProgress('issue')`);
    await assertSteps(['In progress', 'Pending', 'Pending']);
    await captureProgress('issuing');
    await evaluate(`window.setKeyProgress('configure')`);
    await assertSteps(['Completed', 'In progress', 'Pending']);
    await captureProgress('configuring');
    await evaluate(`window.setKeyProgress('test')`);
    await assertSteps(['Completed', 'Completed', 'In progress']);
    const rowSelector = '[data-account-model-test]';
    const rows = `document.querySelectorAll(${JSON.stringify(rowSelector)})`;
    const assertModelRows = async (count, running, verified) => {
      await until(`(() => { const rows = [...${rows}]; return rows.length === ${count} && rows.filter(row => row.dataset.testStatus === 'testing').length === ${running} && rows.filter(row => row.dataset.testStatus === 'verified').length === ${verified}; })()`, 'Model rows did not follow the real test progress');
      assert.equal(await evaluate(`document.querySelectorAll('[data-account-model-test][data-test-status="queued"]').length`), 0, 'Undispatched tests should not reveal the full list');
      assert.equal(await evaluate(`document.querySelectorAll('[data-account-model-test][data-test-status="testing"] [data-spinner]').length`), running, 'Every running model needs its own animation');
      assert.equal(await evaluate(`document.querySelectorAll('[data-account-model-test][data-test-status="verified"] [data-spinner]').length`), 0, 'Completed rows must stop animating');
    };
    const rowMotion = async () => evaluate(`(() => { const row = document.querySelector('[data-account-model-test][data-test-status="testing"]'); return row ? [...row.querySelectorAll('[data-spinner] path')].map(item => item.getAttribute('opacity')).join(',') : ''; })()`);
    await assertModelRows(3, 3, 0);
    const frame = await rowMotion();
    assert.notEqual(frame, '', 'Spinner measurement must observe a real running model');
    await wait(350);
    assert.notEqual(await rowMotion(), frame, 'The running row indicator must visibly advance');
    await captureProgress('models-started', 1280, 'zh-CN');
    await captureProgress('models-started', 390, 'zh-CN');
    await evaluate(`window.advanceModelTests()`);
    await assertModelRows(7, 3, 4);
    await captureProgress('models-progress', 1280, 'zh-CN');
    await captureProgress('models-progress', 390, 'zh-CN');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await wait(100);
    const reducedFrame = await rowMotion();
    await wait(350);
    assert.equal(await rowMotion(), reducedFrame, 'Reduced motion should keep model indicators still');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await evaluate(`window.finishKeyMutation(true)`);
    await assertModelRows(7, 0, 7);
    await assertSteps(['Completed', 'Completed', 'Completed']);
    await until(`(${panelText}).includes('Connection test passed')`, 'Completed process did not retain its result');
    await captureProgress('ready', 390);
    await captureProgress('ready');
    await captureProgress('ready', 1280, 'zh-CN');
    await captureProgress('ready', 390, 'zh-CN');
    const readsBeforeRetest = await evaluate(`window.reads.filter(path => path === '/api/model-configuration/bootstrap/account-key').length`);
    await clickPanelButton('Test and apply to features');
    await until(`(${panelText}).includes('Submitting test request…')`, 'Retest must immediately show submission progress');
    assert.equal(await evaluate(`(${panelText}).includes('Connection test passed')`), false, 'A new pending test must hide the previous successful result');
    await until(`window.reads.filter(path => path === '/api/model-configuration/bootstrap/account-key').length > ${readsBeforeRetest}`, 'Pending retest did not poll its existing receipt');
    assert.equal(await evaluate(`(${panelText}).includes('Connection test passed')`), false, 'A polled old ready receipt must not claim the new test passed');
    assert.equal(await evaluate(`${rows}.length`), 0, 'Retest must not reveal rows from the previous run before dispatch');
    await captureProgress('retest-submitting');
    await evaluate(`window.setKeyProgress('test')`);
    await assertSteps(['Completed', 'Completed', 'In progress']);
    await assertModelRows(3, 3, 0);
    await evaluate(`window.finishKeyMutation(false)`);
    await assertModelRows(7, 0, 6);
    assert.equal(await evaluate(`document.querySelector('[data-account-model-test="image-generation"]').dataset.testStatus`), 'failed', 'Image failure must not erase six other completed results');
    await until(`(${panelText}).includes('A connection test failed or a feature could not be applied')`, 'A failed result must remain in the same process panel');
    assert.equal(await evaluate(`document.querySelectorAll('[data-account-model-test][data-test-status="failed"]').length`), 1);
    assert.equal(await evaluate(`!![...document.querySelectorAll(${JSON.stringify(progressPanel + ' button')})].find(button => button.textContent === 'Test and apply to features' && !button.disabled)`), true, 'The failed test must retain an explicit retry');
    await captureProgress('failed');
    await captureProgress('failed', 390);
    await captureProgress('failed', 1280, 'zh-CN');
    await captureProgress('failed', 390, 'zh-CN');
    await clickPanelButton('Test and apply to features');
    await until(`(${panelText}).includes('Submitting test request…')`, 'Retrying a failure did not show submission progress');
    await evaluate(`window.setKeyProgress('test')`);
    await assertSteps(['Completed', 'Completed', 'In progress']);
    await evaluate(`window.finishKeyMutation(true)`);
    await assertSteps(['Completed', 'Completed', 'Completed']);
    await until(`(${panelText}).includes('Connection test passed')`, 'An explicitly retried test did not replace the failed result');
    assert.deepEqual(await evaluate('window.mutations'), [
      { path: '/api/model-configuration/bootstrap/account-key', method: 'POST', body: { accountId: 'fixture-team', action: 'activate' } },
      { path: '/api/model-configuration/bootstrap/account-key', method: 'POST', body: { accountId: 'fixture-team', action: 'retest' } },
      { path: '/api/model-configuration/bootstrap/account-key', method: 'POST', body: { accountId: 'fixture-team', action: 'retest' } },
    ], 'Polling and process transitions must not issue another key or automatically retry a test');
    assert.deepEqual(browserErrors, [], 'Account navigation and key activation must not throw browser exceptions');
  } finally {
    if (cdp) { try { await cdp.send('Browser.close', {}, { timeoutMs: 2000 }); } catch {} cdp.close(); }
    profile.removeAfter(chrome);
    await server.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
