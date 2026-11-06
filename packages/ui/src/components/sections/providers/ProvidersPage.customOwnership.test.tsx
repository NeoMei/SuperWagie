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
const deferred = <T,>() => { let finish: (v:T)=>void = () => { throw new Error('Uninitialized deferred'); }; const promise = new Promise<T>(r=>finish=r); return { promise, finish }; };
const records: Array<{host:string; url:string; directory:string|null; path:string; method:string; body:string}> = [];
let hold: 'response'|'body'|'key'|'settings'|'none' = 'none';
let gate = deferred<void>();
let retry = false;
let keys = 0;
let failConfig = false;
let failKey = false;
let savedProviderVisible = false;
let sourceMode: 'ready' | 'held' | 'failed' = 'ready';
let sourceGate = deferred<void>();
const savedProvider: Provider = {
  id: 'dummy-provider', name: 'Live provider', activation: 'enabled',
  package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: 'https://live.invalid/v1' },
};
const savedModel: Model = {
  id: 'dummy-model', modelID: 'dummy-model', providerID: 'dummy-provider', name: 'Live model',
  capabilities: { input: ['text'], output: ['text'], tools: true }, variants: [],
  time: { released: 0 }, cost: [], status: 'active', enabled: true,
  limit: { context: 8000, output: 1000 },
};
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
 const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://localhost'), init);
 const url = new URL(request.url); const method = init?.method ?? request.method;
 const raw = init?.body ? String(init.body) : method !== 'GET' ? await request.clone().text() : '';
 const body = raw;
 records.push({host:url.host,url:request.url,directory:request.headers.get("x-opencode-directory"),path:url.pathname,method,body});
 if(url.pathname === '/api/provider' && method === 'PUT') {
   if (hold === 'response') await gate.promise;
   if (failConfig) return Response.json({error:'Dummy config failure'},{status:500});
   const response = Response.json({success:true});
   if (hold === 'body') Object.defineProperty(response,'json',{value:async()=>{await gate.promise;return {success:true};}});
   return response;
 }
 if(url.pathname.includes('/connect/key')) {
   keys++;
   if(hold==='key')await gate.promise;
   if(failKey)return Response.json({name:'ValidationError',data:{message:'Dummy key failure'}},{status:400});
   if(retry && keys === 1) return Response.json({name:'NotFoundError', data:{message:'Integration not found'}},{status:404});
   return new Response(null,{status:204});
 }
 if(url.pathname.endsWith('/integration')) return Response.json({location:{directory:'/fixture'},data:[]});
 if(url.pathname === '/api/provider') return Response.json({location:{directory:'/fixture'},data:savedProviderVisible?[savedProvider]:[]});
 if(url.pathname === '/api/model') return Response.json({location:{directory:'/fixture'},data:savedProviderVisible?[savedModel]:[]});
 if(url.pathname.endsWith('/source')) {
   if(url.host === 'runtime-b.invalid' && sourceMode === 'held')await sourceGate.promise;
   if(url.host === 'runtime-b.invalid' && sourceMode === 'failed')return Response.json({error:'Dummy source failure'},{status:500});
   const name = url.host === 'runtime-b.invalid' ? 'B stored provider' : 'A stored provider';
   return Response.json({sources:{user:{exists:true},project:{exists:true},custom:{exists:true}},config:{
     package:'aisdk:@ai-sdk/openai-compatible',name,settings:{baseURL:'https://stored.invalid/v1'},
     models:{'dummy-model':{modelID:'dummy-model',name:'Stored model'}}
   }});
 }
 if(url.pathname.includes('disabled')) return Response.json({providers:[]});
 if(url.pathname.includes('websearch')) return Response.json({data:[]});
 if(url.pathname.includes('/config/settings')) { if(hold==='settings'&&method==='PUT')await gate.promise;return Response.json({projects:[{id:'fixture',path:'/fixture'}],activeProjectId:'fixture',customProviderIcons:{}});}
 if(url.pathname.endsWith('/path')) return Response.json({home:'/fixture',directory:'/fixture'});
 return Response.json({data:[], success:true});
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
let root: ReturnType<typeof createRoot>|null = null;
const switchTo = (id:string) => {switchRuntimeEndpoint({apiBaseUrl:`http://runtime-${id}.invalid`,runtimeKey:`provider-${id}`}); opencodeClient.reconnectToRuntimeBaseUrl();opencodeClient.setDirectory('/fixture');};
const pause = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (ready: () => boolean) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (ready()) return;
    await pause(10);
  }
  throw new Error('Expected provider operation did not finish');
};
const submitForm = (form = document.querySelector('form')) => {
  if (!form) throw new Error('Missing custom-provider form');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};
