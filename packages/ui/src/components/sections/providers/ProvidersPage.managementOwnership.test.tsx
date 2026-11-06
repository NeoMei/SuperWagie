import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Provider, Model } from '@/lib/opencode/model';
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
 localStorage: browser.localStorage, Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
 HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
 Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
 MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
 getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
 cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const deferred = () => { let finish: () => void = () => { throw new Error('Uninitialized deferred'); }; const promise = new Promise<void>(r => finish = r); return { promise, finish }; };
type Entry = {host:string; path:string; method:string; directory:string|null; body:string};
const records: Entry[] = [];
let heldPath = ''; let failed = false; let gate = deferred(); let disabled: string[] = []; let configHeld = false; let configGate = deferred();
const provider = (id:string): Provider => ({id,name:id==='openai'?'OpenAI':id==='google'?'Google':id==='custom-a'?'Custom A':'Custom B',activation:'enabled',package:'aisdk:@ai-sdk/openai-compatible',settings:{}});
const model = (id:string): Model => ({id:'dummy-model',modelID:'dummy-model',providerID:id,name:'Dummy model',capabilities:{input:['text'],output:['text'],tools:true},variants:[],time:{released:0},cost:[],status:'active',enabled:true,limit:{context:8000,output:1000}});
const ids = ['openai','google','custom-a','custom-b'];
const credential = (id:string,n:number) => ({type:'credential',id:`DUMMY_${id}_${n}`,label:`Dummy ${id} ${n}`,method:'key'});
const integration = (id:string) => ({id,name:provider(id).name,connections:id==='google'||id==='custom-b'?[]:[credential(id,1),credential(id,2)],methods:[{type:'key',label:'API key',form:[{key:'resource',title:'Dummy resource',type:'string',required:true}]}]});
const fetchSpy = spyOn(globalThis,'fetch').mockImplementation(async(input,init) => {
 const req = input instanceof Request ? input : new Request(new URL(String(input),'http://localhost'),init);
 const url = new URL(req.url); const method = init?.method ?? req.method;
 const body = init?.body ? String(init.body) : method==='GET'?'':await req.clone().text();
 records.push({host:url.host,path:url.pathname,method,directory:req.headers.get('x-opencode-directory'),body});
 if(method==='PUT' && url.pathname==='/api/provider' && configHeld) { await configGate.promise; return Response.json({error:'DUMMY_CONFIG_REJECTION'},{status:400}); }
 if(method!=='GET' && url.pathname===heldPath) { await gate.promise; if(failed)return Response.json({error:'DUMMY_REJECTION',name:'ValidationError',data:{message:'DUMMY_REJECTION'}},{status:400}); }
 if(url.pathname.endsWith('/disabled') && method==='PUT') { const id=decodeURIComponent(url.pathname.split('/')[3]);disabled=JSON.parse(body).disabled?[id]:[];return Response.json({providers:disabled}); }
 if(url.pathname==='/api/provider/disabled')return Response.json({providers:disabled});
 if(url.pathname.includes('/connect/key'))return new Response(null,{status:204});
 if(url.pathname.includes('/credential/') && method!=='GET')return new Response(null,{status:204});
 if(url.pathname==='/api/integration')return Response.json({location:{directory:'/fixture'},data:ids.map(integration)});
 if(url.pathname==='/api/provider')return Response.json({location:{directory:'/fixture'},data:ids.filter(id=>!disabled.includes(id)).map(provider)});
 if(url.pathname==='/api/model')return Response.json({location:{directory:'/fixture'},data:ids.filter(id=>!disabled.includes(id)).map(model)});
 if(url.pathname.endsWith('/source')) { const custom=url.pathname.includes('custom-');return Response.json({sources:{user:{exists:custom,path:'/fixture/opencode.json'},project:{exists:false},custom:{exists:false}},config:custom?{name:url.pathname.includes('custom-a')?'Custom A':'Custom B',package:'aisdk:@ai-sdk/openai-compatible',settings:{baseURL:'https://dummy-custom.invalid/v1'},models:{'dummy-model':{modelID:'dummy-model',name:'Dummy model'}}}:null}); }
 if(url.pathname.includes('websearch'))return Response.json({data:[]});
 if(url.pathname.includes('/config/settings'))return Response.json({projects:[{id:'fixture',path:'/fixture'}],activeProjectId:'fixture',customProviderIcons:{}});
 if(url.pathname.endsWith('/path'))return Response.json({home:'/fixture',directory:'/fixture'});
 return Response.json({data:[],success:true});
});
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { opencodeClient } = await import('@/lib/opencode/client');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { ProvidersPage } = await import('@/components/sections/providers/ProvidersPage');
const { toast } = await import('@/components/ui');
const success = spyOn(toast,'success').mockImplementation(()=> 'success');
const error = spyOn(toast,'error').mockImplementation(()=> 'error');
const consoleError = spyOn(console,'error').mockImplementation(()=>{});
let root: ReturnType<typeof createRoot>|null = null;
const pause=(ms=15)=>new Promise(r=>setTimeout(r,ms));
const until=async(ready:()=>boolean)=>{for(let n=0;n<70;n++){if(ready())return;await pause(10);}throw Error('Probe condition timeout: '+document.body.textContent?.slice(0,1000));};
const switchTo=(id:string)=>{switchRuntimeEndpoint({apiBaseUrl:`http://actions-${id}.invalid`,runtimeKey:`actions-${id}`});opencodeClient.reconnectToRuntimeBaseUrl();opencodeClient.setDirectory('/fixture');};
const render=(key='epoch0')=>root!.render(createElement(I18nProvider,null,createElement(ThemeSystemProvider,null,createElement(ProvidersPage,{key}))));
const button=(text:string,exact=false)=>{const found=[...document.querySelectorAll<HTMLButtonElement>('button')].find(n=>exact?n.textContent?.trim()===text:n.textContent?.trim().includes(text)||n.getAttribute('aria-label')?.includes(text));if(!found)throw Error('Missing '+text+' BUTTONS '+[...document.querySelectorAll('button')].map(n=>[n.textContent,n.getAttribute('aria-label')]));return found;};
const keyInput=()=>document.querySelector<HTMLInputElement>('input[type="password"]');
const resourceInput=()=>document.querySelector<HTMLInputElement>('input[aria-label="Dummy resource"]');
const nameInput=()=>document.querySelector<HTMLInputElement>('input[aria-label="Display name"]');
async function type(node:HTMLInputElement|null,value:string){if(!node)throw Error('Missing input');const setter=Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype,'value')!.set!;await act(async()=>{setter.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});}
async function setup(id='openai'){
 heldPath='';failed=false;gate=deferred();disabled=[];configHeld=false;configGate=deferred();switchTo('a');
 useProjectsStore.setState({projects:[{id:'fixture',path:'/fixture'}],activeProjectId:'fixture'});
 useUIStore.setState({settingsProjectPath:'/fixture',settingsProvidersConnectRequested:false,settingsProvidersClassificationRequested:false,settingsProvidersOpenRequested:id});
 useI18nStore.getState().setLocale('en');
 const box=document.createElement('div');document.body.replaceChildren(box);root=createRoot(box);
 await act(async()=>{render();await pause(50);});
 await act(async()=>until(()=>!!document.querySelector('button[title*="Hide this provider"]')));
 success.mockClear();error.mockClear();records.length=0;
}
const writes=()=>records.filter(r=>r.method!=='GET');
const snapshot=(name:string,extra={})=>console.log(JSON.stringify({case:name,key:keyInput()?.value??null,resource:resourceInput()?.value??null,name:nameInput()?.value??null,records:[...records],success:success.mock.calls.length,error:error.mock.calls.length,text:document.body.textContent?.slice(0,600),...extra}));
async function navigate(label:string){await act(async()=>button('All providers').click());await act(async()=>button(label).click());}
async function googleDraft(){await navigate('Google');await act(async()=>until(()=>keyInput()!==null));await type(keyInput(),'DUMMY_NEW_KEY');await type(resourceInput(),'DUMMY_NEW_RESOURCE');const node=keyInput()!;return node;}
async function customEdit(){await act(async()=>until(()=>[...document.querySelectorAll('button')].some(n=>n.textContent?.trim()==='Edit')));await act(async()=>button('Edit',true).click());await act(async()=>until(()=>nameInput()!==null));}
async function customDraft(){await navigate('Custom B');await customEdit();await type(nameInput(),'DUMMY_NEW_CUSTOM_NAME');return nameInput()!;}
async function startDisable(fail=false){heldPath='/api/provider/openai/disabled';failed=fail;await act(async()=>{button('Disable',true).click();await until(()=>writes().length===1);});expect(writes()[0]?.host).toBe('actions-a.invalid');expect(writes()[0]?.body).toBe('{"disabled":true}');}
async function startDisconnect(fail=false){await customEdit();heldPath='/api/credential/DUMMY_custom-a_1';failed=fail;await act(async()=>{button('Disconnect',true).click();await until(()=>writes().length===1);});expect(writes()[0]?.host).toBe('actions-a.invalid');}
async function accountAction(kind:'activate'|'rename'|'remove'){
 if(kind==='activate'){await act(async()=>button('Use Dummy openai 2').click());return;}
 await act(async()=>button('Actions for Dummy openai 2').click());
 const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(n=>n.textContent?.trim()===(kind==='rename'?'Rename':'Remove'));
 if(!item)throw Error('Missing account '+kind+' menu');await act(async()=>item.click());
 if(kind==='rename'){await type(document.querySelector<HTMLInputElement>('input[aria-label="Account name"]'),'DUMMY_RENAMED');const form=document.querySelector<HTMLFormElement>('input[aria-label="Account name"]')?.closest('form');if(!form)throw Error('Missing rename form');await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));}
}
afterEach(async()=>{gate.finish();configGate.finish();await act(async()=>{root?.unmount();root=null;await pause(25);});});
afterAll(()=>{fetchSpy.mockRestore();success.mockRestore();error.mockRestore();consoleError.mockRestore();browser.close();});

