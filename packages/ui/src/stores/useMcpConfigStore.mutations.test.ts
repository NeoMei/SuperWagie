import { afterEach, expect, spyOn, test } from 'bun:test';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import { getConfigUpdateSnapshot, startConfigUpdate } from '@/lib/configUpdate';
import { useMcpConfigStore, type McpDraft } from './useMcpConfigStore';
import { refreshAfterOpenCodeRestart, useAgentsStore } from './useAgentsStore';
import { useConfigStore } from './useConfigStore';
import { useCommandsStore } from './useCommandsStore';
import { useSkillsStore } from './useSkillsStore';
import { useSkillsCatalogStore } from './useSkillsCatalogStore';
import { useProjectsStore } from './useProjectsStore';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
const deferred = <T>() => {
  let finish: (value: T) => void = () => { throw new Error('deferred was not initialized'); };
  let fail: (reason: Error) => void = () => { throw new Error('deferred was not initialized'); };
  const promise = new Promise<T>((resolve, reject) => { finish = resolve; fail = reject; });
  return { promise, finish, fail };
};
const draft = (name = 'lab'): McpDraft => ({
  name, scope: 'user', type: 'local', command: ['lab'], url: '', environment: [], headers: [],
  oauthEnabled: false, oauthClientId: '', oauthClientSecret: '', oauthScope: '', oauthRedirectUri: '',
  oauthCallbackPort: '', oauthAuthServerMetadataUrl: '', protocol: 'legacy', timeoutStartup: '',
  timeoutCatalog: '', timeoutExecution: '', codemode: 'default', disabled: false,
});
const switchTo = (id: string) => {
  switchRuntimeEndpoint({ apiBaseUrl: `http://runtime-${id}.invalid`, runtimeKey: `mcp-mutation-${id}` });
  useMcpConfigStore.getState().resetForRuntimeSwitch();
};
const beginMutation = (method: string) => method === 'POST'
  ? useMcpConfigStore.getState().createMcp(draft(), '/a-only')
  : useMcpConfigStore.getState().deleteMcp('lab', '/a-only');

for (const method of ['POST', 'DELETE']) {
  for (const returnToA of [false, true]) {
    for (const outcome of ['success', 'http-error', 'transport-error', 'manual-restart', 'reload']) {
      test(`${method} retires ${outcome} after ${returnToA ? 'A-to-B-to-A' : 'A-to-B'}`, async () => {
        const response = deferred<Response>();
        const started = deferred<void>();
        const requests: string[] = [];
        const errors = spyOn(console, 'error').mockImplementation(() => undefined); spies.push(errors);
        spies.push(spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          const url = String(input instanceof Request ? input.url : input);
          if (!url.includes('/api/config/mcp')) return Response.json({});
          const verb = init?.method ?? (input instanceof Request ? input.method : 'GET');
          requests.push(`${verb} ${url}`);
          if (verb === method) { started.finish(); return response.promise; }
          return Response.json([]);
        }));
        switchTo('a');
        const pending = beginMutation(method);
        // Observe rejection immediately so a stale rejected create cannot escape as unhandled.
        const settled = pending.then((value) => value, (error: Error) => ({ error }));
        await started.promise;
        switchTo('b');
        if (returnToA) switchTo('a');
        const newerDraft = draft('newer');
        useMcpConfigStore.setState({ selectedMcpName: 'lab', mcpDraft: newerDraft });
        const banner = getConfigUpdateSnapshot();
        if (outcome === 'transport-error') response.fail(new Error('old connection lost'));
        else response.finish(Response.json(
          outcome === 'manual-restart' ? { requiresManualRestart: true }
            : outcome === 'reload' ? { requiresReload: true, reloadDelayMs: 0 }
              : outcome === 'http-error' ? { error: 'old failure' } : {},
          { status: outcome === 'http-error' ? 500 : 200 },
        ));
        expect(await settled).toEqual({ ok: false });
        expect(requests).toEqual([`${method} http://runtime-a.invalid/api/config/mcp/lab?directory=%2Fa-only`]);
        expect(useMcpConfigStore.getState().selectedMcpName).toBe('lab');
        expect(useMcpConfigStore.getState().mcpDraft).toBe(newerDraft);
        expect(getConfigUpdateSnapshot()).toEqual(banner);
        expect(errors).not.toHaveBeenCalled();
      });
    }
  }

  for (const manual of [false, true]) {
    for (const returnToA of [false, true]) {
      test(`${method} returns retired failure if its ${manual ? 'manual-restart ' : ''}follow-up GET completes after ${returnToA ? 'A-to-B-to-A' : 'A-to-B'}`, async () => {
        const list = deferred<Response>(); const started = deferred<void>();
        spies.push(spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          const url = String(input instanceof Request ? input.url : input);
          if (!url.includes('/api/config/mcp')) return Response.json({});
          if (init?.method === method) return Response.json(manual ? { requiresManualRestart: true } : {});
          started.finish(); return list.promise;
        }));
        switchTo('a');
        const pending = beginMutation(method);
        await started.promise;
        switchTo('b');
        if (returnToA) switchTo('a');
        useMcpConfigStore.getState().setSelectedMcp('lab');
        list.finish(Response.json([{ name: 'old', type: 'local', command: ['old'] }]));
        expect(await pending).toEqual({ ok: false });
        expect(useMcpConfigStore.getState().selectedMcpName).toBe('lab');
        expect(useMcpConfigStore.getState().getMcpServersForDirectory('/a-only')).toEqual([]);
      });
    }
  }

  test(`${method} restart polling stops after a pending health probe changes runtime`, async () => {
    const health = deferred<boolean>(); const started = deferred<void>(); const requests: string[] = [];
    spies.push(spyOn(opencodeClient, 'checkHealth').mockImplementation(() => { started.finish(); return health.promise; }));
    spies.push(spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/auth/url-token')) return Response.json({});
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      return Response.json({ requiresReload: true, reloadDelayMs: 0 });
    }));
    switchTo('a');
    const pending = beginMutation(method);
    await started.promise;
    switchTo('b'); switchTo('a');
    const count = requests.length;
    health.finish(true);
    expect(await pending).toEqual({ ok: false });
    expect(requests.slice(count)).toEqual([]);
    expect(getConfigUpdateSnapshot().isUpdating).toBe(false);
  });

  for (const manual of [false, true]) {
    test(`${method} same-runtime ${manual ? 'manual-restart' : 'plain'} success still reloads its directory`, async () => {
      const requests: string[] = [];
      spies.push(spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.includes('/api/config/mcp')) return Response.json({});
        requests.push(`${init?.method ?? 'GET'} ${url}`);
        return init?.method === method ? Response.json({ requiresManualRestart: manual, message: 'saved' }) : Response.json([]);
      }));
      switchTo('a'); useMcpConfigStore.getState().setSelectedMcp('lab');
      const result = await beginMutation(method);
      expect(result.ok).toBe(true);
      expect(result.message).toBe('saved');
      expect(result.requiresManualRestart).toBe(manual ? true : undefined);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe('GET http://runtime-a.invalid/api/config/mcp?directory=%2Fa-only');
      expect(useMcpConfigStore.getState().selectedMcpName).toBe(method === 'DELETE' ? null : 'lab');
    });
  }

  test(`${method} same-runtime failure retains its established result and selection`, async () => {
    spies.push(spyOn(console, 'error').mockImplementation(() => undefined));
    spies.push(spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: 'denied' }, { status: 403 })));
    switchTo('a'); useMcpConfigStore.getState().setSelectedMcp('lab');
    if (method === 'POST') await expect(beginMutation(method)).rejects.toThrow('denied');
    else expect(await beginMutation(method)).toEqual({ ok: false });
    expect(useMcpConfigStore.getState().selectedMcpName).toBe('lab');
  });
}