const button = (text:string) => {const x=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim().startsWith(text));if(!x)throw Error('Missing '+text+' in '+document.body.textContent?.slice(0,600));return x;};
async function field(label: string, value: string) {
  const node = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!node) throw new Error(`Missing field ${label}`);
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Missing native input setter');
  await act(async () => {
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function setup(edit = false) {
 hold='none';gate=deferred<void>();retry=false;keys=0;failConfig=false;failKey=false;
 savedProviderVisible=edit;sourceMode='ready';sourceGate=deferred<void>();
 switchTo('a');
 useProjectsStore.setState({projects:[{id:'fixture',path:'/fixture'}],activeProjectId:'fixture'});
 useUIStore.setState({settingsProjectPath:'/fixture',settingsProvidersConnectRequested:!edit,settingsProvidersOpenRequested:edit?'dummy-provider':null,customProviderIcons:{}});
 useI18nStore.getState().setLocale('en');
 const box=document.createElement('div');document.body.replaceChildren(box);root=createRoot(box);
 await act(async()=>root?.render(createElement(I18nProvider,null,createElement(ThemeSystemProvider,null,createElement(ProvidersPage)))));
 if (edit) {
   await act(async () => button('Edit').click());
   success.mockClear();error.mockClear();records.length=0;
   const form=document.querySelector('form');
   return () => submitForm(form);
 }
 await act(async()=>button('Custom provider').click());
 await field('Provider ID','dummy-provider'); await field('Display name','Dummy provider');
 await field('Base URL','https://dummy-provider.invalid/v1');await field('API key','DUMMY_CA19_A_SENTINEL');
 await field('Model ID', 'dummy-model');await field('Model name','Dummy model');
 success.mockClear();error.mockClear();records.length=0;
 const form = document.querySelector('form');
 return () => submitForm(form);
}
afterEach(async()=>{await act(async()=>root?.unmount());root=null;gate.finish();sourceGate.finish();});
afterAll(()=>{fetchSpy.mockRestore();success.mockRestore();error.mockRestore();browser.close();});
for(const phase of ['response','body'] as const)for(const transition of ['same','A-B','A-B-A'])test(`${phase} ${transition}`,async()=>{
 const submit=await setup();hold=phase;
 await act(async()=>{submit();await until(()=>records.some(x=>x.method==='PUT'&&x.path==='/api/provider'));});
 expect(records.filter(x=>x.path==='/api/provider'&&x.method==='PUT')).toHaveLength(1);
 await act(async()=>{if(transition!=='same')switchTo('b');if(transition==='A-B-A')switchTo('a');gate.finish();await pause();if(transition==='same')await until(()=>success.mock.calls.length===1);});
 const writes=records.filter(x=>x.method!=='GET'&&x.path!=='/auth/url-token');console.log(JSON.stringify({phase,transition,writes,success:success.mock.calls.length,error:error.mock.calls.length}));
 const keyWrites=writes.filter(x=>x.path.includes('/connect/key'));
 expect(keyWrites).toHaveLength(transition==='same'?1:0);
 if(transition==='same'){expect(keyWrites[0].host).toBe('runtime-a.invalid');expect(success.mock.calls).toHaveLength(1);}
 else expect(success.mock.calls).toHaveLength(0);
});
test('old rendered callback is retired before first dispatch',async()=>{
 const submit=await setup();await act(async()=>{switchTo('b');submit();await pause();});
 console.log(JSON.stringify({phase:'old-render',writes:records.filter(x=>x.method!=='GET'&&x.path!=='/auth/url-token')}));
 expect(records.filter(x=>x.method!=='GET'&&x.path!=='/auth/url-token')).toEqual([]);
});
test('same owner config-first delayed-registration retry control',async()=>{
 const submit=await setup();retry=true;await act(async()=>{submit();await until(()=>success.mock.calls.length===1);});
 console.log(JSON.stringify({phase:'retry-control',writes:records.filter(x=>x.method!=='GET'&&x.path!=='/auth/url-token')}));
 expect(keys).toBe(2);expect(success.mock.calls).toHaveLength(1);
});
test('runtime switch during retry wait retires later dispatch',async()=>{
 const submit=await setup();retry=true;
 await act(async()=>{submit();await until(()=>keys===1);});
 expect(keys).toBe(1);
 await act(async()=>{switchTo('b');await pause(300);});
 console.log(JSON.stringify({phase:'retry-switch',writes:records.filter(x=>x.method!=='GET'&&x.path!=='/auth/url-token')}));
 expect(keys).toBe(1);expect(success.mock.calls).toHaveLength(0);
});
test('current B render cannot submit retained A fields',async()=>{
 await setup();
 await act(async()=>{switchTo('b');root?.render(createElement(I18nProvider,null,createElement(ThemeSystemProvider,null,createElement(ProvidersPage))));});
 const form=document.querySelector('form');
 await act(async()=>{if(form)submitForm(form);await pause();});
 console.log(JSON.stringify({phase:'current-B-render',writes:records.filter(x=>x.method!=='GET'&&x.path!=='/auth/url-token')}));
 expect(records.filter(x=>x.path.includes('/connect/key'))).toEqual([]);
});
test('unmount while config pending retires key and result publication',async()=>{
 const submit=await setup();hold='body';
 await act(async()=>{submit();await until(()=>records.some(x=>x.method==='PUT'&&x.path==='/api/provider'));});
 await act(async()=>{root?.unmount();root=null;gate.finish();await pause();});
 console.log(JSON.stringify({phase:'unmount',writes:records.filter(x=>x.method!=='GET'&&x.path!=='/auth/url-token')}));
 expect(keys).toBe(0);expect(success.mock.calls).toHaveLength(0);
});
test('Settings directory round trip while config pending retires key',async()=>{
 const submit=await setup();hold='response';
 await act(async()=>{submit();await until(()=>records.some(x=>x.method==='PUT'&&x.path==='/api/provider'));});
 await act(async()=>{
  useProjectsStore.setState({projects:[{id:'fixture',path:'/fixture'},{id:'other',path:'/other'}],activeProjectId:'fixture'});
  useUIStore.setState({settingsProjectPath:'/other'});useUIStore.setState({settingsProjectPath:'/fixture'});
  gate.finish();await pause();
 });
 console.log(JSON.stringify({phase:'directory-roundtrip',writes:records.filter(x=>x.method!=='GET'&&x.path!=='/auth/url-token')}));
 expect(keys).toBe(0);expect(success.mock.calls).toHaveLength(0);
});

for (const phase of ['key', 'settings'] as const) test(`${phase} response cannot publish after a runtime switch`, async () => {
  const submit = await setup();
  hold = phase;
  await act(async () => {
    submit();
    await until(() => phase === 'key' ? keys === 1 : records.some((r) => r.path === '/api/config/settings' && r.method === 'PUT'));
  });
  await act(async () => {
    switchTo('b');
    useUIStore.setState({ customProviderIcons: { 'dummy-provider': 'cloud' } });
    gate.finish();
    await pause(40);
  });
  expect(success.mock.calls).toHaveLength(0);
  expect(error.mock.calls).toHaveLength(0);
  expect(records.filter((r) => r.host === 'runtime-b.invalid' && r.method !== 'GET' && r.path !== '/auth/url-token')).toEqual([]);
  expect(useUIStore.getState().customProviderIcons).toEqual({ 'dummy-provider': 'cloud' });
});

for (const failedPhase of ['config', 'key'] as const) test(`${failedPhase} failure keeps dirty fields available for retry`, async () => {
  await setup();
  failConfig = failedPhase === 'config';
  failKey = failedPhase === 'key';
  const consoleError = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => { submitForm(); await until(() => error.mock.calls.length === 1); });
    expect(document.querySelector<HTMLInputElement>('input[aria-label="API key"]')?.value).toBe('DUMMY_CA19_A_SENTINEL');
    expect(button('Save provider').disabled).toBe(false);
    if (failedPhase === 'config') expect(keys).toBe(0);
    else expect(keys).toBe(1);
    failConfig = false; failKey = false;
    await act(async () => { submitForm(); await until(() => success.mock.calls.length === 1); });
    expect(records.filter((r) => r.path === '/api/provider' && r.method === 'PUT')).toHaveLength(2);
    expect(keys).toBe(failedPhase === 'config' ? 1 : 2);
  } finally { consoleError.mockRestore(); }
});

