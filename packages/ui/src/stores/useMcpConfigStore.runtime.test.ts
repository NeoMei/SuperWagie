import { afterEach, expect, spyOn, test } from 'bun:test';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useMcpConfigStore } from './useMcpConfigStore';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

for (const method of ['GET', 'PATCH']) {
  test(`a ${method} completion from a retired runtime cannot publish or refresh the new runtime`, async () => {
    let finish: (response: Response) => void = () => { throw new Error('request did not start'); };
    let mcpRequests = 0;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => { started = resolve; });
    spies.push(spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes('/api/config/mcp')) return Response.json({});
      mcpRequests += 1;
      expect(init?.method ?? (input instanceof Request ? input.method : 'GET')).toBe(method);
      started();
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.invalid', runtimeKey: 'mcp-fixture-a' });
    useMcpConfigStore.setState({ serversByDirectory: {} });
    const request = method === 'GET'
      ? useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/fixture' })
      : useMcpConfigStore.getState().updateMcp('lab', { disabled: true }, '/fixture');
    await ready;
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.invalid', runtimeKey: 'mcp-fixture-b' });
    finish(Response.json(method === 'GET' ? [{ name: 'old', type: 'local', command: ['old'] }] : {}));
    await request;
    expect(useMcpConfigStore.getState().getMcpServersForDirectory('/fixture')).toEqual([]);
    expect(mcpRequests).toBe(1);
  });
}
