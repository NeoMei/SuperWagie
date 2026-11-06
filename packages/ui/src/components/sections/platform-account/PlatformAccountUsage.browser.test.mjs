import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from '../../../../../../scripts/perf/cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../../../../../..');

test('SuperWagie usage preserves exact measurements, independent reads and account/runtime isolation', { timeout: 180_000 }, async () => {
  const { createServer } = await import('vite');
  mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repo, 'tmp/platform-account-usage-'));
  writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import '@/index.css';
    import { I18nProvider, useI18nStore } from '@/lib/i18n';
    import { PlatformAccountUsage, PlatformAccountUsageSummary } from '@/components/sections/platform-account/PlatformAccountUsage';
    import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
    import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
    import { getDefaultTheme } from '@/lib/theme/themes';
    const params = new URLSearchParams(location.search);
    const scenario = params.get('scenario');
    const summary = {
  "native_usage": [
    {
      "operation": "chat",
      "measurements": [
        {
          "key": "requests",
          "unit": "request",
          "quantity": {
            "value": "1",
            "scale": 0
          }
        }
      ]
    }
  ],
  "charges_by_asset": {
    "CNY/6": "73"
  },
  "refunds_by_asset": {
    "CNY/6": "0"
  },
  "refunded": "0",
  "scope": {
    "instance_id": "fixture-instance",
    "account_id": "personal-a",
    "origin_product_id": "superwagie",
    "visibility": "account"
  },
  "filter": {
    "instance_id": "default",
    "from": "2026-10-06T19:18:54.437742575Z",
    "to": "2026-11-05T19:18:54.437742575Z",
    "origin_product_id": "superwagie"
  },
  "financial_details": true,
  "calls_total": "1",
  "settled_calls": "1",
  "pending_calls": "0",
  "missing_usage_calls": "0",
  "unknown_calls": "0",
  "rejected_calls": "0",
  "released_calls": "0",
  "by_status": {
    "SETTLED": "1"
  },
  "charged": "73",
  "asset": "CNY/6",
  "usage": {
    "input": "0",
    "output": "0",
    "cache_read": "0",
    "cache_write": "0",
    "reasoning": "0"
  },
  "usage_complete": true,
  "unknown_time": "0",
  "as_of": "2026-11-05T19:18:54.455382201Z",
  "accuracy": "exact_for_query_snapshot",
  "consistency": "live",
  "usage_coverage": {
    "legacy_token_calls": "0",
    "native_metered_calls": "1"
  }
};
    if (scenario === 'unknown') delete summary.usage_coverage;
    if (scenario === 'literal') {
      summary.native_usage = [
        { operation: 'image_generation', measurements: ['input', 'requests', '输入', ' small ', 'small', 'x'.repeat(128)].map(key => ({ key, unit: 'image', quantity: { value: '1', scale: 0 } })) },
        { operation: 'video', measurements: [' provider.units ', 'provider.units'].map(provider_unit => ({ key: 'provider', unit: 'provider_unit', provider_unit, quantity: { value: '1', scale: 0 } })) }
      ];
    }
    if (scenario === 'mixed') {
      summary.usage_coverage = { legacy_token_calls: '1', native_metered_calls: '3' };
      summary.native_usage = [{ operation: 'chat', measurements: [
        { key: 'requests', unit: 'request', quantity: { value: '9007199254740993', scale: 0 } },
        { key: 'input', unit: 'token', quantity: { value: '17', scale: 0 } }
      ] }, { operation: 'transcription', measurements: [{ key: 'audio', unit: 'audio_second', quantity: { value: '1001', scale: 3 } }] }];
    }
    window.mutations = [];
    window.reads = [];
    window.authRequests = 0;
    window.allowSummary = false;
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method === 'POST' && url.pathname === '/auth/url-token') {
        window.authRequests++;
        return Response.json({ token: '', expiresAt: 0 });
      }
      if (method !== 'GET') { window.mutations.push({ path: url.pathname, method }); return Response.json({ error: 'fixture_mutation_disabled' }, { status: 409 }); }
      window.reads.push(url.pathname);
      if (url.pathname.includes('/llmrouter/') || url.pathname.includes('/model-pool/')) return Response.json({ error: 'fixture_other_product_forbidden' }, { status: 403 });
      const oldAccount = scenario === 'switch' && url.pathname.includes('/fixture-account/');
      const oldRuntime = scenario === 'runtime' && getRuntimeKey() !== 'fixture-next-runtime';
      const oldOwner = oldAccount || oldRuntime;
      if (url.pathname.endsWith('/summary')) {
        if (oldOwner) {
          await new Promise(resolve => { window.releaseOldSummary = resolve; });
          return Response.json({ ...summary, visibility: 'account', charges_by_asset: { 'CNY/6': '91000000' } });
        }
        if (scenario === 'denied' && !window.allowSummary) return Response.json({ error: 'forbidden' }, { status: 403 });
        if (scenario === 'summary-failed') return Response.json({ error: 'service_unavailable' }, { status: 503 });
        if (scenario === 'switch' || scenario === 'runtime') return Response.json({ ...summary, visibility: 'account', charges_by_asset: { 'CNY/6': '12000000' } });
        if (scenario === 'empty') return Response.json({ ...summary, visibility: 'account', calls_total: '0', settled_calls: '0', native_usage: [], charges_by_asset: {}, refunds_by_asset: {} });
        return Response.json({ ...summary, visibility: 'account' });
      }
      if (url.pathname.endsWith('/calls')) {
        if (oldOwner) await new Promise(resolve => { window.releaseOldCalls = resolve; });
        if (scenario === 'calls-failed') return Response.json({ error: 'service_unavailable' }, { status: 503 });
        return Response.json({ has_more: false, items: scenario === 'empty' ? [] : [{ call_id: oldOwner ? 'old' : 'current', model: oldOwner ? 'Previous account model' : 'Current account model', status: 'SETTLED', asset: 'CNY/6', charged: '600000', created_at: '2026-11-06T10:20:00Z' }] });
      }
      return Response.json([]);
    };
    useI18nStore.getState().setLocale(params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en');
    new CSSVariableGenerator().apply(getDefaultTheme(params.get('theme') === 'dark'));
    function UsageFixture() {
      const [accountId, setAccountId] = React.useState('fixture-account');
      const [, setRuntimeRevision] = React.useState(0);
      const changeOwner = () => {
        if (scenario === 'runtime') {
          switchRuntimeEndpoint({ apiBaseUrl: location.origin, runtimeKey: 'fixture-next-runtime' });
          setRuntimeRevision(value => value + 1);
        } else setAccountId('next-account');
      };
      return <>{(scenario === 'switch' || scenario === 'runtime') && <button id="change-owner" onClick={changeOwner}>Fixture change owner</button>}{scenario === 'summary' ? <PlatformAccountUsageSummary accountId={accountId} /> : <PlatformAccountUsage accountId={accountId} />}</>;
    }
    createRoot(document.getElementById('root')).render(<I18nProvider><main className="@container mx-auto max-w-3xl p-6"><UsageFixture /></main></I18nProvider>);
`);
  const server = await createServer({
    configFile: false, root: fixture, cacheDir: path.join(fixture, '.vite'), logLevel: 'error',
    css: { postcss: repo },
    define: { 'process.env': {}, global: 'globalThis', __APP_VERSION__: '"fixture"' },
    resolve: { alias: { '@': path.join(repo, 'packages/ui/src'), '@web': path.join(repo, 'packages/web/src'), '@openchamber/ui': path.join(repo, 'packages/ui/src'), '@openchamber/sdk/schemas': path.join(repo, 'packages/sdk/src/schemas.ts'), '@openchamber/sdk': path.join(repo, 'packages/sdk/src/index.ts') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo, fixture] } },
  });
  const profile = resolveProfileDir(undefined, 'account-usage');
  let chrome;
  let cdp;
  try {
    await server.listen();
    const port = await reservePort();
    chrome = launchChrome({ chrome: resolveChrome(), profileDir: profile.dir, port, headless: true });
    const target = await createPageTarget(port);
    cdp = new CdpClient(target.webSocketDebuggerUrl); await cdp.connect();
    const browserErrors = [];
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => browserErrors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
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
      assert.fail(description + ': ' + (await evaluate('document.body.innerText')).slice(0, 2000) + '\n' + browserErrors.join('\n'));
    };
    const click = async (selector) => {
      const point = await evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    const assertProductBoundary = async () => {
      assert.equal(await evaluate(`/unihub|llmrouter|model[ _-]*pool/i.test(document.body.innerText)`), false, 'User-visible usage must not expose backend brands');
      assert.equal(await evaluate(`window.reads.some(path => /llmrouter|model[ _-]*pool/i.test(path))`), false, 'User usage must not request another product or model pool');
      assert.deepEqual(await evaluate('window.mutations'), []);
    };
    for (const scenario of ['request', 'mixed', 'unknown', 'literal']) {
      for (const appearance of [{ theme: 'light', locale: 'en', width: 1440 }, { theme: 'dark', locale: 'zh-CN', width: 1440 }, ...(['request', 'literal'].includes(scenario) ? [{ theme: 'light', locale: 'en', width: 390 }] : [])]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: appearance.width, height: 1000, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Page.navigate', { url: server.resolvedUrls.local[0] + '?scenario=' + scenario + '&theme=' + appearance.theme + '&locale=' + appearance.locale });
        await until(`document.body.innerText.includes(${JSON.stringify(appearance.locale === 'en' ? 'Settled calls' : '已结算调用')})`, 'Actual component did not finish loading');
        await click('button[aria-expanded="false"]');
        await until(`document.body.innerText.includes(${JSON.stringify(appearance.locale === 'en' ? 'Billing completeness describes settlement.' : '计费完整性表示结算状态。')})`, 'Measurement details did not expand');
        const text = await evaluate('document.body.innerText');
        if (scenario === 'request') {
          assert.ok(text.includes(appearance.locale === 'en' ? 'CNY 0.000073' : '人民币 0.000073 元'), text);
          assert.ok(text.includes(appearance.locale === 'en' ? '1 requests' : '1 次请求'), text);
          assert.ok(text.includes(appearance.locale === 'en' ? 'The Token breakdown has no records' : 'Token 分类统计暂无记录'), text);
          assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(button => button.textContent === 'Token details' || button.textContent === 'Token 明细')`), false);
        }
        if (scenario === 'mixed') {
          assert.ok(text.includes('9007199254740993'), text); assert.ok(text.includes('1.001'), text);
          assert.ok(text.includes('17'), text);
        }
        if (scenario === 'literal') {
          const labels = await evaluate(`[...document.querySelectorAll('span')].map(span => span.textContent)`);
          const operation = appearance.locale === 'en' ? 'Image generation' : '图像生成';
          for (const key of ['input', 'requests', '输入', ' small ', 'small']) assert.ok(labels.includes(operation + ' · ' + key), labels.join('\n'));
          for (const literal of [' small ', 'small', ' provider.units ', 'provider.units']) {
            const style = await evaluate(`(() => { const span = [...document.querySelectorAll('span')].find(span => span.textContent === ${JSON.stringify(literal)}); return span ? { whitespace: getComputedStyle(span).whiteSpace, break: getComputedStyle(span).wordBreak } : null; })()`);
            assert.deepEqual(style, { whitespace: 'pre-wrap', break: 'break-all' });
          }
          assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Literal keys must wrap inside the viewport');
        }
        if (scenario === 'unknown') assert.ok(text.includes(appearance.locale === 'en' ? 'does not report usage recording coverage' : '未提供用量记录覆盖情况'), text);
        await assertProductBoundary();
        if (process.env.PLATFORM_USAGE_EVIDENCE_DIR) {
          await until(`(() => { const id = document.querySelector('button[aria-expanded="true"]')?.getAttribute('aria-controls'); const panel = id && document.getElementById(id); return !panel || getComputedStyle(panel).opacity === '1'; })()`, 'Measurement details did not finish opening');
          mkdirSync(process.env.PLATFORM_USAGE_EVIDENCE_DIR, { recursive: true });
          const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
          writeFileSync(path.join(process.env.PLATFORM_USAGE_EVIDENCE_DIR, scenario + '-' + appearance.width + '-' + appearance.theme + '-' + appearance.locale + '.png'), Buffer.from(screenshot.data, 'base64'));
          writeFileSync(path.join(process.env.PLATFORM_USAGE_EVIDENCE_DIR, scenario + '-' + appearance.width + '-' + appearance.locale + '.txt'), await evaluate('document.body.innerText'));
        }
      }
    }
    await cdp.send('Page.navigate', { url: server.resolvedUrls.local[0] + '?scenario=summary' });
    await until(`document.body.innerText.includes('Settled calls')`, 'Overview summary did not load');
    assert.deepEqual(await evaluate('window.reads'), ['/api/platform-account/usage/fixture-account/summary'], 'The overview must not fetch call lists or the native report');
    assert.equal(await evaluate(`document.querySelector('table') === null`), true);
    assert.equal(await evaluate(`document.body.innerText.includes('Measurement details')`), false);
    await assertProductBoundary();

    for (const scenario of ['switch', 'runtime']) {
      await cdp.send('Page.navigate', { url: server.resolvedUrls.local[0] + '?scenario=' + scenario });
      await until(`typeof window.releaseOldSummary === 'function' && typeof window.releaseOldCalls === 'function'`, 'Old owner requests were not in flight');
      await click('#change-owner');
      await until(`document.body.innerText.includes('Current account model') && document.body.innerText.includes('12.00')`, 'Current owner report did not render');
      await evaluate(`window.releaseOldSummary(); window.releaseOldCalls()`);
      await wait(100);
      assert.equal(await evaluate(`document.body.innerText.includes('91.00')`), false, 'An old owner summary must not replace the current report');
      assert.equal(await evaluate(`document.body.innerText.includes('Previous account model')`), false, 'An old owner call list must not replace the current report');
      assert.equal(await evaluate(`document.body.innerText.includes('12.00')`), true);
      assert.equal(await evaluate('window.authRequests'), scenario === 'runtime' ? 1 : 0, 'Runtime switching refreshes URL authentication once');
      await assertProductBoundary();
    }

    await cdp.send('Page.navigate', { url: server.resolvedUrls.local[0] + '?scenario=denied' });
    await until(`document.body.innerText.includes('You do not have permission') && document.body.innerText.includes('Current account model')`, 'Denied summary blocked the independent call list');
    assert.equal(await evaluate(`document.body.innerText.includes('No calls are recorded')`), false);
    await evaluate(`window.allowSummary = true; [...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh usage').click()`);
    await until(`document.body.innerText.includes('Settled calls')`, 'Explicit refresh did not restore the authorized summary');
    assert.equal(await evaluate(`document.body.innerText.includes('You do not have permission')`), false);
    await assertProductBoundary();

    for (const scenario of ['summary-failed', 'calls-failed']) {
      await cdp.send('Page.navigate', { url: server.resolvedUrls.local[0] + '?scenario=' + scenario });
      await until(`document.body.innerText.includes('Could not read this consumption report')`, 'Read failure was not visible');
      assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(scenario === 'summary-failed' ? 'Current account model' : 'Settled calls')})`), true, 'One failed read must not erase the independent report');
      assert.equal(await evaluate(`document.body.innerText.includes('No calls are recorded')`), false, 'Failure must not appear as an empty report');
      await assertProductBoundary();
    }
    await cdp.send('Page.navigate', { url: server.resolvedUrls.local[0] + '?scenario=empty' });
    await until(`document.body.innerText.includes('No calls are recorded')`, 'Authoritative empty result did not render');
    assert.equal(await evaluate(`document.body.innerText.includes('Could not read')`), false);
    await assertProductBoundary();
    assert.deepEqual(browserErrors, []);
  } finally {
    if (cdp) { try { await cdp.send('Browser.close', {}, { timeoutMs: 2000 }); } catch {} cdp.close(); }
    profile.removeAfter(chrome);
    await server.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