test('retired A key completion preserves B fields and its new busy operation', async () => {
  const submit = await setup(); hold = 'key';
  const firstGate = gate;
  await act(async () => { submit(); await until(() => keys === 1); });
  await act(async () => switchTo('b'));
  await field('Provider ID', 'dummy-provider'); await field('Display name', 'B provider');
  await field('Base URL', 'https://dummy-b.invalid/v1'); await field('API key', 'DUMMY_CA19_B_SENTINEL');
  await field('Model ID', 'b-model'); await field('Model name', 'B model');
  hold = 'response'; gate = deferred<void>();
  await act(async () => { submitForm(); await until(() => records.some((r) => r.host === 'runtime-b.invalid' && r.path === '/api/provider' && r.method === 'PUT')); });
  await act(async () => { firstGate.finish(); await pause(40); });
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(document.querySelector<HTMLInputElement>('input[aria-label="API key"]')?.value).toBe('DUMMY_CA19_B_SENTINEL');
  expect(success.mock.calls).toHaveLength(0);
  await act(async () => { gate.finish(); await until(() => success.mock.calls.length === 1); });
  const currentKeys = records.filter((r) => r.path.includes('/connect/key') && r.host === 'runtime-b.invalid');
  expect(currentKeys).toHaveLength(1);
  expect(JSON.parse(currentKeys[0].body)).toEqual({ key: 'DUMMY_CA19_B_SENTINEL' });
});