test('disable current owner returns to grid and rereads its catalog',async()=>{await setup();await act(async()=>{button('Disable',true).click();await pause(70);});snapshot('disable-current');expect(writes()).toHaveLength(1);expect(success.mock.calls).toHaveLength(1);expect(document.body.textContent).toContain('Disabled providers');expect(records.some(r=>r.path==='/api/provider'&&r.host==='actions-a.invalid')).toBe(true);});
for(const fail of [false,true])test(`disable late ${fail?'failure':'success'} after native Google navigation`,async()=>{await setup();await startDisable(fail);const node=await googleDraft();records.length=0;await act(async()=>{gate.finish();await pause(80);});snapshot('disable-late-'+(fail?'failure':'success'),{newNodeRetained:keyInput()===node});expect(writes()).toEqual([]);expect(keyInput()===node).toBe(true);expect(keyInput()?.value).toBe('DUMMY_NEW_KEY');expect(resourceInput()?.value).toBe('DUMMY_NEW_RESOURCE');if(!fail){const catalogReads=records.filter(r=>['/api/provider','/api/model','/api/model/default'].includes(r.path));expect(catalogReads.some(r=>r.path==='/api/provider')).toBe(true);expect(catalogReads.every(r=>r.host==='actions-a.invalid'&&decodeURIComponent(r.directory??'')==='/fixture')).toBe(true);await act(async()=>button('All providers').click());expect(document.body.textContent).toContain('Disabled providers');expect(button('Enable',true).parentElement?.textContent).toContain('openai');}expect(error.mock.calls).toHaveLength(fail?1:0);expect(success.mock.calls).toHaveLength(fail?0:1);});
test('disable outer epoch remount preserves B draft without starting B catalog reads',async()=>{await setup();await startDisable();await act(async()=>{switchTo('b');useUIStore.setState({settingsProvidersOpenRequested:'google'});render('epoch1');await pause(60);});await type(keyInput(),'DUMMY_B_KEY');const node=keyInput();records.length=0;await act(async()=>{gate.finish();await pause(80);});snapshot('disable-remounted-B',{newNodeRetained:keyInput()===node});expect(keyInput()===node).toBe(true);expect(keyInput()?.value).toBe('DUMMY_B_KEY');expect(writes()).toEqual([]);expect(records.filter(r=>r.host==='actions-b.invalid'&&['/api/provider','/api/model','/api/model/default'].includes(r.path))).toEqual([]);});

