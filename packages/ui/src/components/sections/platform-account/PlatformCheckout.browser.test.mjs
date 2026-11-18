import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from '../../../../../../scripts/perf/cdp.mjs';
const repo = path.resolve(import.meta.dirname, '../../../../../..');
test('both channels render in the purchase confirmation and show payment through fulfillment', { timeout: 90_000 }, async () => {
  const { createServer } = await import('vite');
  mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repo, 'tmp/platform-checkout-'));
  writeFileSync(path.join(fixture, 'index.html'), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.tsx'), `
    import React from 'react'; import { createRoot } from 'react-dom/client'; import '@/index.css';
    import { I18nProvider, useI18nStore } from '@/lib/i18n';
    import { PlatformAccountCommerce } from '@/components/sections/platform-account/PlatformAccountCommerce';
    import { CSSVariableGenerator } from '@/lib/theme/cssGenerator'; import { getDefaultTheme } from '@/lib/theme/themes';
    const original = { id:'original-checkout', account_id:'account', product_id:'superwagie', provider:'wechat', offer_name:'Confirmed plan', amount:'99000000', currency:'CNY', payment_status:'PENDING', fulfillment_status:'NOT_STARTED', refund_status:'', expires_at:new Date(Date.now()+900000).toISOString(), created_at:new Date().toISOString(), session:{ kind:'qr', url:'weixin://wxpay/bizpayurl?pr=fixture', expires_at:new Date(Date.now()+900000).toISOString() } };
    const offer = { id:'addon', productId:'superwagie', name:'200 credits', accountKind:'both', kind:'addon', period:'once', price:'9800000', monthlyCredit:'200000000', validityMonths:12, rank:1, sandbox:false };
    let checkout = {...original}, intent, view = 'orders', sequence = 0;
    window.writes=[]; window.opened=[]; window.open=(url)=>{window.opened.push(url);return null;};
    window.paymentWrites=()=>window.writes.filter(url=>!/reconcile$/.test(url));
    window.fetch=async(input,init)=>{
      const url=String(input instanceof Request?input.url:input);
      if(init?.method==='POST'){
        window.writes.push(url);
        if (url.endsWith('/checkouts')) {
          const { provider, idempotencyKey } = JSON.parse(init.body);
          checkout = { ...original, id:'payment-'+(++sequence), provider, offer_name:offer.name, amount:offer.price,
            session:{kind:'qr',expires_at:original.expires_at,url:provider==='alipay'?'https://qr.alipay.com/fixture':'weixin://wxpay/bizpayurl?pr=fixture'} };
          intent = {idempotencyKey,kind:'checkout',accountId:'account',productId:offer.productId,amount:offer.price,offerId:offer.id,provider,resourceId:checkout.id,status:'PENDING',createdAt:checkout.created_at};
          return Response.json({...intent,checkout});
        }
        if(url.endsWith('/close')) {
          checkout={...checkout,payment_status:'CLOSED',session:undefined};
          intent=intent && {...intent,status:'FAILED'};
        }
        return Response.json(checkout);
      }
      return Response.json({accountId:'account',role:'owner',financialAccess:true,missingScopes:[],payments:{mode:'external',canPurchase:true,providers:['wechat','alipay']},wallets:[],offers:[offer],orders:[],intents:intent?[intent]:[],checkouts:checkout?[checkout]:[]});
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
    await cdp.send('Page.navigate',{url:server.resolvedUrls.local[0]});
    await until('document.querySelector("img")?.naturalWidth > 0');
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
    for (const [provider,width] of [['WeChat Pay',1200],['Alipay',390]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await evaluate('window.startPurchase()');
      await until('[...document.querySelectorAll("button")].some(node=>node.textContent==="Open add-ons"&&!node.disabled)');
      await click('Open add-ons');
      await evaluate('document.querySelector("[role=radio]").click()');
      await click('WeChat Pay');
      await evaluate('window.confirmation=document.querySelector("[data-purchase-confirmation]");[...window.confirmation.querySelectorAll("button")].find(node=>node.textContent.startsWith("Buy ")).click()');
      await until('window.confirmation.querySelector("img")?.naturalWidth > 0');
      if (provider === 'Alipay') {
        await click('Alipay');
        await until('window.confirmation.querySelector("img")?.alt.includes("Alipay") && window.confirmation.querySelector("img").naturalWidth > 0');
        assert.deepEqual((await evaluate('window.paymentWrites()')).map(url=>url.split('/').at(-1)), ['checkouts','close','checkouts']);
      }
      assert.equal(await evaluate('window.confirmation===document.querySelector("[data-purchase-confirmation]")'),true);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
      const imageAlt=await evaluate('window.confirmation.querySelector("img").alt');
      assert.match(imageAlt, provider==='Alipay'?/Alipay/:/WeChat/);
      const evidence=process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR;
      if(evidence){
        mkdirSync(evidence,{recursive:true});
        const slug=provider==='Alipay'?'alipay':'wechat';
        const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
        writeFileSync(path.join(evidence,slug+'-inline.png'),Buffer.from(shot.data,'base64'));
        const qr=await evaluate('window.confirmation.querySelector("img").src.split(",")[1]');
        writeFileSync(path.join(evidence,slug+'-qr.png'),Buffer.from(qr,'base64'));
      }
      await evaluate('window.result("PAID","PENDING")');
      await until('window.confirmation.innerText.includes("Activating your benefits")&&!window.confirmation.querySelector("img")');
      await evaluate('window.result("PAID","FULFILLED")');
      await until('window.confirmation.innerText.includes("Return to purchase")');
      assert.equal(await evaluate('window.confirmation.querySelector("img")'),null);
      assert.equal(await evaluate('window.paymentWrites().length'),provider === 'Alipay' ? 3 : 1);
      assert.deepEqual(await evaluate('window.opened'),[]);
      await click('Return to purchase');
      await until('!window.confirmation.querySelector("[data-payment-checkout]")');
    }
    assert.deepEqual(browserErrors, [], 'Checkout browser flow must not raise unhandled exceptions');
  } finally {if(cdp){await cdp.send('Browser.close').catch(()=>{});cdp.close();}if(chrome){chrome.kill();await wait(300);}await server.close();rmSync(fixture,{recursive:true,force:true});if(profile.temporary)rmSync(profile.dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
