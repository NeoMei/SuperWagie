import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionWorkflowRuns, useProjectWorkflowRuns, useWorkflowRunsStore } from './store';
import { useSavedWorkflows, useSavedWorkflowsStore } from './saved';
import { isWorkflowsSurfaceShown } from './panel';

const scope = { directories: ['/fixture'], savedDirectory: '/fixture' };
const Probe = () => {
  const session = useSessionWorkflowRuns('fixture-session');
  const project = useProjectWorkflowRuns(scope);
  const saved = useSavedWorkflows('/fixture');
  return <div>{session.length}/{project.length}/{saved.length}</div>;
};

test('disabled workflows hide saved content and issue no session, project or saved reads; enabling starts reads', async () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const globals = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage,
    customElements: happyWindow.customElements,
    Node: happyWindow.Node,
    Text: happyWindow.Text,
    NodeList: happyWindow.NodeList,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    SVGElement: happyWindow.SVGElement,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    ResizeObserver: happyWindow.ResizeObserver,
    MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let requests = 0;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    requests += 1;
    return Response.json(String(input instanceof Request ? input.url : input).includes('/saved') ? { workflows: [{ name: 'fixture' }] } : { runs: [] });
  });
  try {
    useWorkflowRunsStore.getState().reset();
    useSavedWorkflowsStore.setState({ byDirectory: {} });
    useUIStore.setState({ agentWorkflowFeatureAvailable: true, agentWorkflowToolEnabled: false });
    await act(async () => root.render(<Probe />));
    expect(requests).toBe(0);
    expect(isWorkflowsSurfaceShown([{ mode: 'workflows' }], '/fixture')).toBe(false);
    await act(async () => { useUIStore.setState({ agentWorkflowToolEnabled: true }); await new Promise(resolve => setTimeout(resolve, 1)); });
    expect(requests).toBe(3);
    expect(container.textContent).toBe('0/0/1');
    await act(async () => useUIStore.setState({ agentWorkflowToolEnabled: false }));
    expect(container.textContent).toBe('0/0/0');
    await act(async () => {
      useWorkflowRunsStore.getState().reloadLoaded();
      await useWorkflowRunsStore.getState().load('another-session');
      await useWorkflowRunsStore.getState().loadDirectory(['/other']);
      await useSavedWorkflowsStore.getState().load('/other');
    });
    expect(requests).toBe(3);
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    happyWindow.happyDOM.abort();
  }
});