test('disconnect current custom owner completes captured credential removals',async()=>{await setup('custom-a');await startDisconnect();await act(async()=>{gate.finish();await pause(75);});snapshot('disconnect-current');expect(writes().map(r=>r.path)).toEqual(['/api/credential/DUMMY_custom-a_1','/api/credential/DUMMY_custom-a_2']);expect(writes().every(r=>r.host==='actions-a.invalid')).toBe(true);expect(nameInput()).toBeNull();expect(success.mock.calls).toHaveLength(1);});
for(const fail of [false,true])test(`disconnect late ${fail?'failure':'success'} after native custom B editor navigation`,async()=>{await setup('custom-a');await startDisconnect(fail);const node=await customDraft();records.length=0;await act(async()=>{gate.finish();await pause(80);});snapshot('disconnect-late-'+(fail?'failure':'success'),{newNodeRetained:nameInput()===node});expect(nameInput()===node).toBe(true);expect(nameInput()?.value).toBe('DUMMY_NEW_CUSTOM_NAME');expect(error.mock.calls).toHaveLength(fail?1:0);expect(success.mock.calls).toHaveLength(fail?0:1);expect(writes().every(r=>r.host==='actions-a.invalid')).toBe(true);});
test('disconnect outer epoch remount keeps B editor and finishes original A sequence',async()=>{await setup('custom-a');await startDisconnect();await act(async()=>{switchTo('b');useUIStore.setState({settingsProvidersOpenRequested:'custom-b'});render('epoch1');await pause(65);});await customEdit();await type(nameInput(),'DUMMY_B_CUSTOM');const node=nameInput();records.length=0;await act(async()=>{gate.finish();await pause(75);});snapshot('disconnect-remounted-B',{newNodeRetained:nameInput()===node});expect(nameInput()===node).toBe(true);expect(nameInput()?.value).toBe('DUMMY_B_CUSTOM');expect(writes().map(r=>({host:r.host,path:r.path}))).toEqual([{host:'actions-a.invalid',path:'/api/credential/DUMMY_custom-a_2'}]);});
for(const kind of ['activate','rename','remove'] as const){
 test(`account ${kind} positive uses native menu and exact SDK request`,async()=>{await setup();await accountAction(kind);await act(async()=>pause(65));snapshot('account-'+kind+'-current');expect(writes()).toHaveLength(1);expect(writes()[0]?.host).toBe('actions-a.invalid');expect(writes()[0]?.path).toBe('/api/credential/DUMMY_openai_2'+(kind==='activate'?'/activate':''));expect(writes()[0]?.method).toBe(kind==='activate'?'POST':kind==='rename'?'PATCH':'DELETE');if(kind==='rename')expect(JSON.parse(writes()[0]!.body)).toEqual({label:'DUMMY_RENAMED'});expect(error.mock.calls).toHaveLength(0);});
 test(`account ${kind} late result preserves newer Google draft with valid catalog reread`,async()=>{await setup();heldPath='/api/credential/DUMMY_openai_2'+(kind==='activate'?'/activate':'');await accountAction(kind);await act(async()=>until(()=>writes().length===1));const node=await googleDraft();records.length=0;await act(async()=>{gate.finish();await pause(80);});snapshot('account-'+kind+'-late',{newNodeRetained:keyInput()===node});expect(keyInput()===node).toBe(true);expect(keyInput()?.value).toBe('DUMMY_NEW_KEY');expect(resourceInput()?.value).toBe('DUMMY_NEW_RESOURCE');expect(writes()).toEqual([]);expect(records.some(r=>r.path==='/api/integration'&&r.host==='actions-a.invalid')).toBe(true);});
}

