import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { IntegrationInfo } from '@opencode/client';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Node: browser.Node, Event: browser.Event,
  CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});
const { act, useLayoutEffect } = await import('react');
const { createRoot } = await import('react-dom/client');
const { opencodeClient } = await import('@/lib/opencode/client');
const { createRuntimeUrlAuthFixture } = await import('@/lib/runtime-url-auth.fixture');
const runtimeUrlAuth = createRuntimeUrlAuthFixture([
  'https://a.test',
  'https://b.test',
]);
const switchRuntimeEndpoint = runtimeUrlAuth.switchEndpoint;

const { useMcpOAuthIntegration } = await import('./useMcpOAuthIntegration');
const { useIntegrationPolicyBlock } = await import('../shared/useIntegrationPolicyBlock');
const { useRuntimeInstance } = await import('@/hooks/useRuntimeInstance');
const sdk = opencodeClient.getSdkClient();
const scoped = spyOn(opencodeClient, 'getScopedSdkClient');
scoped.mockReturnValue(sdk);
const integration: IntegrationInfo = {
  id: 'mcp_docs', name: 'docs', metadata: { source: 'mcp' }, connections: [],
  methods: [{ id: 'login', type: 'oauth', label: 'Docs login' }],
};
const host = document.createElement('div');
document.body.append(host);
let root = createRoot(host);
const spies: Array<{ mockRestore: () => void }> = [];
const switchTo = (name: string) => switchRuntimeEndpoint({ apiBaseUrl: `https://${name}.test`, runtimeKey: name });
const OAuthProbe = ({ directory = '/repo', enabled = true }: { directory?: string; enabled?: boolean }) =>
  <span>{useMcpOAuthIntegration('docs', directory, enabled)?.name ?? 'unknown'}</span>;
const PolicyProbe = () => <span>{useIntegrationPolicyBlock('/repo')('mcp:docs') ? 'blocked' : 'allowed'}</span>;
afterEach(async () => {
  await act(async () => root.unmount());
  await runtimeUrlAuth.restore();
  for (const spy of spies.splice(0)) spy.mockRestore();
  root = createRoot(host);
});
afterAll(async () => { await act(async () => root.unmount()); scoped.mockRestore(); browser.close(); });

test('runtime ownership reconciles a switch between render and passive subscription', async () => {
  switchTo('a');
  let currentOwner = () => false;
  const Probe = () => {
    currentOwner = useRuntimeInstance();
    return <span>{currentOwner() ? 'current' : 'retired'}</span>;
  };
  const Parent = () => {
    useLayoutEffect(() => { switchTo('b'); }, []);
    return <Probe />;
  };
  await act(async () => root.render(<Parent />));
  expect(currentOwner()).toBe(true);
  expect(host.textContent).toBe('current');
});

test('a queued discovery retry makes no read after unmount', async () => {
  const list = spyOn(sdk.integration, 'list').mockResolvedValue({ location: { directory: '/repo' }, data: [] });
  spies.push(list);
  await act(async () => root.render(<OAuthProbe />));
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  root = createRoot(host);
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(list).toHaveBeenCalledTimes(1);
});

test('same-path runtime switches refetch integration discovery and reject the earlier result', async () => {
  switchTo('a');
  let finishA!: (value: Awaited<ReturnType<typeof sdk.integration.list>>) => void;
  const list = spyOn(sdk.integration, 'list')
    .mockImplementationOnce(() => new Promise((resolve) => { finishA = resolve; }))
    .mockResolvedValue({ location: { directory: '/repo' }, data: [integration] });
  spies.push(list);
  await act(async () => root.render(<OAuthProbe />));
  await act(async () => switchTo('b'));
  expect(list).toHaveBeenCalledTimes(2);
  expect(host.textContent).toBe('docs');
  await act(async () => finishA({ location: { directory: '/repo' }, data: [{ ...integration, name: 'retired' }] }));
  expect(host.textContent).toBe('docs');
});

test('an A-to-B-to-A round trip retires the old policy owner and refetches the same path', async () => {
  switchTo('a');
  let finishA!: (value: Awaited<ReturnType<typeof opencodeClient.getIntegrationPolicies>>) => void;
  const policies = spyOn(opencodeClient, 'getIntegrationPolicies')
    .mockImplementationOnce(() => new Promise((resolve) => { finishA = resolve; }))
    .mockResolvedValue([]);
  spies.push(policies);
  await act(async () => root.render(<PolicyProbe />));
  await act(async () => { switchTo('b'); switchTo('a'); });
  expect(policies).toHaveBeenCalledTimes(2);
  await act(async () => finishA([{ resource: 'mcp:docs', effect: 'deny', path: null }]));
  expect(host.textContent).toBe('allowed');
});

test('a published policy from the previous runtime cannot control the same directory', async () => {
  switchTo('a');
  const policies = spyOn(opencodeClient, 'getIntegrationPolicies')
    .mockResolvedValueOnce([{ resource: 'mcp:docs', effect: 'deny', path: null }])
    .mockResolvedValue([]);
  spies.push(policies);
  await act(async () => root.render(<PolicyProbe />));
  expect(host.textContent).toBe('blocked');
  await act(async () => switchTo('b'));
  expect(host.textContent).toBe('allowed');
});

test('changing directories discards a pending lookup without replacing the new integration', async () => {
  let finish!: (value: Awaited<ReturnType<typeof sdk.integration.list>>) => void;
  const list = spyOn(sdk.integration, 'list')
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue({ location: { directory: '/b' }, data: [integration] });
  spies.push(list);
  await act(async () => root.render(<OAuthProbe directory="/a" />));
  await act(async () => root.render(<OAuthProbe directory="/b" />));
  expect(host.textContent).toBe('docs');
  await act(async () => finish({ location: { directory: '/a' }, data: [] }));
  expect(host.textContent).toBe('docs');
  expect(list).toHaveBeenCalledTimes(2);
});

test('disabled discovery makes no read or OAuth request', async () => {
  const list = spyOn(sdk.integration, 'list').mockResolvedValue({ location: { directory: '/repo' }, data: [] });
  const connect = spyOn(sdk.integration.oauth, 'connect').mockRejectedValue(new Error('Unexpected OAuth request'));
  spies.push(list, connect);
  await act(async () => root.render(<OAuthProbe enabled={false} />));
  expect(list).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});

test('an absent integration stops discovery after the bounded window without starting OAuth', async () => {
  const list = spyOn(sdk.integration, 'list').mockResolvedValue({ location: { directory: '/repo' }, data: [] });
  const connect = spyOn(sdk.integration.oauth, 'connect').mockRejectedValue(new Error('Unexpected OAuth request'));
  spies.push(list, connect);
  await act(async () => root.render(<OAuthProbe />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 6800)));
  expect(list).toHaveBeenCalledTimes(9);
  expect(connect).not.toHaveBeenCalled();
  expect(host.textContent).toBe('unknown');
}, 10000);
