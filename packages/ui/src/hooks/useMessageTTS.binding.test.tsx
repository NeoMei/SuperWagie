import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, HTMLElement: browser.HTMLElement,
  Element: browser.Element, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
// The HTTP fixture ends synthesis before audio decoding; only gesture unlock is used.
let audioResumes = 0;
const audioContexts: FixtureAudioContext[] = [];
class FixtureAudioContext {
  state = 'suspended'; destination = {};
  constructor() { audioContexts.push(this); }
  async resume() { audioResumes += 1; this.state = 'running'; }
  createBuffer() { return {}; }
  createBufferSource() { return { connect() {}, start() {}, stop() {}, buffer: null }; }
}
Object.defineProperty(browser, 'AudioContext', { value: FixtureAudioContext });
let configuredBinding = true;
let delayedStatus: Promise<Response> | null = null;
let failedStatus = false;
let statusReads = 0;
const calls: string[] = [];
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith('/api/tts/status')) {
    statusReads += 1;
    if (failedStatus) return Response.json({ error: 'Unavailable fixture' }, { status: 503 });
    return delayedStatus ?? Response.json({ available: configuredBinding, configuredBinding });
  }
  if (url.endsWith('/api/tts/speak') || url.endsWith('/api/dictation/tts/speak')) {
    calls.push(new URL(url, 'http://localhost/').pathname);
    return Response.json({ error: 'Fixture stops before audio playback' }, { status: 503 });
  }
  if (url.endsWith('/api/fs/home')) return Response.json({ home: '/fixture' });
  if (url.endsWith('/api/location')) return Response.json({ directory: '/fixture', project: { directory: '/fixture' } });
  return Response.json({});
});
const { createRoot } = await import('react-dom/client');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { browserVoiceService } = await import('@/lib/voice/browserVoiceService');
const { invalidateServerTTSStatus } = await import('./useServerTTS');
const { useMessageTTS } = await import('./useMessageTTS');
let browserSpeeches = 0;
const voices = spyOn(browserVoiceService, 'waitForVoices').mockResolvedValue([]);
const resume = spyOn(browserVoiceService, 'resumeAudioContext').mockResolvedValue(undefined);
const speakBrowser = spyOn(browserVoiceService, 'speakText').mockImplementation(async (_text, _language, onEnd) => { browserSpeeches += 1; onEnd?.(); });
const cancel = spyOn(browserVoiceService, 'cancelSpeech').mockImplementation(() => {});
let host: HTMLDivElement;
let root: Root;
const initial = useConfigStore.getState();
beforeEach(() => {
  configuredBinding = true; delayedStatus = null; failedStatus = false; statusReads = 0; calls.length = 0; browserSpeeches = 0;
  audioResumes = 0;
  for (const context of audioContexts) context.state = 'suspended';
  invalidateServerTTSStatus();
  useConfigStore.setState({ showMessageTTSButtons: true, ttsInputMode: 'raw', voiceProvider: 'browser',
    voiceApiKeys: { openai: false, openaiCompatible: false, stt: false }, openaiCompatibleUrl: '', refreshVoiceApiKeys: async () => {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  useConfigStore.setState({ showMessageTTSButtons: initial.showMessageTTSButtons, ttsInputMode: initial.ttsInputMode,
    voiceProvider: initial.voiceProvider, voiceApiKeys: initial.voiceApiKeys,
    openaiCompatibleUrl: initial.openaiCompatibleUrl, refreshVoiceApiKeys: initial.refreshVoiceApiKeys });
});
afterAll(async () => {
  for (const spy of [fetchFixture, voices, resume, speakBrowser, cancel]) spy.mockRestore();
  await browser.happyDOM.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
function Probe() {
  const reader = useMessageTTS('binding-fixture');
  return <button onClick={() => void reader.play('Read this message.', { summarize: false })}>Play</button>;
}
for (const legacyProvider of ['browser', 'local'] as const) {
  test(`a binding overrides ${legacyProvider} and clear resumes that unchanged preference`, async () => {
    useConfigStore.setState({ voiceProvider: legacyProvider });
    await act(async () => root.render(<Probe />));
    await act(async () => host.querySelector('button')?.click());
    expect(calls).toEqual(['/api/tts/speak']);
    expect(browserSpeeches).toBe(0);
    expect(useConfigStore.getState().voiceProvider).toBe(legacyProvider);
    configuredBinding = false;
    await act(async () => invalidateServerTTSStatus());
    await act(async () => host.querySelector('button')?.click());
    if (legacyProvider === 'browser') expect(browserSpeeches).toBe(1);
    else expect(calls).toEqual(['/api/tts/speak', '/api/dictation/tts/speak']);
    expect(useConfigStore.getState().voiceProvider).toBe(legacyProvider);
  });
}

test('an immediate play waits for its delayed binding status before choosing a provider', async () => {
  let finish: ((response: Response) => void) | undefined;
  delayedStatus = new Promise((resolve) => { finish = resolve; });
  await act(async () => root.render(<Probe />));
  await act(async () => host.querySelector('button')?.click());
  expect(calls).toEqual([]);
  expect(browserSpeeches).toBe(0);
  if (!finish) throw new Error('Status fixture was not created');
  const complete = finish;
  await act(async () => complete(Response.json({ available: true, configuredBinding: true })));
  expect(calls).toEqual(['/api/tts/speak']);
  expect(browserSpeeches).toBe(0);
  expect(useConfigStore.getState().voiceProvider).toBe('browser');
});


test('a failed status read does not establish absence or permit legacy playback', async () => {
  failedStatus = true;
  await act(async () => root.render(<Probe />));
  await act(async () => host.querySelector('button')?.click());
  expect(calls).toEqual(['/api/tts/speak']);
  expect(browserSpeeches).toBe(0);
  expect(statusReads).toBe(2);
  failedStatus = false; configuredBinding = false;
  await act(async () => host.querySelector('button')?.click());
  expect(statusReads).toBe(3);
  expect(browserSpeeches).toBe(1);
  expect(useConfigStore.getState().voiceProvider).toBe('browser');
});


test('suspended audio contexts unlock before a delayed binding status resolves', async () => {
  useConfigStore.setState({ voiceProvider: 'local' });
  let finish: ((response: Response) => void) | undefined;
  delayedStatus = new Promise((resolve) => { finish = resolve; });
  await act(async () => root.render(<Probe />));
  await act(async () => host.querySelector('button')?.click());
  expect(audioResumes).toBe(2);
  expect(calls).toEqual([]);
  expect(browserSpeeches).toBe(0);
  if (!finish) throw new Error('Status fixture was not created');
  const complete = finish;
  await act(async () => complete(Response.json({ available: true, configuredBinding: true })));
  expect(calls).toEqual(['/api/tts/speak']);
  expect(useConfigStore.getState().voiceProvider).toBe('local');
});
