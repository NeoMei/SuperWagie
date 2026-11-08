import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from '../../../../../../scripts/perf/cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../../../../../..');

test('native credit setup requires explicit activation, respects readiness and refuses mobile account setup', { timeout: 120_000 }, async () => {
  const { createServer } = await import('vite');
  mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repo, 'tmp/platform-credit-keys-'));
  writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  writeFileSync(path.join(fixture, 'fixture.tsx'), `
    import React from 'react'; import { createRoot } from 'react-dom/client'; import '@/index.css';
    import { I18nProvider, useI18nStore } from '@/lib/i18n';
    import { PlatformAccountApiKeys } from '@/components/sections/platform-account/PlatformAccountApiKeys';
    import { ModelQuickSetupWizard } from '@/components/sections/model-configuration/ModelQuickSetupWizard';
    import { CSSVariableGenerator } from '@/lib/theme/cssGenerator'; import { getDefaultTheme } from '@/lib/theme/themes';
    window.writes=[]; window.reads=[]; window.ready=false; window.configured=0;
    const activation = { operationId:'fixture-credit-operation', fundingMode:'credits', pricingSource:'llmrouter_native_credit', status:'ready', stage:'test', key:{id:'fixture-public-id',last4:'FIX1',createdAt:'2026-11-08T00:00:00Z',expiresAt:null}, modelId:'fixture-chat',connectionId:'fixture-connection',providerId:'fixture-provider',test:{status:'verified',testedAt:'2026-11-08T00:01:00Z',errorCode:null},testRunId:'fixture-run',tests:[{id:'chat',purpose:'agent',modelId:'fixture-chat',status:'verified',applied:true,testedAt:'2026-11-08T00:01:00Z',errorCode:null}],errorCode:null,actions:['retest'] };
    let activated=false;
    window.fetch=async(input,init)=>{
      const url=new URL(input instanceof Request?input.url:String(input),location.href);
      const method=init?.method??'GET';
      if(url.pathname!=='/api/model-configuration/bootstrap/account-key')throw new Error('Unexpected fixture request: '+url.pathname);
      let fundingMode=url.searchParams.get('fundingMode')??'prepaid_cash';
      if(method==='POST'){
        const body=JSON.parse(String(init.body));window.writes.push({path:url.pathname,method,body});fundingMode=body.fundingMode;
        if(!window.ready)return Response.json({error:'native_credits_unavailable'},{status:409});activated=true;
      }else window.reads.push({path:url.pathname,fundingMode});
      return Response.json({accountId:'fixture-account',enterpriseMode:false,fundingMode,nativeCredits:{ready:window.ready},activation:activated&&fundingMode==='credits'?activation:null});
    };
    const root=createRoot(document.getElementById('root'));
    window.appearance=(dark)=>{document.documentElement.classList.toggle('dark',dark);new CSSVariableGenerator().apply(getDefaultTheme(dark));useI18nStore.getState().setLocale('zh-CN');};
    window.scene=(mobile=false)=>{window.__OPENCHAMBER_SURFACE__=mobile?'mobile':'desktop';root.render(<I18nProvider>{mobile?<ModelQuickSetupWizard open configuration={{version:1,revision:0,enterpriseMode:false,credentialSources:{status:'available',sources:[]},purposes:[],presets:[],connections:[],bindings:[]}} onClose={()=>{}} onApplied={()=>{}}/>:<main className="@container p-4" style={{maxWidth:1000,margin:'0 auto'}}><PlatformAccountApiKeys accountId="fixture-account" onConfigured={()=>{window.configured++;}}/></main>}</I18nProvider>);};
    window.appearance(false);window.scene();
  `);
  const server = await createServer({ configFile:false,root:fixture,cacheDir:path.join(fixture,'.vite'),logLevel:'error',css:{postcss:repo},define:{'process.env':{},global:'globalThis',__APP_VERSION__:'"fixture"'},resolve:{alias:{'@':path.join(repo,'packages/ui/src'),'@openchamber/sdk/schemas':path.join(repo,'packages/sdk/src/schemas.ts'),'@openchamber/sdk':path.join(repo,'packages/sdk/src/index.ts')}},server:{host:'127.0.0.1',port:0,fs:{allow:[repo,fixture]}} });
  const profile = resolveProfileDir(undefined, 'platform-credit-keys');
  let chrome; let cdp;
  try {
    await server.listen(); const port=await reservePort(); chrome=launchChrome({chrome:resolveChrome(),profileDir:profile.dir,port,headless:true});
    const target=await createPageTarget(port); cdp=new CdpClient(target.webSocketDebuggerUrl);await cdp.connect();await cdp.send('Page.enable');await cdp.send('Runtime.enable');
    const errors=[];cdp.on('Runtime.exceptionThrown',event=>errors.push(event.exceptionDetails?.exception?.description??event.exceptionDetails?.text));
    const evaluate=async(expression)=>{const result=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.equal(result.exceptionDetails,undefined,result.exceptionDetails?.exception?.description);return result.result.value;};
    const until=async(expression)=>{const deadline=Date.now()+25000;while(Date.now()<deadline){if(await evaluate(expression))return;await wait(50);}assert.fail('Timed out: '+expression+' '+await evaluate('document.body.innerText')+' '+JSON.stringify(errors));};
    const button=(label)=>`[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(label)})`;
    const click=async(label)=>{const point=await evaluate(`(()=>{const b=${button(label)};if(!b||b.disabled)throw new Error('Unavailable button: '+${JSON.stringify(label)});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});};
    const screenshot=async(name,dark,width)=>{
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await evaluate(`window.appearance(${dark})`);await wait(150);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'No horizontal overflow');
      const evidence=process.env.PLATFORM_ACCOUNT_EVIDENCE_DIR;if(evidence){mkdirSync(evidence,{recursive:true});const shot=await cdp.send('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(evidence,name),Buffer.from(shot.data,'base64'));}
    };
    await cdp.send('Page.navigate',{url:server.resolvedUrls.local[0]});
    await until(`${button('现金余额')} && ${button('积分')} && window.reads.length===1`);
    assert.deepEqual(await evaluate('window.writes'),[]);
    await click('积分');await until('window.reads.at(-1)?.fundingMode==="credits" && document.body.innerText.includes("积分模型调用暂未开通。")');
    assert.equal(await evaluate(`${button('开通并配置')}?.disabled`),true);
    assert.deepEqual(await evaluate('window.writes'),[]);
    await screenshot('native-credit-key-zh-CN-dark-390-unavailable.png',true,390);
    await evaluate('window.ready=true');await click('刷新');await until(`${button('开通并配置')}?.disabled===false`);
    assert.deepEqual(await evaluate('window.writes'),[]);
    await screenshot('native-credit-key-zh-CN-light-1200-ready.png',false,1200);
    await click('开通并配置');await until('window.writes.length===1 && document.body.innerText.includes("FIX1")');
    assert.deepEqual(await evaluate('window.writes'),[{path:'/api/model-configuration/bootstrap/account-key',method:'POST',body:{accountId:'fixture-account',action:'activate',fundingMode:'credits'}}]);
    await click('现金余额');await until('window.reads.at(-1)?.fundingMode==="prepaid_cash"');
    assert.equal(await evaluate('window.writes.length'),1);
    await evaluate('window.scene(true)');await until('document.querySelector("[role=dialog]") && document.body.innerText.includes("发现模型")');
    assert.equal(await evaluate(`${button('发现模型')}?.disabled`),true);
    assert.equal(await evaluate('window.writes.length'),1);
    await screenshot('native-credit-setup-mobile-zh-CN-dark-390-unsupported.png',true,390);
    assert.deepEqual(errors,[]);
  } finally {
    if(cdp){await cdp.send('Browser.close').catch(()=>{});cdp.close();}
    if(chrome){chrome.kill();await wait(300);}
    await server.close();rmSync(fixture,{recursive:true,force:true});
    if(profile.temporary)rmSync(profile.dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
});