const configWrites=()=>records.filter(r=>r.path==='/api/provider'&&r.method==='PUT');
const visibleSubmit=()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(n=>n.type==='submit');
async function beginSave(){configHeld=true;await type(keyInput(),'DUMMY_COMPOSITION_B_KEY');await act(async()=>{const submit=visibleSubmit();if(!submit)throw Error('Missing custom submit');submit.click();await until(()=>configWrites().length===1);});}
for(const fail of [false,true])test(`native old A disconnect ${fail?'failure':'success'} preserves pending B editor and busy controls until B save settles`,async()=>{
 await setup('custom-a');await startDisconnect(fail);const node=await customDraft();
 expect(visibleSubmit()?.disabled).toBe(false);
 await beginSave();const submit=visibleSubmit();
 expect(submit?.disabled).toBe(true);expect(button('Disconnect',true).disabled).toBe(true);expect(nameInput()===node).toBe(true);
 const before=configWrites()[0];expect(before?.host).toBe('actions-a.invalid');expect(JSON.parse(before!.body).providerID).toBe('custom-b');
 await act(async()=>{gate.finish();await pause(80);});
 snapshot('composition-old-disconnect-new-save',{newNodeRetained:nameInput()===node,newSubmitStillBusy:submit?.isConnected&&submit.disabled,configDispatches:configWrites().length});
 expect(nameInput()===node).toBe(true);expect(nameInput()?.value).toBe('DUMMY_NEW_CUSTOM_NAME');expect(submit?.isConnected).toBe(true);expect(visibleSubmit()===submit).toBe(true);expect(submit?.disabled).toBe(true);expect(button('Disconnect',true).disabled).toBe(true);await act(async()=>submit?.click());expect(configWrites()).toHaveLength(1);
 expect(writes().filter(r=>r.path.includes('/credential/')).map(r=>({host:r.host,path:r.path}))).toEqual(fail?[{host:'actions-a.invalid',path:'/api/credential/DUMMY_custom-a_1'}]:[{host:'actions-a.invalid',path:'/api/credential/DUMMY_custom-a_1'},{host:'actions-a.invalid',path:'/api/credential/DUMMY_custom-a_2'}]);
 configGate.finish();await act(async()=>pause(35));expect(configWrites()).toHaveLength(1);expect(nameInput()===node).toBe(true);expect(nameInput()?.value).toBe('DUMMY_NEW_CUSTOM_NAME');expect(visibleSubmit()?.disabled).toBe(false);expect(button('Disconnect',true).disabled).toBe(false);
});
test('native same-visit save disables Disconnect and rejects reverse composition',async()=>{
 await setup('custom-a');await customEdit();await type(nameInput(),'DUMMY_SAME_VISIT_NAME');await beginSave();
 const disconnect=button('Disconnect',true);expect(disconnect.disabled).toBe(true);expect(visibleSubmit()?.disabled).toBe(true);
 await act(async()=>disconnect.click());
 snapshot('composition-reverse-disabled',{configDispatches:configWrites().length,disconnectDisabled:disconnect.disabled});
 expect(writes().filter(r=>r.path.includes('/credential/'))).toEqual([]);expect(configWrites()).toHaveLength(1);
 configGate.finish();await act(async()=>pause(35));expect(nameInput()?.value).toBe('DUMMY_SAME_VISIT_NAME');expect(visibleSubmit()?.disabled).toBe(false);configHeld=false;await act(async()=>{visibleSubmit()?.click();await until(()=>success.mock.calls.length===1);});expect(configWrites()).toHaveLength(2);expect(writes().filter(r=>r.path.includes('/credential/'))).toEqual([]);
});

