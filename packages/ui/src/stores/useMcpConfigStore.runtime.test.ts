import { afterEach, expect, spyOn, test } from 'bun:test';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { hasLoadedMcpConfigsForDirectory, useMcpConfigStore } from './useMcpConfigStore';
import { useProjectsStore } from './useProjectsStore';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

for (const method of ['GET', 'PATCH']) {
  for (const returnToA of [false, true]) {
  test(`a ${method} completion from a retired runtime cannot publish${returnToA ? " after A-to-B-to-A" : " on B"}`, async () => {
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
    if (returnToA) switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.invalid', runtimeKey: 'mcp-fixture-a' });
    finish(Response.json(method === 'GET' ? [{ name: 'old', type: 'local', command: ['old'] }] : {}));
    await request;
    expect(useMcpConfigStore.getState().getMcpServersForDirectory('/fixture')).toEqual([]);
    expect(mcpRequests).toBe(1);
  });
  }
}

test('a pending directory A read cannot replace the active directory B mirror', async () => {
  let finishA!: (response: Response) => void;
  const a = new Promise<Response>((resolve) => { finishA = resolve; });
  spies.push(spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.includes('directory=%2Fa') ? a : Response.json([{ name: 'server-b', type: 'local', command: ['b'] }]);
  }));
  useProjectsStore.setState({ projects: [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }], activeProjectId: 'a' });
  useMcpConfigStore.setState({ serversByDirectory: {}, mcpServers: [] });
  const loadA = useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/a' });
  useProjectsStore.setState({ activeProjectId: 'b' });
  expect(await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/b' })).toBe(true);
  finishA(Response.json([{ name: 'server-a', type: 'local', command: ['a'] }]));
  expect(await loadA).toBe(true);
  expect(useMcpConfigStore.getState().getMcpServersForDirectory('/a').map((server) => server.name)).toEqual(['server-a']);
  expect(useMcpConfigStore.getState().getMcpServersForDirectory('/b').map((server) => server.name)).toEqual(['server-b']);
  expect(useMcpConfigStore.getState().mcpServers.map((server) => server.name)).toEqual(['server-b']);
});

test('failed refresh preserves a successful catalog and failed initial reads leave the entry absent', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => undefined); spies.push(errors);
  let response = Response.json([{ name: 'held', type: 'local', command: ['held'] }]);
  spies.push(spyOn(globalThis, 'fetch').mockImplementation(async () => response));
  useMcpConfigStore.setState({ serversByDirectory: {} });
  expect(await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/held' })).toBe(true);
  response = new Response(null, { status: 503 });
  expect(await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/held' })).toBe(false);
  expect(useMcpConfigStore.getState().getMcpServersForDirectory('/held').map((server) => server.name)).toEqual(['held']);
  expect(await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/missing' })).toBe(false);
  expect(hasLoadedMcpConfigsForDirectory(useMcpConfigStore.getState(), '/missing')).toBe(false);
  response = new Response('{malformed');
  expect(await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/missing' })).toBe(false);
  expect(hasLoadedMcpConfigsForDirectory(useMcpConfigStore.getState(), '/missing')).toBe(false);
  response = Response.json([]);
  expect(await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/missing' })).toBe(true);
  expect(hasLoadedMcpConfigsForDirectory(useMcpConfigStore.getState(), '/missing')).toBe(true);
  expect(useMcpConfigStore.getState().serversByDirectory['/missing']).toEqual([]);
});
