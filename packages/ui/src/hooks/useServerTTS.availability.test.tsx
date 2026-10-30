import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
let available = false;
let configuredBinding = false;
let probes = 0;
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith('/api/fs/home')) return Response.json({ home: '/fixture' });
  if (url.endsWith('/api/location')) return Response.json({ directory: '/fixture', project: { directory: '/fixture' } });
  if (url.endsWith('/api/tts/status')) { probes += 1; return Response.json({ available, configuredBinding }); }
  return Response.json({});
});
const { createRoot } = await import('react-dom/client');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useServerTTS, invalidateServerTTSStatus } = await import('./useServerTTS');

let host: HTMLDivElement;
let root: Root;
const initialState = useConfigStore.getState();
beforeEach(() => {
  available = false; configuredBinding = false; probes = 0; invalidateServerTTSStatus();
  useConfigStore.setState({ openaiCompatibleUrl: '', voiceApiKeys: { openai: false, openaiCompatible: false, stt: false }, refreshVoiceApiKeys: async () => {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  useConfigStore.setState({ openaiCompatibleUrl: initialState.openaiCompatibleUrl, voiceApiKeys: initialState.voiceApiKeys, refreshVoiceApiKeys: initialState.refreshVoiceApiKeys });
});
afterAll(async () => {
  fetchFixture.mockRestore(); await browser.happyDOM.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function Probe() {
  const tts = useServerTTS({ availabilityMode: 'openai-compatible' });
  return <>
    <output>{String(tts.isAvailable)}</output>
    <output data-testid="configured">{String(tts.isConfiguredBinding)}</output>
    <button onClick={() => void tts.checkAvailability()}>Check</button>
  </>;
}

test('a shared TTS binding is available with no legacy compatible URL or key', async () => {
  available = true; configuredBinding = true;
  await act(async () => root.render(<Probe />));
  expect(probes).toBe(1);
  expect(host.querySelector('output')?.textContent).toBe('true');
  expect(host.querySelector('[data-testid="configured"]')?.textContent).toBe('true');
  await act(async () => host.querySelector('button')?.click());
  expect(host.querySelector('output')?.textContent).toBe('true');
});

test('saving a binding invalidates a cached unavailable status and refreshes mounted consumers', async () => {
  await act(async () => root.render(<Probe />));
  expect(host.querySelector('output')?.textContent).toBe('false');
  available = true;
  await act(async () => host.querySelector('button')?.click());
  expect(probes).toBe(1);
  expect(host.querySelector('output')?.textContent).toBe('false');
  await act(async () => invalidateServerTTSStatus());
  expect(probes).toBe(2);
  expect(host.querySelector('output')?.textContent).toBe('true');
});

test('an unbound local endpoint stays available when the server reports no managed binding', async () => {
  useConfigStore.setState({ openaiCompatibleUrl: 'http://127.0.0.1:8880/v1' });
  await act(async () => root.render(<Probe />));
  expect(host.querySelector('[data-testid="configured"]')?.textContent).toBe('false');
  expect(host.querySelector('output')?.textContent).toBe('true');
  await act(async () => host.querySelector('button')?.click());
  expect(host.querySelector('output')?.textContent).toBe('true');
});
