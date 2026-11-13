import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://knowledge.test' });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
const { createRoot } = await import('react-dom/client');
const { KnowledgeComposer } = await import('./KnowledgeComposer');
const { useKnowledgeDraft } = await import('./knowledgeDrafts');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const host = document.createElement('div');
document.body.append(host);
let root = createRoot(host);
const project = { id: 'same-name', path: '/a' };
const props = { projectRef: project, form: 'notes' as const, placeholder: 'draft', addLabel: 'add', maxLength: 3000, dictation: false, onSubmit: async () => true };
const field = () => host.querySelector('textarea')!;
const type = async (text: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(field(), text);
  field().dispatchEvent(new Event('input', { bubbles: true }));
});
const render = async (overrides: Partial<React.ComponentProps<typeof KnowledgeComposer>> = {}) => act(async () => root.render(<KnowledgeComposer {...props} {...overrides} />));
const remount = async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
};

test('project, form and runtime drafts survive remount without sharing text', async () => {
  switchRuntimeEndpoint({ apiBaseUrl: 'http://a.test', runtimeKey: 'a' });
  await render();
  await type('报价草稿');
  await remount();
  expect(field().value).toBe('报价草稿');
  await render({ projectRef: { id: 'same-name', path: '/b' } });
  expect(field().value).toBe('');
  await type('B draft');
  await render();
  expect(field().value).toBe('报价草稿');
  await render({ form: 'todos' });
  expect(field().value).toBe('');
  await type('todo draft');
  await render({ form: 'plans' });
  expect(field().value).toBe('');
  await render();
  expect(field().value).toBe('报价草稿');
  await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://b.test', runtimeKey: 'b' }));
  expect(field().value).toBe('');
  await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://a.test', runtimeKey: 'a' }));
  expect(field().value).toBe('报价草稿');
});

test('failed or late saves preserve the captured draft and newer input', async () => {
  let settle: (ok: boolean) => void = () => {};
  const save = () => new Promise<boolean>((resolve) => { settle = resolve; });
  await render({ onSubmit: save });
  await type('original');
  await act(async () => host.querySelector('button')!.click());
  expect(field().value).toBe('original');
  await render({ projectRef: { id: 'same-name', path: '/b' } });
  await act(async () => settle(false));
  expect(field().value).toBe('B draft');
  await render({ onSubmit: save });
  expect(field().value).toBe('original');
  await act(async () => host.querySelector('button')!.click());
  await type('newer');
  await act(async () => settle(true));
  expect(field().value).toBe('newer');
  await render();
  await act(async () => host.querySelector('button')!.click());
  expect(field().value).toBe('');
});

test('a delayed dictation updater stays with its captured entry while another owner is visible', async () => {
  let update: ReturnType<typeof useKnowledgeDraft>['setText'] = () => {};
  let append: ReturnType<typeof useKnowledgeDraft>['updateText'] = () => {};
  function Probe({ path, entry }: { path: string; entry: string }) {
    const draft = useKnowledgeDraft({ id: 'same-name', path }, 'note-body', entry);
    update = draft.setText;
    append = draft.updateText;
    return <p>{draft.text}</p>;
  }
  await act(async () => root.render(<Probe path="/dictation-a" entry="same-id" />));
  await act(async () => update('A text'));
  const capturedTranscript = append;
  await act(async () => root.render(<Probe path="/dictation-b" entry="same-id" />));
  await act(async () => update('B text'));
  await act(async () => capturedTranscript(current => `${current} spoken`));
  expect(host.textContent).toBe('B text');
  await act(async () => root.render(<Probe path="/dictation-a" entry="other-id" />));
  expect(host.textContent).toBe('');
  await act(async () => root.render(<Probe path="/dictation-a" entry="same-id" />));
  expect(host.textContent).toBe('A text spoken');
});

afterAll(async () => {
  await act(async () => root.unmount());
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  browser.happyDOM.abort();
});