test('edit hydrates stored fields and writes the winning custom config layer', async () => {
  const submit = await setup(true);
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Display name"]')?.value).toBe('A stored provider');
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Base URL"]')?.value).toBe('https://stored.invalid/v1');
  await field('Display name', 'Edited provider'); await field('API key', 'DUMMY_CA19_A_SENTINEL');
  await act(async () => { submit(); await until(() => success.mock.calls.length === 1); });
  const configWrite = records.find((r) => r.path === '/api/provider' && r.method === 'PUT');
  expect(configWrite?.host).toBe('runtime-a.invalid');
  if (!configWrite) throw new Error('Missing provider config write');
  expect(JSON.parse(configWrite.body)).toMatchObject({ providerID: 'dummy-provider', scope: 'custom', config: { name: 'Edited provider' } });
});

for (const hydration of ['held', 'failed'] as const) test(`new-owner ${hydration} edit source cannot authorize A fields`, async () => {
  await setup(true);
  await field('API key', 'DUMMY_CA19_A_SENTINEL');
  sourceMode = hydration;
  const consoleError = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => { switchTo('b'); await pause(); });
    expect(document.querySelector('form')).toBeNull();
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Edit')).toBe(false);
    expect(records.filter((r) => r.host === 'runtime-b.invalid' && r.method !== 'GET' && r.path !== '/auth/url-token')).toEqual([]);
    if (hydration === 'held') {
      await act(async () => { sourceGate.finish(); await pause(); });
      await act(async () => button('Edit').click());
      expect(document.querySelector<HTMLInputElement>('input[aria-label="Display name"]')?.value).toBe('B stored provider');
      expect(document.querySelector<HTMLInputElement>('input[aria-label="API key"]')?.value).toBe('');
    }
  } finally { consoleError.mockRestore(); }
});
