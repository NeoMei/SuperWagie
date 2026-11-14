import { expect, test } from 'bun:test';
import { createDesktopOfficialSelectionsAPI } from './desktop';
import type { OfficialSelection, OfficialSelectionRequest } from './guests/mobile-official';

const input: OfficialSelectionRequest = { extensionId: 'openchamber-builtin-creation', projectId: 'a', sessionId: null,
  title: 'Sample', source: { kind: 'artifact', path: 'sample.md' } };

test('native selection adapter refuses unsupported runtimes and retires pending calls on caller or runtime changes', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const surface = new EventTarget();
  const calls: Array<{ command: string; operationId?: string }> = [];
  const pendingResults: Array<(selection: OfficialSelection) => void> = [];
  const pendingResult = () => new Promise<OfficialSelection>((resolve) => { pendingResults.push(resolve); });
  const selection = { id: crypto.randomUUID(), projectId: 'a', projectName: 'A', extensionId: 'openchamber-builtin-creation', sessionId: null,
    createdAt: Date.now(), revision: 'a'.repeat(64), source: input.source, card: { title: 'Sample' },
    preview: { kind: 'unavailable', contentType: 'application/octet-stream', byteLength: 0 } } satisfies OfficialSelection;
  const bridge = { invoke: async (command: string, args: { operationId?: string }) => {
    calls.push({ command, operationId: args.operationId });
    return command === 'desktop_official_select' ? pendingResult() : null;
  } };
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: surface });
    const api = createDesktopOfficialSelectionsAPI();
    if (!api) throw new Error('Adapter missing');
    await expect(api.select(input)).rejects.toThrow('mobile_selector_unsupported');
    Object.assign(surface, { __OPENCHAMBER_ELECTRON__: { runtime: 'electron' }, __OPENCHAMBER_DESKTOP__: bridge,
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:57123', __OPENCHAMBER_API_BASE_URL__: 'http://127.0.0.1:57123' });
    const abort = new AbortController();
    const operation = api.select(input, abort.signal);
    abort.abort();
    pendingResults.shift()?.(selection);
    await expect(operation).rejects.toThrow();
    expect(calls[1]).toEqual({ command: 'desktop_official_selection_cancel', operationId: calls[0].operationId });
    calls.length = 0;
    const switched = api.select(input);
    surface.dispatchEvent(new Event('openchamber:runtime-endpoint-will-change'));
    pendingResults.shift()?.(selection);
    await expect(switched).rejects.toThrow('mobile_selection_cancelled');
    expect(calls[1]).toEqual({ command: 'desktop_official_selection_cancel', operationId: calls[0].operationId });
    const valid = api.select(input); pendingResults.shift()?.(selection); expect(await valid).toEqual(selection);
    Object.assign(surface, { __OPENCHAMBER_API_BASE_URL__: 'https://remote.example' });
    await expect(api.select(input)).rejects.toThrow('mobile_selector_unsupported');
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window');
  }
});
