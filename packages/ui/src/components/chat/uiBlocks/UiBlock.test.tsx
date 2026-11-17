import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';

plugin({ name: 'ui-block-worker-url', setup(build) {
  build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
    contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`, loader: 'js',
  }));
} });
const respond = async (input: RequestInfo | URL) => {
  const path = new URL(input instanceof Request ? input.url : String(input), 'http://ui-block.test').pathname;
  if (path.endsWith('/event') || path.endsWith('/events')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
  if (path === '/api/fs/home') return Response.json({ home: '/synthetic', chatsRoot: '/synthetic/chats' });
  if (path === '/api/location') return Response.json({ directory: '/synthetic', project: { id: 'synthetic', directory: '/synthetic', canonical: '/synthetic' } });
  if (path === '/api/project' || path === '/api/config' || path === '/api/config/themes') return Response.json([]);
  if (path === '/api/session/active') return Response.json({ data: {} });
  if (path === '/api/session-warming') return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
  return Response.json({ data: [] });
};
const sdk = OpenCode.make({ baseUrl: 'http://ui-block.test', fetch: respond });
const unavailable = (): never => { throw new Error('UI block fixture must not invoke runtime capabilities'); };
const runtime: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); }, get git() { return unavailable(); }, get files() { return unavailable(); },
  get settings() { return unavailable(); }, get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
  get sourceControl() { return unavailable(); },
};
const browser = new Window({ url: 'http://ui-block.test' });
browser.document.write('<!doctype html><html><head></head><body></body></html>');
class EventSocket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0; send() {} close() { this.readyState = 3; }
}
const globals = { WebSocket: EventSocket, window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, HTMLElement: browser.HTMLElement,
  HTMLAnchorElement: browser.HTMLAnchorElement, Element: browser.Element, Node: browser.Node, Text: browser.Text,
  Event: browser.Event, MouseEvent: browser.MouseEvent, SVGElement: browser.SVGElement, Range: browser.Range,
  customElements: browser.customElements, MutationObserver: browser.MutationObserver, DOMParser: browser.DOMParser,
  XMLSerializer: browser.XMLSerializer, CustomEvent: browser.CustomEvent, getComputedStyle: browser.getComputedStyle.bind(browser),
  ResizeObserver: browser.ResizeObserver, IntersectionObserver: browser.IntersectionObserver,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true };
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(globals)) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
const fetch = spyOn(globalThis, 'fetch').mockImplementation(respond);
const { UiBlock } = await import('./UiBlock');
const { onTabStep } = await import('../lib/scroll/timelineScrollIntent');
function TestProviders({ children }: { children: React.ReactNode }) {
  return <RuntimeAPIContext.Provider value={runtime}><I18nProvider><SyncProvider sdk={sdk} directory=""><ThemeSystemProvider>{children}</ThemeSystemProvider></SyncProvider></I18nProvider></RuntimeAPIContext.Provider>;
}
type Answer = Parameters<NonNullable<Extract<React.ComponentProps<typeof UiBlock>['host'], { kind: 'page' }>['submit']>>[0];
type ReplyAnswer = Parameters<NonNullable<Extract<React.ComponentProps<typeof UiBlock>['host'], { kind: 'reply' }>['submit']>>[0];

const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
afterAll(async () => {
  await act(() => root.unmount());
  fetch.mockRestore();
  await browser.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

// A key per draw: a reused instance would keep the previous block's sent state.
let drawn = 0;
const render = (source: string, blockHost: React.ComponentProps<typeof UiBlock>['host']) => {
  const key = ++drawn;
  return act(() => root.render(
    <TestProviders>
        <UiBlock key={key} source={source} complete host={blockHost} />
      </TestProviders>,
  ));
};
// Without submit it draws as in a reply.
const draw = (source: string, submit?: (answer: Answer) => Promise<void>) => render(source, submit ? { kind: 'page', submit, answered: null } : undefined);
type ReplySubmit = NonNullable<Extract<React.ComponentProps<typeof UiBlock>['host'], { kind: 'reply' }>['submit']>;
const drawReply = (source: string, submit: ReplySubmit) => render(source, { kind: 'reply', submit, answered: null });
const buttons = () => [...host.querySelectorAll('button')].map((button) => button.textContent);
const option = (label: string) => [...host.querySelectorAll('span')].find((element) => element.textContent === label);
const send = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send');
const press = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`Expected a ${label} button, got ${buttons().join(', ')}`);
  await act(async () => button.click());
};

test('a waiting form without buttons gets one that sends its fields', async () => {
  const answers: Answer[] = [];
  await draw('root = Stack([scope])\nscope = Choice("scope", ["API", "Links"], "Scope")', async (answer) => { answers.push(answer); });
  const send = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send');
  if (!send) throw new Error(`Expected a Send button, got ${buttons().join(', ')}`);
  await act(async () => send.click());
  expect(answers).toHaveLength(1);
  expect(answers[0].data.button).toBe('Send');
});

test('a form with its own button gets no second one', async () => {
  await draw('root = Stack([scope, go])\nscope = Choice("scope", ["API"])\ngo = Button("Go")', async () => {});
  expect(buttons()).toContain('Go');
  expect(buttons()).not.toContain('Send');
});

describe('a form in a reply without buttons', () => {
  const drawReply = (source: string, submit: (answer: ReplyAnswer, text: string) => Promise<void>) => act(() => root.render(
    <TestProviders>
        <UiBlock key={source} source={source} complete host={{ kind: 'reply', submit, answered: null }} />
      </TestProviders>,
  ));
  const buttonNamed = (name: string) => [...host.querySelectorAll('button')].find((button) => button.textContent === name);
  const form = 'root = Stack([deploy])\ndeploy = Choice("deploy", ["Yes", "No"], "What should Deploy do?")';

  test('sends the chosen fields, and offers Send only once one is filled', async () => {
    const answers: { answer: ReplyAnswer; text: string }[] = [];
    await drawReply(form, async (answer, text) => { answers.push({ answer, text }); });
    expect(buttonNamed('Send')?.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLElement>('[role="radio"], [role="checkbox"]')?.click());
    expect(buttonNamed('Send')?.disabled).toBe(false);
    await act(async () => buttonNamed('Send')?.click());
    expect(answers).toEqual([{
      answer: { picks: [], values: { deploy: 'Yes' }, skipped: [] },
      text: 'The user answered the UI block in your previous reply:\n- What should Deploy do? Yes',
    }]);
    expect(host.textContent).toContain('Sent');
  });

  test('a block that lost a part draws the rest and says what it lost', async () => {
    await drawReply('root = Stack([state, note])\nstate = Badge("Done")\nnote = Callout()', async () => {});
    expect(host.textContent).toContain('Done');
    expect(host.textContent).toContain('Part of this block could not be drawn.');
    expect(host.textContent).toContain('missing required field');
  });

  test('a fold with nothing inside draws nothing and says nothing', async () => {
    await drawReply('root = Stack([state, a, b])\nstate = Badge("Done")\na = Details("Method notes")\nb = Details("Sources", [])', async () => {});
    expect(host.textContent).toContain('Done');
    expect(host.textContent).not.toContain('Method notes');
    expect(host.textContent).not.toContain('Sources');
    expect(host.textContent).not.toContain('could not be drawn');
  });

  test('a block with no fields gets no button', async () => {
    await drawReply('root = Stack([state])\nstate = Badge("Done")', async () => {});
    expect(host.textContent).toContain('Done');
    expect(buttons()).not.toContain('Send');
  });
});

test('a block that cannot be drawn says why and folds its source', async () => {
  await draw('root = Stack([question])\nquestion = Choice("approach", ["A"])\nConfirm = Button("Go")', async () => {});
  expect(host.textContent).toContain('Defined but never used: Confirm');
  const source = host.querySelector('pre');
  expect(source?.hidden).toBe(true);
  const toggle = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Source');
  await act(async () => toggle?.click());
  expect(source?.hidden).toBe(false);
});

const tabbedForm = 'root = Stack([tabs])\ntabs = Tabs([Tab("Editor", [Choice("editor", ["Zed"])]), Tab("Why", [Input("why", "Why?")])])';

test('a waiting form that ends with tabs steps through them with Next and sends from the last tab', async () => {
  const answers: Answer[] = [];
  await draw(tabbedForm, async (answer) => { answers.push(answer); });
  expect(buttons()).toContain('Next');
  expect(buttons()).not.toContain('Send');
  await press('Next');
  expect(host.textContent).toContain('Why?');
  expect(buttons()).not.toContain('Next');
  // Next went away, so focus moved to the tab it opened.
  expect(document.activeElement?.classList.contains('oc-box')).toBe(true);
  await press('Send');
  expect(answers).toHaveLength(1);
});

test('Next keeps the fields of earlier tabs and asks for the new tab to come into view, and the first draw does not', async () => {
  const answers: Answer[] = [];
  const steps: HTMLElement[] = [];
  const stop = onTabStep(host, (tabs) => { steps.push(tabs); });
  await draw(tabbedForm, async (answer) => { answers.push(answer); });
  expect(steps).toHaveLength(0);
  await act(async () => host.querySelector<HTMLElement>('[role="radio"]')?.click());
  await press('Next');
  stop();
  expect(steps).toHaveLength(1);
  expect(steps[0].contains(document.activeElement)).toBe(true);
  await press('Send');
  expect(answers[0].data.values).toEqual({ editor: 'Zed' });
});

test('the host\'s controls stay under the block on every tab', async () => {
  await act(() => root.render(
    <TestProviders>
        <UiBlock key={++drawn} source={tabbedForm} complete host={{ kind: 'page', submit: async () => {}, answered: null }} actions={<button type="button">Decline</button>} />
      </TestProviders>,
  ));
  const decline = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Decline');
  const tile = () => host.querySelector('.oc-box');
  expect(decline()).toBeDefined();
  expect(tile()?.contains(decline() ?? null)).toBe(false);
  await press('Next');
  expect(tile()?.contains(decline() ?? null)).toBe(false);
  expect(buttons()).toContain('Send');
  expect(tile()?.textContent).toContain('Send');
});

test('a tab with buttons of its own takes Next on their line', async () => {
  await draw('root = Stack([tabs])\ntabs = Tabs([Tab("A", [Choice("a", ["x"]), Button("Send A", "primary", "a")]), Tab("B", [Input("b")])])', async () => {});
  const row = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Next')?.parentElement;
  expect([...row?.querySelectorAll('button') ?? []].map((button) => button.textContent)).toEqual(['Send A', 'Next']);
});

test('tabs in a reply, or on a page nobody answers, step only through their strip', async () => {
  await draw(tabbedForm);
  expect(buttons()).not.toContain('Next');
  await act(() => root.render(
    <TestProviders>
        <UiBlock key={++drawn} source={tabbedForm} complete host={{ kind: 'page', submit: null, answered: null }} />
      </TestProviders>,
  ));
  expect(buttons()).not.toContain('Next');
});

test("a reply's form without buttons gets one that sends its fields", async () => {
  const answers: Parameters<ReplySubmit>[] = [];
  await drawReply('root = Stack([scope])\nscope = Choice("scope", ["API", "Links"], "Scope")', async (...answer) => { answers.push(answer); });
  const pick = option('API');
  if (!pick) throw new Error(`Expected an option, got ${buttons().join(', ')}`);
  await act(async () => pick.click());
  const press = send();
  if (!press) throw new Error(`Expected a Send button, got ${buttons().join(', ')}`);
  await act(async () => press.click());
  expect(answers).toHaveLength(1);
  expect(answers[0][0].values).toEqual({ scope: 'API' });
  expect(answers[0][0].picks).toEqual([]);
  expect(host.textContent).toContain('Sent');
  expect(buttons()).not.toContain('Send');
});

test("a reply's form with its own button gets no second one", async () => {
  await drawReply('root = Stack([scope, go])\nscope = Choice("scope", ["API"])\ngo = Button("Go")', async () => {});
  expect(buttons()).toContain('Go');
  expect(buttons()).not.toContain('Send');
});

test("a reply's block without fields or buttons gets no Send", async () => {
  await drawReply('root = Stack([badge])\nbadge = Badge("status")', async () => {});
  expect(buttons()).not.toContain('Send');
});

test("a reply's field-only form offers Send once a field has a value", async () => {
  await drawReply('root = Stack([scope])\nscope = Choice("scope", ["API", "Links"])', async () => {});
  expect(send()?.disabled).toBe(true);
  const pick = option('API');
  if (!pick) throw new Error(`Expected an option, got ${buttons().join(', ')}`);
  await act(async () => pick.click());
  expect(send()?.disabled).toBe(false);
});

test("an answered reply's field-only form shows Sent and no Send", async () => {
  await render('root = Stack([scope])\nscope = Choice("scope", ["API"])', {
    kind: 'reply', submit: null, answered: { picks: [], values: { scope: 'API' }, skipped: [] },
  });
  expect(host.textContent).toContain('Sent');
  expect(buttons()).not.toContain('Send');
});

test("a reply's Send can be tried again after a failed send", async () => {
  const attempts: number[] = [];
  await drawReply('root = Stack([scope])\nscope = Choice("scope", ["API"])', async () => {
    attempts.push(attempts.length);
    if (attempts.length === 1) throw new Error('The server did not answer');
  });
  const pick = option('API');
  if (!pick) throw new Error(`Expected an option, got ${buttons().join(', ')}`);
  await act(async () => pick.click());
  const first = send();
  if (!first) throw new Error(`Expected a Send button, got ${buttons().join(', ')}`);
  await act(async () => first.click());
  expect(host.textContent).toContain('Not sent. Try again.');
  expect(send()?.disabled).toBe(false);
  const second = send();
  if (!second) throw new Error(`Expected a Send button to retry, got ${buttons().join(', ')}`);
  await act(async () => second.click());
  expect(attempts).toHaveLength(2);
  expect(host.textContent).toContain('Sent');
});

test("a reply's failed send stops asking to retry once its fields are empty", async () => {
  await drawReply('root = Stack([scope])\nscope = Choice("scope", ["API", "Links"], "Scope", true)', async () => {
    throw new Error('The server did not answer');
  });
  const pick = option('API');
  if (!pick) throw new Error(`Expected an option, got ${buttons().join(', ')}`);
  await act(async () => pick.click());
  const first = send();
  if (!first) throw new Error(`Expected a Send button, got ${buttons().join(', ')}`);
  await act(async () => first.click());
  expect(host.textContent).toContain('Not sent. Try again.');
  await act(async () => pick.click());
  expect(send()?.disabled).toBe(true);
  expect(host.textContent).not.toContain('Not sent. Try again.');
});

test("a reply's decision keeps its failure line after the choice is cleared, since a press retries", async () => {
  await drawReply('root = Stack([go])\ngo = Button("Go")', async () => {
    throw new Error('The server did not answer');
  });
  const go = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Go');
  await act(async () => go()?.click());
  expect(host.textContent).toContain('Not sent. Try again.');
  await act(async () => go()?.click());
  expect(host.textContent).toContain('Not sent. Try again.');
});

describe('a Steps block', () => {
  const classOf = (element: Element | undefined) => element?.getAttribute('class') ?? '';
  // The title is the element carrying the weight, whatever wrapper holds it.
  const titleOf = (title: string) => [...host.querySelectorAll('div')]
    .find((element) => element.textContent === title && classOf(element).includes('font-medium'));
  const markOf = (index: number) => [...host.querySelectorAll('span')]
    .find((element) => element.textContent === String(index) && classOf(element).includes('rounded-full'));

  test('a static flow reads at normal contrast instead of looking pending', async () => {
    await drawReply('root = Stack([flow])\nflow = Steps([{title: "Sender"}, {title: "Router"}], "row")', async () => {});
    expect(host.textContent).toContain('Sender');
    const title = classOf(titleOf('Sender'));
    expect(title).not.toContain('text-muted-foreground');
    const mark = classOf(markOf(1));
    expect(mark).toContain('text-foreground');
    expect(mark).not.toContain('text-muted-foreground');
  });

  test('an explicit todo step still reads as not started', async () => {
    await drawReply('root = Stack([flow])\nflow = Steps([{title: "Sender", status: "done"}, {title: "Router", status: "todo"}], "row")', async () => {});
    expect(classOf(titleOf('Router'))).toContain('text-muted-foreground');
    expect(classOf(markOf(2))).toContain('text-muted-foreground');
  });
});

test('pressing an image choice in a reply sends its label as the decision', async () => {
  const answers: { answer: ReplyAnswer; text: string }[] = [];
  const source = 'root = Stack([styles])\n'
    + 'styles = ImageChoice("style", ['
    + '{label: "选择玻璃", caption: "玻璃", image: "https://g.imgtg.com/uploads/a.png"},'
    + '{label: "选择商务风格", caption: "商务风格", image: "https://g.imgtg.com/uploads/b.png"}'
    + '], "点击图片选择风格")';
  await drawReply(source, async (answer, text) => { answers.push({ answer, text }); });
  expect(host.textContent).toContain('点击图片选择风格');
  const tiles = [...host.querySelectorAll('button[aria-pressed]')];
  expect(tiles).toHaveLength(2);
  const first = tiles[0]! as HTMLElement;
  expect(first.querySelector('img')?.getAttribute('src')).toBe('https://g.imgtg.com/uploads/a.png');
  await act(async () => first.click());
  expect(answers).toHaveLength(1);
  expect(answers[0].answer.picks).toEqual([{ button: '选择玻璃', value: 'style' }]);
  expect(answers[0].text).toContain('- style: 选择玻璃');
  expect(host.textContent).toContain('Sent');
});
