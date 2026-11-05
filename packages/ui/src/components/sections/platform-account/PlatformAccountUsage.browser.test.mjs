import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from '../../../../../../scripts/perf/cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../../../../../..');

test('native usage and unavailable CREDIT offers render accurately in the real browser', { timeout: 180_000 }, async () => {
  const { createServer } = await import('vite');
  mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repo, 'tmp/platform-account-usage-'));
  writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import '@/index.css';
    import { I18nProvider, useI18nStore } from '@/lib/i18n';
    import { PlatformAccountUsage } from '@/components/sections/platform-account/PlatformAccountUsage';
    import { PlatformAccountCommerce } from '@/components/sections/platform-account/PlatformAccountCommerce';
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
    if (scenario === 'mixed') {
      summary.usage_coverage = { legacy_token_calls: '1', native_metered_calls: '3' };
      summary.native_usage = [{ operation: 'chat', measurements: [
        { key: 'requests', unit: 'request', quantity: { value: '9007199254740993', scale: 0 } },
        { key: 'input', unit: 'token', quantity: { value: '17', scale: 0 } }
      ] }, { operation: 'transcription', measurements: [{ key: 'audio', unit: 'audio_second', quantity: { value: '1001', scale: 3 } }] }];
    }
    const offer = { id: 'fixture-addon', productId: 'llmrouter', name: 'Fixture CREDIT benefit', accountKind: 'both', kind: 'addon', period: 'once', price: '10000000', monthlyCredit: '20000000', validityMonths: 12, rank: 1, sandbox: true, salesReadiness: { ready: false, reason: 'credit_rates_unavailable' } };
    window.mutations = [];
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method !== 'GET') { window.mutations.push({ path: url.pathname, method }); return Response.json({ error: 'fixture_mutation_disabled' }, { status: 409 }); }
      if (url.pathname.endsWith('/summary')) return Response.json({ ...summary, visibility: 'account' });
      if (url.pathname.endsWith('/calls')) return Response.json({ has_more: false, items: [] });
      if (url.pathname.endsWith('/commerce')) return Response.json({ accountId: 'fixture-account', role: 'owner', financialAccess: true, missingScopes: [], payments: { mode: 'sandbox', canRecharge: true, canPurchase: true }, wallets: [{ productId: 'llmrouter', asset: 'CNY/6', amount: '10000000' }], offers: [offer], orders: [{ id: 'fixture-order', productId: 'llmrouter', offerName: 'Existing paid benefit', amount: '1000000', paymentStatus: 'PAID', fulfillmentStatus: 'FULFILLED', refundStatus: '' }], intents: [], rechargeHistoryScope: 'this-instance' });
      return Response.json([]);
    };
    useI18nStore.getState().setLocale(params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en');
    new CSSVariableGenerator().apply(getDefaultTheme(params.get('theme') === 'dark'));
    createRoot(document.getElementById('root')).render(<I18nProvider><main className="@container mx-auto max-w-3xl p-6">{scenario === 'commerce' ? <PlatformAccountCommerce accountId="fixture-account" payer="Fixture payer" hasActiveMembership={false} membershipSummary={<p>Existing membership and CREDIT balance</p>} onAccountRefresh={() => {}} /> : <PlatformAccountUsage accountId="fixture-account" />}</main></I18nProvider>);
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
    for (const scenario of ['request', 'mixed', 'unknown', 'commerce']) {
      for (const appearance of [{ theme: 'light', locale: 'en', width: 1440 }, { theme: 'dark', locale: 'zh-CN', width: 1440 }, ...(['request', 'commerce'].includes(scenario) ? [{ theme: 'light', locale: 'en', width: 390 }] : [])]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: appearance.width, height: 1000, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Page.navigate', { url: server.resolvedUrls.local[0] + '?scenario=' + scenario + '&theme=' + appearance.theme + '&locale=' + appearance.locale });
        await until(`document.body.innerText.includes(${JSON.stringify(appearance.locale === 'en' ? (scenario === 'commerce' ? 'Existing paid benefit' : 'Settled calls') : (scenario === 'commerce' ? 'Existing paid benefit' : '已结算调用'))})`, 'Actual component did not finish loading');
        let text = await evaluate('document.body.innerText');
        if (scenario === 'request') {
          assert.ok(text.includes(appearance.locale === 'en' ? '1 requests' : '1 次请求'), text);
          assert.ok(text.includes(appearance.locale === 'en' ? 'The Token breakdown has no records' : 'Token 分类统计暂无记录'), text);
          assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(button => button.textContent === 'Token details' || button.textContent === 'Token 明细')`), false);
        }
        if (scenario === 'mixed') {
          assert.ok(text.includes('9007199254740993'), text); assert.ok(text.includes('1.001'), text);
          assert.ok(text.includes('17'), text);
        }
        if (scenario === 'unknown') assert.ok(text.includes(appearance.locale === 'en' ? 'does not report usage recording coverage' : '未提供用量记录覆盖情况'), text);
        if (scenario === 'commerce') {
          const label = appearance.locale === 'en' ? 'Credit add-ons' : '权益加量包';
          // Find the translated task by its stable aria-pressed control, using its actual label.
          await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === ${JSON.stringify(label)})?.click()`);
          await until(`!!document.querySelector('[aria-label="Fixture CREDIT benefit"]')`, 'Add-on did not render');
          assert.equal(await evaluate(`document.querySelector('[aria-label="Fixture CREDIT benefit"]').disabled`), true);
          text = await evaluate('document.body.innerText');
          assert.ok(text.includes(appearance.locale === 'en' ? 'no usable model CREDIT rates' : '尚未配置可用的模型 CREDIT 费率'), text);
          assert.ok(text.includes('Existing paid benefit'), text);
        }
        assert.deepEqual(await evaluate('window.mutations'), []);
        if (process.env.PLATFORM_USAGE_EVIDENCE_DIR) {
          mkdirSync(process.env.PLATFORM_USAGE_EVIDENCE_DIR, { recursive: true });
          const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
          writeFileSync(path.join(process.env.PLATFORM_USAGE_EVIDENCE_DIR, scenario + '-' + appearance.width + '-' + appearance.theme + '-' + appearance.locale + '.png'), Buffer.from(screenshot.data, 'base64'));
          writeFileSync(path.join(process.env.PLATFORM_USAGE_EVIDENCE_DIR, scenario + '-' + appearance.width + '-' + appearance.locale + '.txt'), await evaluate('document.body.innerText'));
        }
      }
    }
  } finally {
    if (cdp) { try { await cdp.send('Browser.close', {}, { timeoutMs: 2000 }); } catch {} cdp.close(); }
    profile.removeAfter(chrome);
    await server.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
