import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createPlatformCommerceRuntime } from '../../../../../web/server/lib/platform-account/commerce.js';
import { registerPlatformCommerceRoutes } from '../../../../../web/server/lib/platform-account/commerce-routes.js';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from '../../../../../../scripts/perf/cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../../../../../..');

test('rejected manual refunds cross the journal, HTTP parser and rendered UI without replaying payment', { timeout: 90_000 }, async (t) => {
  const { createServer } = await import('vite');
  mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repo, 'tmp/platform-refund-rejected-'));
  let runtime;
  t.after(async () => { await runtime?.close(); rmSync(fixture, { recursive: true, force: true }); });
  const records = new Map();
  const providerIO = [];
  const refunds = [];
  const accountRuntime = { captureCommerceSession: () => ({ billingAccountId: 'account', actingUserId: 'actor', serviceId: 'fixture', request: async (route, init) => {
    if (route === '/v1/accounts') return [{ id: 'account', kind: 'personal', role: 'owner' }];
    if (route === '/v1/capabilities') return { product_id: 'superwagie', scopes: ['catalog:read', 'orders:read', 'orders:write'], sandbox: false, product_wallet_recharge: false, real_payments_configured: true, payment_providers: ['wechat'], native_credits: { ready: true } };
    if (route === '/v1/catalog') return [{ id: 'addon', product_id: 'superwagie', name: 'Fixture add-on', account_kind: 'both', kind: 'addon', period: 'once', price: '9800000', monthly_credit: '200000000', validity_months: 12, rank: 1, sandbox: false, status: 'published' }];
    if (route.endsWith('/orders')) return [];
    if (route.endsWith('/checkouts') && init?.method === 'POST') {
      const id = `checkout-${records.size + 1}`;
      const receipt = { id, account_id: 'account', product_id: 'superwagie', provider: 'wechat', offer_name: 'Fixture add-on', amount: '9800000', currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2027-01-01T00:00:00Z', created_at: '2026-11-09T00:00:00Z' };
      records.set(id, receipt); providerIO.push(`create:${id}`); return receipt;
    }
    if (route.endsWith('/checkouts')) return [...records.values()];
    const parts = route.split('/');
    const receipt = records.get(parts[5]);
    if (!receipt) throw new Error(`Unexpected fixture route: ${route}`);
    if (parts[6] === 'refund') {
      const original = { key: init.headers['Idempotency-Key'], reason: JSON.parse(init.body).reason };
      if (refunds.length) assert.deepEqual(original, refunds[0]);
      refunds.push(original);
      // The approved upstream contract returns a rejected original refund without provider IO.
      if (receipt.refund_status !== 'REJECTED') { providerIO.push('refund:original-refund-id'); receipt.refund_status = 'REVIEW'; }
    }
    return receipt;
  } }) };
  runtime = createPlatformCommerceRuntime({ dataDir: path.join(fixture, 'data'), accountRuntime });
  const purchaseKey = crypto.randomUUID();
  const purchase = { accountId: 'account', offerId: 'addon', provider: 'wechat', idempotencyKey: purchaseKey };
  const first = await runtime.createCheckout({}, purchase);
  const checkout = records.get(first.resourceId);
  checkout.payment_status = 'PAID'; checkout.fulfillment_status = 'FULFILLED';
  await runtime.checkoutAction({}, checkout.id, 'refund', { accountId: 'account', reason: 'Original reviewed refund' });
  const journalPath = path.join(fixture, 'data/unihub-commerce/state.json');
  const originalIntent = Object.values(JSON.parse(readFileSync(journalPath, 'utf8')).intents)[0];
  await runtime.close();
  runtime = createPlatformCommerceRuntime({ dataDir: path.join(fixture, 'data'), accountRuntime });
  const app = express();
  registerPlatformCommerceRoutes(app, { runtime, resolveIdentity: async () => ({}), isRequestOriginAllowed: async () => true });
  writeFileSync(path.join(fixture, 'index.html'), '<html><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.tsx'), `
    import React from 'react'; import { createRoot } from 'react-dom/client'; import '@/index.css';
    import { I18nProvider, useI18nStore } from '@/lib/i18n';
    import { readPlatformCommerce, updatePlatformCheckout, createPlatformCheckout } from '@/lib/platformCommerce';
    import { PlatformCheckoutCard } from '@/components/sections/platform-account/PlatformCheckoutCard';
    const root = createRoot(document.getElementById('root'));
    useI18nStore.getState().setLocale('en');
    window.locale = locale => useI18nStore.getState().setLocale(locale);
    window.load = async () => { window.snapshot = await readPlatformCommerce(); root.render(<I18nProvider><PlatformCheckoutCard checkout={window.snapshot.checkouts[0]} busy={false} onAction={async action => { await updatePlatformCheckout('account','checkout-1',action); await window.load(); }} /></I18nProvider>); };
    window.replay = () => updatePlatformCheckout('account', 'checkout-1', 'refund');
    window.purchase = idempotencyKey => createPlatformCheckout({ accountId:'account',offerId:'addon',provider:'wechat',idempotencyKey });
    window.load().catch(error => { window.loadError = error.message; });
  `);
  const server = await createServer({ configFile: false, root: fixture, cacheDir: path.join(fixture, '.vite'), logLevel: 'error', css: { postcss: repo }, define: { 'process.env': {}, global: 'globalThis', __APP_VERSION__: '"fixture"' }, resolve: { alias: { '@': path.join(repo, 'packages/ui/src'), '@openchamber/sdk/schemas': path.join(repo, 'packages/sdk/src/schemas.ts'), '@openchamber/sdk': path.join(repo, 'packages/sdk/src/index.ts') } }, plugins: [{ name: 'fixture-commerce-http', configureServer: server => { server.middlewares.use(app); } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo, fixture] } } });
  const profile = resolveProfileDir(undefined, 'platform-refund-rejected');
  let chrome; let cdp;
  try {
    await server.listen(); const port = await reservePort(); chrome = launchChrome({ chrome: resolveChrome(), profileDir: profile.dir, port, headless: true });
    const target = await createPageTarget(port); cdp = new CdpClient(target.webSocketDebuggerUrl); await cdp.connect(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    const errors = []; cdp.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.text));
    const evaluate = async expression => { const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description); return result.result.value; };
    const until = async expression => { const deadline = Date.now() + 25000; while (Date.now() < deadline) { if (await evaluate(expression)) return; await wait(50); } assert.fail(`Timed out: ${expression}; ${await evaluate('window.loadError || document.body.innerText')}`); };
    await cdp.send('Page.navigate', { url: server.resolvedUrls.local[0] });
    await until('document.body.innerText.includes("This payment needs review")');
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "Request original-channel refund").click()');
    await until('document.body.innerText.includes("Confirm refund")');
    checkout.refund_status = 'REJECTED';
    await evaluate('window.load()');
    await until('document.body.innerText.includes("Refund request declined") && document.body.innerText.includes("Your purchase is active")');
    assert.equal(await evaluate('window.snapshot.intents[0].status'), 'APPLIED');
    assert.equal(await evaluate('document.body.innerText.includes("Confirm refund") || document.body.innerText.includes("Request original-channel refund")'), false);
    assert.deepEqual(providerIO, ['create:checkout-1', 'refund:original-refund-id']);
    const read = await fetch(`${server.resolvedUrls.local[0]}api/platform-account/commerce/checkouts/checkout-1?accountId=account`);
    assert.equal(read.status, 200); assert.equal((await read.json()).refund_status, 'REJECTED');
    assert.equal((await evaluate('window.replay()')).refund_status, 'REJECTED');
    assert.deepEqual(refunds[1], refunds[0]);
    assert.deepEqual(providerIO, ['create:checkout-1', 'refund:original-refund-id']);
    await evaluate('window.locale("zh-CN")');
    await until('document.body.innerText.includes("退款申请未获批准") && document.body.innerText.includes("购买已生效")');
    const evidence = process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR;
    if (evidence) { mkdirSync(evidence, { recursive: true }); const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(evidence, 'checkout-refund-rejected-zh-CN.png'), Buffer.from(shot.data, 'base64')); }
    const next = await evaluate(`window.purchase(${JSON.stringify(crypto.randomUUID())})`);
    assert.equal(next.status, 'PENDING'); assert.equal(next.resourceId, 'checkout-2');
    const saved = Object.values(JSON.parse(readFileSync(journalPath, 'utf8')).intents).find(intent => intent.idempotencyKey === purchaseKey);
    assert.equal(saved.status, 'APPLIED'); assert.equal(saved.refundKey, originalIntent.refundKey); assert.equal(saved.refundReason, originalIntent.refundReason);
    assert.deepEqual(providerIO, ['create:checkout-1', 'refund:original-refund-id', 'create:checkout-2']);
    assert.deepEqual(errors, []);
  } finally {
    if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.close(); }
    if (chrome) { chrome.kill(); await wait(300); }
    await server.close();
    if (profile.temporary) rmSync(profile.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
