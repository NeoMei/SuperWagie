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
const records: Array<{host:string; path:string; method:string; directory:string|null; body:string}> = [];
let held = false;
let fail = false;
let gate = deferred();
let catalogVersion = 0;
let existing = false;
let credentialEcho = false;
let removeOpenAI = false;
let searchOpenAI = false;
let holdEchoIntegrations = false;
let holdEchoProviders = false;
let echoIntegrationsGate = deferred();
let echoProvidersGate = deferred();
const provider = (id: string): Provider => ({ id, name: id === 'openai' ? 'OpenAI' : 'Google', activation: 'enabled', package: 'aisdk:@ai-sdk/openai-compatible', settings: {} });
const model = (id: string): Model => ({ id: 'dummy-model', modelID: 'dummy-model', providerID: id, name: 'Dummy model', capabilities: { input: ['text'], output: ['text'], tools: true }, variants: [], time: { released: 0 }, cost: [], status: 'active', enabled: true, limit: { context: 8000, output: 1000 } });
const integration = (id:string,host:string) => ({id, name:id==='openai'?'OpenAI':'Google',connections:credentialEcho && id === 'openai' ? [{type:'credential',id:'DUMMY_ECHO_CREDENTIAL',label:'Dummy key',method:'key'}] : [],metadata:searchOpenAI && id === 'openai' ? {websearch:true} : {},methods:[{type:'key',label:'API key',form:[{key:'resource',title:`Resource ${host.includes('-b.')?'B':'A'} ${catalogVersion}`,type:'string',required:true}]}]});
const fetchSpy = spyOn(globalThis,'fetch').mockImplementation(async(input,init) => {
 const req = input instanceof Request ? input : new Request(new URL(String(input),'http://localhost'),init);
 const url = new URL(req.url); const method = init?.method ?? req.method;
 const body = init?.body ? String(init.body) : method==='GET'?'':await req.clone().text();
 records.push({host:url.host,path:url.pathname,method,directory:req.headers.get('x-opencode-directory'),body});
 if(url.pathname.includes('/connect/key')) {
  if(held)await gate.promise;
  return fail ? Response.json({name:'ValidationError',data:{message:'Dummy rejection'}},{status:400}) : new Response(null,{status:204});
 }
 if(url.pathname.endsWith('/integration')) { if(credentialEcho && holdEchoIntegrations)await echoIntegrationsGate.promise; return Response.json({location:{directory:'/fixture'},data:removeOpenAI ? [integration('google',url.host)] : [integration('openai',url.host),integration('google',url.host)]}); }
 if(url.pathname==='/api/provider') { if(credentialEcho && holdEchoProviders)await echoProvidersGate.promise; return Response.json({location:{directory:'/fixture'},data:existing ? [provider('openai'),provider('google')] : credentialEcho ? [provider('openai')] : []}); }
 if(url.pathname==='/api/model') return Response.json({location:{directory:'/fixture'},data:existing ? [model('openai'),model('google')] : credentialEcho ? [model('openai')] : []});
 if(url.pathname.endsWith('/source')) return Response.json({sources:{user:{exists:false},project:{exists:false},custom:{exists:false}}});
 if(url.pathname.includes('disabled'))return Response.json({providers:[]});
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
const { notifyCredentialChanged } = await import('@/lib/opencode/integration-catalog');
const { translateWireEvent } = await import('@/lib/opencode/events');
const { ChildStoreManager } = await import('@/sync/child-store');
const { createEventRoutingIndex, handleEvent } = await import('@/sync/sync-context');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { ProvidersPage } = await import('@/components/sections/providers/ProvidersPage');
const { toast } = await import('@/components/ui');
const success = spyOn(toast,'success').mockImplementation(()=> 'success');
const error = spyOn(toast,'error').mockImplementation(()=> 'error');
const consoleError = spyOn(console,'error').mockImplementation(()=>{});
let root: ReturnType<typeof createRoot>|null = null;
const pause=(ms=15)=>new Promise(r=>setTimeout(r,ms));
const until=async(ready:()=>boolean)=>{for(let n=0;n<70;n++){if(ready())return;await pause(10);}throw Error('Probe condition timeout: '+document.body.textContent?.slice(0,600));};
const switchTo=(id:string)=>{switchRuntimeEndpoint({apiBaseUrl:`http://runtime-${id}.invalid`,runtimeKey:`api-probe-${id}`});opencodeClient.reconnectToRuntimeBaseUrl();opencodeClient.setDirectory('/fixture');};
const render=(key?:string)=>{if(!root)throw Error('Missing React root');root.render(createElement(I18nProvider,null,createElement(ThemeSystemProvider,null,createElement(ProvidersPage,{key}))));};
const button=(text:string)=>{const found=[...document.querySelectorAll<HTMLButtonElement>('button')].find(n=>n.textContent?.trim().includes(text)||n.getAttribute('aria-label')?.includes(text));if(!found)throw Error('Missing '+text+' in '+document.body.textContent?.slice(0,900)+' BUTTONS '+[...document.querySelectorAll('button')].map(n=>n.outerHTML.slice(0,350)).join(' | '));return found;};
const keyInput=()=>document.querySelector<HTMLInputElement>('input[type="password"]');
const resourceInput=()=>document.querySelector<HTMLInputElement>('input[aria-label^="Resource"]');
async function type(node:HTMLInputElement|null,value:string){if(!node)throw Error('Missing input');const setter=Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype,'value')?.set;if(!setter)throw Error('Missing native input setter');await act(async()=>{setter.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});}
async function setup(mode: 'add' | 'existing' = 'add', key?:string){
 existing = mode === 'existing';
 held=false;fail=false;gate=deferred();catalogVersion=0;credentialEcho=false;removeOpenAI=false;searchOpenAI=false;holdEchoIntegrations=false;holdEchoProviders=false;echoIntegrationsGate=deferred();echoProvidersGate=deferred();switchTo('a');
 useProjectsStore.setState({projects:[{id:'fixture',path:'/fixture'}],activeProjectId:'fixture'});
 useUIStore.setState({settingsProjectPath:'/fixture',settingsProvidersConnectRequested:!existing,settingsProvidersOpenRequested:existing?'openai':null});
 useI18nStore.getState().setLocale('en');
 const box=document.createElement('div');document.body.replaceChildren(box);root=createRoot(box);
 await act(async()=>{render(key);await pause(40);});
 if (!existing) await act(async()=>button('OpenAI').click());
 await act(async()=>until(()=>keyInput()!==null));
 await type(keyInput(),'DUMMY_API_PROBE_A_KEY');await type(resourceInput(),'DUMMY_API_PROBE_A_RESOURCE');
 success.mockClear();error.mockClear();records.length=0;
}
const writes=()=>records.filter(r=>r.path.includes('/connect/key'));
const firstWrite=()=>{const request=writes()[0];if(!request)throw Error('Missing key request');return request;};
const snapshot=(name:string,extra={})=>console.log(JSON.stringify({case:name,key:keyInput()?.value??null,resource:resourceInput()?.value??null,resourceLabel:resourceInput()?.getAttribute('aria-label')??null,writes:writes(),success:success.mock.calls.length,error:error.mock.calls.length,reads:records.filter(r=>r.method==='GET').map(r=>({host:r.host,path:r.path})),text:document.body.textContent?.slice(0,550),...extra}));
afterEach(async()=>{gate.finish();echoIntegrationsGate.finish();echoProvidersGate.finish();await act(async()=>{root?.unmount();root=null;await pause();});});
afterAll(()=>{fetchSpy.mockRestore();success.mockRestore();error.mockRestore();consoleError.mockRestore();browser.close();});


const modes = ['add', 'existing'] as const;
async function startHeld(failed = false) {
 held = true; fail = failed;
 await act(async () => { button('Save key').click(); await until(() => writes().length === 1); });
 expect(writes()[0]?.host).toBe('runtime-a.invalid');
 expect(writes()[0]?.directory).toBe('%2Ffixture');
 expect(JSON.parse(firstWrite().body)).toEqual({key:'DUMMY_API_PROBE_A_KEY',answer:{resource:'DUMMY_API_PROBE_A_RESOURCE'}});
}
async function navigateTo(id: 'OpenAI' | 'Google') {
 await act(async () => button('All providers').click());
 await act(async () => button(id).click());
}
async function newDraft() {
 await type(keyInput(),'DUMMY_API_PROBE_NEW_KEY');
 await type(resourceInput(),'DUMMY_API_PROBE_NEW_RESOURCE');
 const node = keyInput();
 if (!node) throw new Error('Missing newer key field');
 records.length = 0;
 return node;
}
function expectDraft(node: HTMLInputElement) {
 expect(keyInput() === node).toBe(true);
 expect(keyInput()?.value).toBe('DUMMY_API_PROBE_NEW_KEY');
 expect(resourceInput()?.value).toBe('DUMMY_API_PROBE_NEW_RESOURCE');
 expect(writes()).toEqual([]);
 expect(records.some(r => r.path === '/api/provider/openai/source')).toBe(false);
 expect(records.some(r => r.path === '/api/integration')).toBe(false);
}

for (const mode of modes) test(`${mode} current-owner key success refreshes its provider`, async () => {
 await setup(mode);
 await act(async () => { button('Save key').click(); await until(() => success.mock.calls.length === 1); await pause(40); });
 expect(writes()).toHaveLength(1);
 expect(JSON.parse(firstWrite().body)).toEqual({key:'DUMMY_API_PROBE_A_KEY',answer:{resource:'DUMMY_API_PROBE_A_RESOURCE'}});
 expect(writes()[0]?.host).toBe('runtime-a.invalid');
 expect(records.some(r => r.path === '/api/provider/openai/source')).toBe(true);
 expect(records.some(r => r.path === '/api/integration')).toBe(true);
 expect(error.mock.calls).toHaveLength(0);
 snapshot(`${mode}-current-owner-success`);
});

for (const mode of modes) test(`${mode} current-owner failure preserves fields and allows retry`, async () => {
 await setup(mode); fail = true; const node = keyInput();
 await act(async () => { button('Save key').click(); await until(() => error.mock.calls.length === 1); });
 expect(keyInput() === node).toBe(true);
 expect(keyInput()?.value).toBe('DUMMY_API_PROBE_A_KEY');
 expect(resourceInput()?.value).toBe('DUMMY_API_PROBE_A_RESOURCE');
 expect(button('Save key').disabled).toBe(false);
 fail = false;
 await act(async () => { button('Save key').click(); await until(() => success.mock.calls.length === 1); });
 expect(writes()).toHaveLength(2);
 snapshot(`${mode}-current-owner-failure-retry`);
});

test('same-visit catalog refresh preserves dirty fields and permits completion', async () => {
 await setup(); const node = keyInput();
 await act(async () => { catalogVersion = 1; notifyCredentialChanged(); await pause(40); });
 expect(keyInput() === node).toBe(true);
 expect(keyInput()?.value).toBe('DUMMY_API_PROBE_A_KEY');
 expect(resourceInput()?.value).toBe('DUMMY_API_PROBE_A_RESOURCE');
 expect(resourceInput()?.getAttribute('aria-label')).toBe('Resource A 1');
 await act(async () => { button('Save key').click(); await until(() => success.mock.calls.length === 1); });
 expect(writes()).toHaveLength(1);
});

for (const mode of modes) for (const failed of [false, true]) test(`${mode} late ${failed?'failure':'success'} preserves newer Google draft`, async () => {
 await setup(mode); await startHeld(failed);
 await navigateTo('Google'); const node = await newDraft();
 await act(async () => { gate.finish(); await pause(50); });
 snapshot(`${mode}-Google-late-${failed?'failure':'success'}`,{newNodeRetained:keyInput()===node});
 expect(success.mock.calls).toHaveLength(failed?0:1);
 expect(error.mock.calls).toHaveLength(failed?1:0);
 expectDraft(node);
});

for (const mode of modes) test(`${mode} late success preserves a new visit to the same provider`, async () => {
 await setup(mode); const oldNode = keyInput(); await startHeld();
 await navigateTo('OpenAI'); const node = await newDraft();
 expect(node !== oldNode).toBe(true);
 await act(async () => { gate.finish(); await pause(50); });
 snapshot(`${mode}-same-provider-revisit`,{newNodeRetained:keyInput()===node});
 expect(success.mock.calls).toHaveLength(1);
 expectDraft(node);
});

for (const mode of modes) test(`${mode} back navigation retires completion before React cleanup`, async () => {
 await setup(mode); await startHeld(); records.length = 0;
 await act(async () => { button('All providers').click(); gate.finish(); await pause(50); });
 snapshot(`${mode}-back-and-completion-same-act`);
 expect(keyInput() === null).toBe(true);
 expect(records.filter(r => r.path === '/api/provider/openai/source')).toHaveLength(mode === 'existing' ? 1 : 0);
 // The existing-provider grid reads sources once for each card on mount.
 // A stale success would also select OpenAI and render its key field again.
 expect(document.body.textContent).toContain(mode === 'existing' ? 'Connect provider' : 'Custom provider');
});

test('outer epoch remount clears batched runtime A-B-A fields', async () => {
 await setup('add','epoch0'); const node = keyInput();
 await act(async () => { switchTo('b'); switchTo('a'); useUIStore.setState({settingsProvidersConnectRequested:true}); render('epoch2'); await pause(45); });
 await act(async () => button('OpenAI').click());
 expect(keyInput() !== node).toBe(true); expect(keyInput()?.value).toBe(''); expect(resourceInput()?.value).toBe('');
 expect(writes()).toEqual([]);
});

for (const failed of [false,true]) test(`held A ${failed?'failure':'success'} preserves remounted B Google draft`, async () => {
 await setup('add','epoch0'); await startHeld(failed);
 await act(async () => { switchTo('b'); useUIStore.setState({settingsProvidersConnectRequested:true}); render('epoch1'); await pause(45); });
 await act(async () => button('Google').click()); const node = await newDraft();
 await act(async () => { gate.finish(); await pause(50); });
 expectDraft(node);
 expect(success.mock.calls).toHaveLength(failed?0:1);
 expect(error.mock.calls).toHaveLength(failed?1:0);
 snapshot(`outer-remount-B-late-${failed?'failure':'success'}`);
});


async function publishCredentialEvent(children: InstanceType<typeof ChildStoreManager>) {
 const events = translateWireEvent({id:'evt_DUMMY_CA21_ECHO',created:1000,type:'credential.updated',data:{integrationID:'google',credentialID:'credential-test'}});
 expect(events).toEqual([{type:'catalog.updated',properties:{kind:'credential'}}]);
 await act(async () => {
  for (const event of events) handleEvent('global',event,children,createEventRoutingIndex(),getRuntimeKey());
  await pause(450);
 });
 await act(async () => { await pause(60); });
}
async function connectedEcho(children: InstanceType<typeof ChildStoreManager>) {
 credentialEcho = true;
 await publishCredentialEvent(children);
 expect(success.mock.calls).toHaveLength(0);
 expect(writes()).toHaveLength(1);
 expect(document.body.textContent).toContain('Connect provider');
 expect(keyInput() === null).toBe(true);
}

for (const order of ['together','provider-first','integration-first'] as const) test(`current key completion selects its provider after ${order} authoritative echo`, async () => {
 const children = new ChildStoreManager();
 try {
  await setup(); await startHeld();
  holdEchoIntegrations = order === 'provider-first'; holdEchoProviders = order === 'integration-first';
  await connectedEcho(children); records.length = 0;
  await act(async () => { gate.finish(); await until(() => success.mock.calls.length === 1); await pause(100); });
  echoIntegrationsGate.finish(); echoProvidersGate.finish();
  await act(async () => { await pause(100); });
  expect(error.mock.calls).toHaveLength(0);
  expect(records.some(r => r.path === '/api/provider/openai/source')).toBe(true);
  expect(records.some(r => r.path === '/api/integration')).toBe(true);
  expect(writes()).toEqual([]);
  expect(document.body.textContent).toContain('OpenAI');
  expect(document.body.textContent).not.toContain('Connect provider');
  snapshot(`connected-echo-${order}-current-completion`);
 } finally { children.disposeAll(); switchTo('b'); }
});

for (const navigation of ['Google','Back','OpenAI revisit'] as const) test(`user ${navigation} after connection echo retires the old completion`, async () => {
 const children = new ChildStoreManager();
 try {
  await setup(); await startHeld(); await connectedEcho(children);
  if (navigation === 'Back' || navigation === 'OpenAI revisit') await act(async () => button('All providers').click());
  let node: HTMLInputElement | null = null;
  if (navigation !== 'Back') {
   await act(async () => button(navigation === 'Google' ? 'Google' : 'OpenAI').click());
   if (navigation === 'OpenAI revisit') await act(async () => button('Add account').click());
   node = await newDraft();
  }
  records.length = 0;
  await act(async () => { gate.finish(); await pause(100); });
  expect(success.mock.calls).toHaveLength(1); expect(error.mock.calls).toHaveLength(0);
  if (node) expectDraft(node);
  else {
   expect(keyInput() === null).toBe(true);
   expect(document.body.textContent).toContain('Connect provider');
   expect(records.some(r => r.path === '/api/provider/openai/source')).toBe(false);
   expect(records.some(r => r.path === '/api/integration')).toBe(false);
  }
  snapshot(`connected-echo-then-${navigation}`);
 } finally { children.disposeAll(); switchTo('b'); }
});

for (const removal of ['missing','websearch'] as const) test(`non-connected ${removal} candidate removal remains retired after it reappears`, async () => {
 const children = new ChildStoreManager();
 try {
  await setup(); await startHeld();
  removeOpenAI = removal === 'missing'; searchOpenAI = removal === 'websearch';
  await publishCredentialEvent(children);
  expect(document.body.textContent).toContain('Connect provider');
  expect(keyInput() === null).toBe(true);
  removeOpenAI = false; searchOpenAI = false;
  await publishCredentialEvent(children);
  records.length = 0;
  await act(async () => { gate.finish(); await pause(100); });
  expect(success.mock.calls).toHaveLength(1); expect(error.mock.calls).toHaveLength(0);
  expect(keyInput() === null).toBe(true);
  expect(document.body.textContent).toContain('Connect provider');
  expect(records.some(r => r.path === '/api/provider/openai/source')).toBe(false);
  expect(records.some(r => r.path === '/api/integration')).toBe(false);
  expect(writes()).toEqual([]);
 } finally { children.disposeAll(); switchTo('b'); }
});


test('Google choice after provider-first echo retires completion while integration read is pending', async () => {
 const children = new ChildStoreManager();
 try {
  await setup(); await startHeld(); holdEchoIntegrations = true; await connectedEcho(children);
  await act(async () => button('Google').click()); const node = await newDraft();
  await act(async () => { gate.finish(); await pause(100); });
  expect(success.mock.calls).toHaveLength(1); expect(error.mock.calls).toHaveLength(0);
  expectDraft(node);
  echoIntegrationsGate.finish();
  await act(async () => { await pause(100); });
  expectDraft(node);
 } finally { children.disposeAll(); switchTo('b'); }
});
