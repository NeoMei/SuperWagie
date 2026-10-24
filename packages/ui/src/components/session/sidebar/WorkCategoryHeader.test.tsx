import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { WorkCategoryHeader } from './WorkCategoryHeader';
import { SessionSidebarActivityHeader } from './sessionSidebarHeaderPresentation';
import { sessionEvents } from '@/lib/sessionEvents';

test('creation entries change language in place and keep the expanded state', async () => {
  const dom = new Window({ url: 'http://sidebar.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const previousLocale = useI18nStore.getState().locale;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let toggled = 0;
  let directoryRequests = 0;
  const unsubscribe = sessionEvents.onDirectoryRequest(() => directoryRequests++);
  try {
    await act(async () => {
      useI18nStore.getState().setLocale('en');
      root.render(<I18nProvider>{(['chat', 'doc', 'deck', 'video', 'page', 'projects'] as const).map((category) => (
        <WorkCategoryHeader key={category} category={category} collapsed={false} forceExpanded={false} onToggle={() => toggled++} onAddProject={() => sessionEvents.requestDirectoryDialog()} />
      ))}</I18nProvider>);
    });
    expect(container.textContent).toContain('Write documents');
    expect(container.textContent).toContain('Make slides');
    expect(/\p{Script=Han}/u.test(container.textContent ?? '')).toBe(false);
    const newDoc = container.querySelector('button[aria-label="New document"]');
    expect(newDoc).not.toBeNull();
    const newProject = container.querySelector<HTMLButtonElement>('button[aria-label="New project"]');
    expect(newProject).not.toBeNull();
    expect(newProject?.classList.contains('opacity-0')).toBe(false);
    expect(newProject?.classList.contains('pointer-events-none')).toBe(false);
    await act(async () => newProject?.click());
    expect(directoryRequests).toBe(1);
    expect(toggled).toBe(0);
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      useI18nStore.getState().setLocale('zh-CN');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain('写文档');
    expect(container.textContent).toContain('做 PPT');
    expect(container.querySelector('button[aria-label="新建文档"]')).toBe(newDoc);
    expect(container.querySelector('button[aria-label="新建项目"]')).toBe(newProject);
    expect(container.querySelector('button[aria-expanded]')).toBe(toggle);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => toggle?.click());
    expect(toggled).toBe(1);

    // Search forces the section open, but its creation action stays usable.
    await act(async () => root.render(<I18nProvider>
      <WorkCategoryHeader category="projects" collapsed={false} forceExpanded onToggle={() => toggled++} onAddProject={() => sessionEvents.requestDirectoryDialog()} />
    </I18nProvider>));
    expect(container.querySelector<HTMLButtonElement>('button[aria-expanded]')?.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="新建项目"]')?.click());
    expect(directoryRequests).toBe(2);
    expect(toggled).toBe(1);

    // A workspace-only host does not supply a directory operation.
    await act(async () => root.render(<I18nProvider>
      <WorkCategoryHeader category="projects" collapsed forceExpanded={false} onToggle={() => toggled++} />
    </I18nProvider>));
    expect(container.querySelector('button[aria-label="新建项目"]')).toBeNull();

    await act(async () => root.render(<I18nProvider>
      <WorkCategoryHeader category="projects" collapsed forceExpanded={false} onToggle={() => toggled++} onAddProject={() => sessionEvents.requestDirectoryDialog()} />
    </I18nProvider>));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="新建项目"]')?.click());
    expect(directoryRequests).toBe(3);
    expect(toggled).toBe(1);

    // The list by time exposes the same project action in its existing header.
    await act(async () => root.render(<I18nProvider>
      <SessionSidebarActivityHeader activityKey="timeline" collapsed forceExpanded={false} alwaysShowActions={false} onToggle={() => toggled++} onNewChat={() => { throw new Error('Project action must not create a chat'); }} onAddProject={() => sessionEvents.requestDirectoryDialog()} />
    </I18nProvider>));
    const timelineCreate = container.querySelector<HTMLButtonElement>('button[aria-label="新建项目"]');
    expect(timelineCreate).not.toBeNull();
    expect(timelineCreate?.classList.contains('opacity-0')).toBe(false);
    await act(async () => timelineCreate?.click());
    expect(directoryRequests).toBe(4);
    expect(toggled).toBe(1);

    await act(async () => root.render(<I18nProvider>
      <SessionSidebarActivityHeader activityKey="timeline" collapsed={false} forceExpanded={false} alwaysShowActions={false} onToggle={() => toggled++} onNewChat={() => undefined} />
    </I18nProvider>));
    expect(container.querySelector('button[aria-label="新建项目"]')).toBeNull();
  } finally {
    unsubscribe();
    await act(async () => root.unmount());
    useI18nStore.getState().setLocale(previousLocale);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