for (const method of ['POST', 'DELETE']) {
  for (const retireRead of [false, true]) {
    test(`${method} reload refresh ${retireRead ? 'rejects a retired final GET' : 'keeps same-runtime success'}`, async () => {
      const list = deferred<Response>(); const started = deferred<void>();
      const reads: string[] = [];
      useProjectsStore.setState({ projects: [{ id: 'a', path: '/a-only' }], activeProjectId: 'a' });
      spies.push(spyOn(opencodeClient, 'getDirectory').mockReturnValue('/a-only'));
      spies.push(spyOn(opencodeClient, 'checkHealth').mockResolvedValue(true));
      spies.push(spyOn(useConfigStore.getState(), 'loadProviders').mockImplementation(async () => { reads.push('providers'); }));
      spies.push(spyOn(useConfigStore.getState(), 'loadAgents').mockImplementation(async () => { reads.push('sdk-agents'); return true; }));
      spies.push(spyOn(useAgentsStore.getState(), 'loadAgents').mockImplementation(async () => { reads.push('agents'); return true; }));
      spies.push(spyOn(useCommandsStore.getState(), 'loadCommands').mockImplementation(async () => { reads.push('commands'); return true; }));
      spies.push(spyOn(useSkillsStore.getState(), 'loadSkills').mockImplementation(async () => { reads.push('skills'); return true; }));
      spies.push(spyOn(useSkillsCatalogStore.getState(), 'loadCatalog').mockImplementation(async () => { reads.push('catalog'); return true; }));
      const requests: string[] = [];
      spies.push(spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.includes('/api/config/mcp')) return Response.json({});
        requests.push(`${init?.method ?? 'GET'} ${url}`);
        if (init?.method === method) return Response.json({ requiresReload: true, reloadDelayMs: 0 });
        started.finish(); return retireRead ? list.promise : Response.json([]);
      }));
      switchTo('a');
      const pending = beginMutation(method);
      await started.promise;
      expect(reads.sort()).toEqual(['agents', 'catalog', 'commands', 'providers', 'sdk-agents', 'skills']);
      if (retireRead) {
        switchTo('b'); switchTo('a');
        list.finish(Response.json([{ name: 'old', type: 'local', command: ['old'] }]));
      }
      expect((await pending).ok).toBe(!retireRead);
      expect(requests).toEqual([
        `${method} http://runtime-a.invalid/api/config/mcp/lab?directory=%2Fa-only`,
        'GET http://runtime-a.invalid/api/config/mcp?directory=%2Fa-only',
      ]);
      expect(useMcpConfigStore.getState().getMcpServersForDirectory('/a-only')).toEqual([]);
      expect(getConfigUpdateSnapshot().isUpdating).toBe(false);
    });
  }
}


test('a refresh retired before entry releases its existing config-update count without probing', async () => {
  const health = spyOn(opencodeClient, 'checkHealth').mockResolvedValue(true); spies.push(health);
  startConfigUpdate('owned MCP reload');
  await refreshAfterOpenCodeRestart({ isCurrentRuntime: () => false });
  expect(health).not.toHaveBeenCalled();
  expect(getConfigUpdateSnapshot().isUpdating).toBe(false);
});
