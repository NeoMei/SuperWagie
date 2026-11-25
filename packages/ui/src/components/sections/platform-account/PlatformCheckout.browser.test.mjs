import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from '../../../../../../scripts/perf/cdp.mjs';
const repo = path.resolve(import.meta.dirname, '../../../../../..');
test('checkout stays alongside the catalog and switches offers after confirmed closure', { timeout: 90_000 }, async () => {
  const { createServer } = await import('vite');
  mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repo, 'tmp/platform-checkout-'));
  writeFileSync(path.join(fixture, 'index.html'), '<html><head><title>SuperWagie checkout</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.tsx'), `
    import React from 'react'; import { createRoot } from 'react-dom/client'; import '@/index.css';
    import { I18nProvider, useI18nStore } from '@/lib/i18n';
    import { PlatformAccountCommerce } from '@/components/sections/platform-account/PlatformAccountCommerce';
    import { CSSVariableGenerator } from '@/lib/theme/cssGenerator'; import { getDefaultTheme } from '@/lib/theme/themes';
    const original = { id:'original-checkout', account_id:'account', product_id:'superwagie', provider:'wechat', offer_name:'Confirmed plan', amount:'99000000', currency:'CNY', payment_status:'PENDING', fulfillment_status:'NOT_STARTED', refund_status:'', expires_at:new Date(Date.now()+900000).toISOString(), created_at:new Date().toISOString(), session:{ kind:'qr', url:'weixin://wxpay/bizpayurl?pr=fixture', expires_at:new Date(Date.now()+900000).toISOString() } };
    // The merchant QR has its own earlier deadline and carries a time zone offset.
    const alipaySessionExpiry = new Date(Date.parse(original.expires_at) - 60_000 + 8 * 60 * 60 * 1000).toISOString().replace('Z', '123456+08:00');
    const offer = { id:'addon', productId:'superwagie', name:'200 积分加量包', accountKind:'both', kind:'addon', period:'once', price:'9800000', monthlyCredit:'200000000', validityMonths:12, rank:1, sandbox:false, salesReadiness:{ready:true} };
    const largerOffer = {...offer, id:'larger-addon', name:'2000 积分加量包', price:'98000000', monthlyCredit:'2000000000'};
    const membership = {...offer, id:'membership', name:'Standard membership', kind:'membership', period:'month', validityMonths:1};
    let checkout = {...original}, intent, view = 'orders', sequence = 0;
    window.deferClosure = false;
    window.omitClosedFromSummary = false;
    window.confirmClosure = () => {
      checkout = {...checkout, payment_status:'CLOSED', close_pending:undefined, session:undefined};
      intent = intent && {...intent, status:'FAILED'};
    };
    window.writes=[]; window.opened=[]; window.open=(url)=>{window.opened.push(url);return null;};
    window.paymentWrites=()=>window.writes.filter(url=>!/reconcile$/.test(url));
    window.fetch=async(input,init)=>{
      const url=String(input instanceof Request?input.url:input);
      if(init?.method==='POST'){
        window.writes.push(url);
        if (url.endsWith('/checkouts')) {
          const { provider, idempotencyKey, offerId } = JSON.parse(init.body);
          const purchased = offerId === largerOffer.id ? largerOffer : offer;
          checkout = { ...original, id:'payment-'+(++sequence), provider, offer_name:purchased.name, amount:purchased.price,
            session: provider === 'alipay'
              ? { kind: 'qr', expires_at: alipaySessionExpiry, url: 'https://qr.alipay.com/fixture' }
              : { kind: 'qr', expires_at: original.expires_at, url: 'weixin://wxpay/bizpayurl?pr=fixture' } };
          intent = {idempotencyKey,kind:'checkout',accountId:'account',productId:offer.productId,amount:purchased.price,offerId:purchased.id,provider,resourceId:checkout.id,status:'PENDING',createdAt:checkout.created_at};
          return Response.json({...intent,checkout});
        }
        if(url.endsWith('/close')) {
          if (window.deferClosure) {
            checkout = {...checkout, payment_status:'UNKNOWN', close_pending:true, session:undefined, expires_at:new Date(Date.now()-600_000).toISOString()};
          } else {
            window.confirmClosure();
          }
        }
        return Response.json(checkout);
      }
      return Response.json({accountId:'account',role:'owner',financialAccess:true,missingScopes:[],payments:{mode:'external',canPurchase:true,providers:['wechat','alipay']},wallets:[],offers:[offer, largerOffer, membership],orders:[],intents:intent?[intent]:[],checkouts:checkout && !(window.omitClosedFromSummary && checkout.payment_status === 'CLOSED') ? [checkout] : []});
    };
    useI18nStore.getState().setLocale('en');
    const root=createRoot(document.getElementById('root'));let version=0;
    window.remount=()=>root.render(<I18nProvider><div className="@container p-4"><PlatformAccountCommerce key={++version} accountId="account" payer="Payer" view={view} hasActiveMembership={true} membershipSummary={({openAddon,disabled})=><button disabled={disabled} onClick={openAddon}>Open add-ons</button>} onAccountRefresh={()=>{}} /></div></I18nProvider>);
    window.result=(payment,fulfillment,refund='')=>{checkout={...checkout,payment_status:payment,fulfillment_status:fulfillment,refund_status:refund};};
    window.setState=(payment,fulfillment,refund)=>{window.result(payment,fulfillment,refund);window.remount();};
    window.alipay=()=>{checkout.provider='alipay';checkout.session={kind:'redirect',url:'https://openapi.alipay.com/gateway.do?sign=fixture',expires_at:checkout.expires_at};window.remount();};
    window.startPurchase=()=>{view='overview';checkout=undefined;intent=undefined;window.writes=[];window.remount();};
    window.appearance=(dark,locale)=>{document.documentElement.classList.toggle('dark',dark);new CSSVariableGenerator().apply(getDefaultTheme(dark));useI18nStore.getState().setLocale(locale);};
    window.appearance(false,'en');window.remount();
  `);
  const server = await createServer({ configFile: false, root: fixture, cacheDir: path.join(fixture,'.vite'), logLevel:'error', css:{postcss:repo}, define:{'process.env':{},global:'globalThis',__APP_VERSION__:'"fixture"'}, resolve:{alias:{'@':path.join(repo,'packages/ui/src'),'@openchamber/sdk/schemas':path.join(repo,'packages/sdk/src/schemas.ts'),'@openchamber/sdk':path.join(repo,'packages/sdk/src/index.ts')}}, server:{host:'127.0.0.1',port:0,fs:{allow:[repo,fixture]}} });
  const profile=resolveProfileDir(undefined,'platform-checkout'); let chrome; let cdp;
  try {
    await server.listen();const port=await reservePort();chrome=launchChrome({chrome:resolveChrome(),profileDir:profile.dir,port,headless:true});const target=await createPageTarget(port);cdp=new CdpClient(target.webSocketDebuggerUrl);await cdp.connect();await cdp.send('Page.enable');await cdp.send('Runtime.enable');
    const browserErrors=[];cdp.on('Runtime.exceptionThrown',(event)=>browserErrors.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text));
    const evaluate=async(expression)=>{const result=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.equal(result.exceptionDetails,undefined,result.exceptionDetails?.exception?.description);return result.result.value;};
    const until=async(expression)=>{const deadline=Date.now()+25000;while(Date.now()<deadline){if(await evaluate(expression))return;await wait(50);}assert.fail('Timed out: '+expression+' '+await evaluate('document.body.innerText')+' '+JSON.stringify(browserErrors));};
    const click=async(text)=>{await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Button unavailable');button.click();})()`);};
    const category = async (label) => {
      await evaluate(`(() => {
        const button = [...document.querySelectorAll('[data-purchase-categories] button')].find(node => node.textContent === ${JSON.stringify(label)});
        if (!button || button.disabled) throw new Error('Category unavailable');
        button.click();
      })()`);
    };
    const capture = async (name) => {
      const directory = process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR;
      if (!directory) return;
      mkdirSync(directory, { recursive: true });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(directory, name + '.png'), Buffer.from(shot.data, 'base64'));
    };
    await cdp.send('Page.navigate',{url:server.resolvedUrls.local[0]});
    await until('document.querySelector("img")?.naturalWidth > 0');
    assert.equal(await evaluate('document.title'), 'SuperWagie checkout');
    assert.deepEqual(await evaluate('window.writes'),[]);
    assert.deepEqual(await evaluate('window.opened'),[]);
    for(const [dark,locale,width] of [[false,'en',1200],[true,'zh-CN',390]]){
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await evaluate(`window.appearance(${dark},${JSON.stringify(locale)})`);await wait(100);
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
      assert.equal(await evaluate('(()=>{const rect=document.querySelector("img").getBoundingClientRect();return rect.width>=200 && rect.right<=innerWidth;})()'),true);
      const evidence=process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR;if(evidence){mkdirSync(evidence,{recursive:true});const shot=await cdp.send('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(evidence,`checkout-${locale}-${dark?'dark':'light'}.png`),Buffer.from(shot.data,'base64'));}
    }
    await evaluate('window.appearance(false,"en");window.alipay()');
    await until('document.body.innerText.includes("Close the previous checkout")');
    assert.equal(await evaluate('document.querySelector("img") !== null'),false);
    assert.equal(await evaluate('document.body.innerText.includes("scan the code")'),false);
    assert.deepEqual(await evaluate('window.opened'),[]);
    assert.equal(await evaluate('document.body.innerText.includes("Open Alipay checkout")'),false);
    assert.equal(await evaluate('document.body.innerText.includes("Check original request")'),false);
    await until('window.writes.length>=1');
    assert.match((await evaluate('window.writes'))[0],/checkouts\/original-checkout\/reconcile$/);
    await evaluate('window.setState("PAID","PENDING","")');await until('document.body.innerText.includes("Activating your benefits")');
    assert.equal(await evaluate('document.body.innerText.includes("Open Alipay checkout")'),false);
    await evaluate('window.setState("PAID","FULFILLED","PENDING")');await until('document.body.innerText.includes("Refund processing")');
    await evaluate('window.remount()');await until('document.body.innerText.includes("Refund processing")');
    assert.equal(await evaluate('window.paymentWrites().length'),0);
    assert.equal(await evaluate('document.body.innerText.includes("Request original-channel refund")'),false);
    await evaluate('window.setState("PAID","FULFILLED","")');
    await until('document.body.innerText.includes("Request original-channel refund")');
    await click('Request original-channel refund');assert.equal(await evaluate('window.paymentWrites().length'),0);
    await click('Close');assert.equal(await evaluate('window.paymentWrites().length'),0);
    assert.equal(await evaluate('document.body.innerText.includes("Confirm refund")'),false);
    await click('Request original-channel refund');assert.equal(await evaluate('window.paymentWrites().length'),0);
    await click('Confirm refund');await until('window.paymentWrites().length===1');
    assert.match((await evaluate('window.paymentWrites()'))[0],/checkouts\/original-checkout\/refund$/);
    for (const [initialProvider, provider, width] of [['WeChat Pay', 'WeChat Pay', 1200], ['WeChat Pay', 'Alipay', 390], ['Alipay', 'WeChat Pay', 760]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:width === 390 ? 820 : 740,deviceScaleFactor:1,mobile:false});
      await evaluate('window.startPurchase()');
      await until('[...document.querySelectorAll("button")].some(node=>node.textContent==="Open add-ons"&&!node.disabled)');
      await click('Open add-ons');
      if (initialProvider === 'Alipay') await click(initialProvider);
      assert.deepEqual(await evaluate('window.paymentWrites()'), [], 'Browsing and changing the method are read-only');
      assert.equal(await evaluate('document.querySelectorAll("[data-platform-offer]").length'), 2);
      if (width === 1200 && provider === initialProvider) {
        await evaluate('window.appearance(false,"zh-CN")');
        await until('document.querySelector("[data-platform-offer]").innerText.includes("扫码购买")');
        await capture('catalog-zh-CN-1200');
        await evaluate('window.appearance(false,"en")');
      }
      await evaluate('document.querySelector("[data-platform-offer]").click()');
      await until('document.querySelector("[data-purchase-checkout] img")?.naturalWidth > 0');
      await evaluate('window.confirmation=document.querySelector("[data-purchase-checkout]");void 0');
      assert.equal(await evaluate('document.querySelectorAll("[data-platform-offer]").length'), 2);
      assert.equal(await evaluate('document.querySelector("[data-platform-offer][aria-current=true]").disabled'), true);
      assert.equal(await evaluate('document.querySelectorAll("[data-purchase-categories] button:not(:disabled)").length'), 2);
      assert.equal(await evaluate('document.body.innerText.includes("2000 积分加量包")'), true);
      assert.deepEqual((await evaluate('window.paymentWrites()')).map(url => url.split('/').at(-1)), ['checkouts']);
      if (provider !== initialProvider) {
        const originalCheckoutId = await evaluate('window.confirmation.querySelector("[data-payment-checkout]").getAttribute("data-payment-checkout")');
        assert.match(await evaluate('window.confirmation.querySelector("img").alt'), initialProvider === 'Alipay' ? /Alipay/ : /WeChat/);
        await click(provider);
        const brand = provider === 'Alipay' ? 'Alipay' : 'WeChat';
        await until(`(window.confirmation.querySelector("img")?.alt.includes(${JSON.stringify(brand)}) && window.confirmation.querySelector("img").naturalWidth > 0) || Boolean(document.querySelector("[role=alert]"))`);
        assert.equal(await evaluate('document.querySelector("[role=alert]")?.textContent ?? null'), null, 'Checkout creation and summary should accept the merchant QR expiry format');
        const writes = await evaluate('window.paymentWrites()');
        assert.deepEqual(writes.map(url => url.split('/').at(-1)), ['checkouts', 'close', 'checkouts']);
        assert.equal(writes[1], '/api/platform-account/commerce/checkouts/' + originalCheckoutId + '/close');
        assert.notEqual(await evaluate('window.confirmation.querySelector("[data-payment-checkout]").getAttribute("data-payment-checkout")'), originalCheckoutId);
      }
      assert.equal(await evaluate('window.confirmation===document.querySelector("[data-purchase-checkout]")'),true);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
      const imageAlt=await evaluate('window.confirmation.querySelector("img").alt');
      assert.match(imageAlt, provider==='Alipay'?/Alipay/:/WeChat/);
      assert.equal(await evaluate('document.activeElement.matches("[data-purchase-checkout]")'), true);
      if (provider === initialProvider || width === 390 || width === 760) {
        await evaluate('window.appearance(false,"zh-CN")');
        await until('document.querySelector("[data-purchase-categories]").innerText.includes("购买加量包")');
        await capture('payment-zh-CN-' + width);
        const layout = await evaluate(`(() => {
          const qr = window.confirmation.querySelector('img').getBoundingClientRect();
          const catalog = document.querySelector('[data-purchase-catalog]').getBoundingClientRect();
          const offer = document.querySelector('[data-platform-offer]').getBoundingClientRect();
          const checkout = window.confirmation.getBoundingClientRect();
          return {
            arranged: innerWidth > 700 ? catalog.right <= checkout.left : catalog.bottom <= checkout.top,
            offerVisible: offer.bottom > 0 && offer.top < innerHeight,
            qrVisible: qr.width >= 200 && qr.left >= 0 && qr.right <= innerWidth && qr.bottom <= innerHeight,
            qrBottom: qr.bottom, offerTop: offer.top, checkoutTop: checkout.top,
          };
        })()`);
        assert.ok(layout.arranged && layout.offerVisible && layout.qrVisible, JSON.stringify(layout));
        await evaluate('window.appearance(false,"en")');
        await until('document.querySelector("[data-purchase-categories]").innerText.includes("Buy extra credits")');
      }
      await evaluate('window.result("PAID","PENDING")');
      await until('window.confirmation.innerText.includes("Activating your benefits")&&!window.confirmation.querySelector("img")');
      await evaluate('window.result("PAID","FULFILLED")');
      await until('window.confirmation.innerText.includes("Your purchase is active") && document.querySelectorAll("[data-purchase-categories] button:not(:disabled)").length === 2');
      assert.equal(await evaluate('window.confirmation.querySelector("img")'),null);
      assert.equal(await evaluate('window.paymentWrites().length'), provider !== initialProvider ? 3 : 1);
      assert.deepEqual(await evaluate('window.opened'),[]);
      await category('Subscribe');
      await until(`Boolean(document.querySelector("[data-platform-offer][aria-label='Standard membership']"))`);
      assert.equal(await evaluate('window.confirmation===document.querySelector("[data-purchase-checkout]")'), true);
      assert.equal(await evaluate('window.paymentWrites().length'), provider !== initialProvider ? 3 : 1);
    }
    await evaluate('window.startPurchase()');
    await until('[...document.querySelectorAll("button")].some(node=>node.textContent==="Open add-ons"&&!node.disabled)');
    await click('Open add-ons');
    await evaluate('document.querySelectorAll("[data-platform-offer]")[1].click()');
    await until('document.querySelector("[data-purchase-checkout] img")?.naturalWidth > 0');
    assert.equal(await evaluate('document.querySelector("[data-purchase-checkout]").innerText.includes("¥98.00")'), true);
    await category('Subscribe');
    await until(`Boolean(document.querySelector("[data-platform-offer][aria-label='Standard membership']"))`);
    assert.equal(await evaluate('document.querySelector("[data-purchase-checkout] img")?.naturalWidth > 0'), true);
    assert.deepEqual((await evaluate('window.paymentWrites()')).map(url => url.split('/').at(-1)), ['checkouts']);
    await category('Buy extra credits');
    const otherOffer = 'document.querySelector("[data-platform-offer]")';
    await evaluate(otherOffer + '.click()');
    await until(`document.querySelector("[data-purchase-checkout]").innerText.includes("¥9.80") && document.querySelector("[data-purchase-checkout] img")?.naturalWidth > 0`);
    assert.deepEqual((await evaluate('window.paymentWrites()')).map(url => url.split('/').at(-1)), ['checkouts', 'close', 'checkouts']);

    await click('Alipay');
    await until('document.querySelector("[data-purchase-checkout] img")?.alt.includes("Alipay")');
    await evaluate('window.deferClosure = true; window.omitClosedFromSummary = true');
    await evaluate('document.querySelectorAll("[data-platform-offer]")[1].click()');
    await until('document.querySelector("[data-purchase-checkout]").innerText.includes("Waiting for closure confirmation")');
    assert.equal(await evaluate('Boolean(document.querySelector("[data-purchase-checkout] img"))'), false);
    assert.equal(await evaluate('document.querySelectorAll("[data-platform-offer]").length'), 2);
    assert.equal(await evaluate('document.querySelectorAll("[data-platform-offer]:not(:disabled)").length'), 0);
    assert.deepEqual((await evaluate('window.paymentWrites()')).map(url => url.split('/').at(-1)), ['checkouts', 'close', 'checkouts', 'close', 'checkouts', 'close']);
    await evaluate('window.confirmClosure()');
    await until(`document.querySelector("[data-purchase-checkout]").innerText.includes("¥98.00") && document.querySelector("[data-purchase-checkout] img")?.alt.includes("Alipay")`);
    assert.deepEqual((await evaluate('window.paymentWrites()')).map(url => url.split('/').at(-1)), ['checkouts', 'close', 'checkouts', 'close', 'checkouts', 'close', 'checkouts']);
    assert.deepEqual(browserErrors, [], 'Checkout browser flow must not raise unhandled exceptions');
  } finally {if(cdp){await cdp.send('Browser.close').catch(()=>{});cdp.close();}if(chrome){chrome.kill();await wait(300);}await server.close();rmSync(fixture,{recursive:true,force:true});if(profile.temporary)rmSync(profile.dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