test('disable outer A-B-A remount retires the original A catalog follow-up',async()=>{
 await setup();await startDisable();
 await act(async()=>{switchTo('b');useUIStore.setState({settingsProvidersOpenRequested:'google'});render('epoch1');await pause(60);});
 await act(async()=>{switchTo('a');useUIStore.setState({settingsProvidersOpenRequested:'google'});render('epoch2');await pause(60);});
 await type(keyInput(),'DUMMY_RETURNED_A_KEY');const node=keyInput();records.length=0;
 await act(async()=>{gate.finish();await pause(80);});
 snapshot('disable-remounted-A-B-A',{newNodeRetained:keyInput()===node});
 expect(keyInput()===node).toBe(true);expect(keyInput()?.value).toBe('DUMMY_RETURNED_A_KEY');expect(writes()).toEqual([]);
 expect(records.filter(r=>['/api/provider','/api/model','/api/model/default'].includes(r.path))).toEqual([]);
});
test('disconnect preserves a new editor visit to the same custom provider ID',async()=>{
 await setup('custom-a');await startDisconnect();await navigate('Custom A');await customEdit();
 await type(nameInput(),'DUMMY_RETURNED_CUSTOM_A');const node=nameInput();
 await act(async()=>{gate.finish();await pause(80);});
 snapshot('disconnect-returned-custom-a',{newNodeRetained:nameInput()===node});
 expect(nameInput()===node).toBe(true);expect(nameInput()?.value).toBe('DUMMY_RETURNED_CUSTOM_A');
 expect(writes().map(r=>r.path)).toEqual(['/api/credential/DUMMY_custom-a_1','/api/credential/DUMMY_custom-a_2']);
});
test('disconnect same-owner failure allows a native retry and success cleanup',async()=>{
 await setup('custom-a');await startDisconnect(true);await act(async()=>{gate.finish();await pause(65);});
 expect(error.mock.calls).toHaveLength(1);expect(nameInput()).toBeNull();
 expect(writes().map(r=>r.path)).toEqual(['/api/credential/DUMMY_custom-a_1']);
 failed=false;heldPath='';await customEdit();await act(async()=>{button('Disconnect',true).click();await pause(65);});
 snapshot('disconnect-same-owner-retry');expect(nameInput()).toBeNull();expect(success.mock.calls).toHaveLength(1);
 expect(writes().map(r=>r.path)).toEqual(['/api/credential/DUMMY_custom-a_1','/api/credential/DUMMY_custom-a_1','/api/credential/DUMMY_custom-a_2']);
});
