import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { getDeferredSafeStorage, getSafeStorage } from '@/stores/utils/safeStorage';
import { useSessionProjectViewState } from './useSessionProjectViewState';

const CATEGORY_COLLAPSE_KEY = 'oc.sessions.categoryCollapse';
type ProjectView = ReturnType<typeof useSessionProjectViewState>;
type Fixture = {
  current: () => ProjectView;
  render: (searchExpanded: boolean) => Promise<void>;
  storage: Storage;
  backingStorage: Storage;
};

const flushStorage = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const withProjectView = async (run: (fixture: Fixture) => Promise<void>) => {
  const dom = new Window({ url: 'http://project-entry.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  // Store imports may have initialized this cache before the DOM existed.
  // Seed and restore the same storage instances the real hook reads.
  const storage = getDeferredSafeStorage();
  const backingStorage = getSafeStorage();
  const previousCategoryCollapse = storage.getItem(CATEGORY_COLLAPSE_KEY);
  storage.setItem(CATEGORY_COLLAPSE_KEY, JSON.stringify(['projects', 'doc']));
  await flushStorage();

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const projects = [{ id: 'project-a' }];
  let captured: ProjectView | null = null;
  const Harness = ({ searchExpanded }: { searchExpanded: boolean }) => {
    captured = useSessionProjectViewState({ isVSCode: false, projects });
    return <span data-search-expanded={searchExpanded} />;
  };
  const current = (): ProjectView => {
    if (!captured) throw new Error('project view hook did not mount');
    return captured;
  };
  const render = async (searchExpanded: boolean) => {
    await act(async () => root.render(<Harness searchExpanded={searchExpanded} />));
  };

  try {
    await render(false);
    await run({ current, render, storage, backingStorage });
  } finally {
    await act(async () => root.unmount());
    if (previousCategoryCollapse === null) storage.removeItem(CATEGORY_COLLAPSE_KEY);
    else storage.setItem(CATEGORY_COLLAPSE_KEY, previousCategoryCollapse);
    await flushStorage();
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
};

test('expands the saved Projects category and persists other category choices', async () => {
  await withProjectView(async ({ current, storage, backingStorage }) => {
    expect(current().state.collapsedCategories).toEqual(new Set(['projects', 'doc']));
    expect(backingStorage.getItem(CATEGORY_COLLAPSE_KEY)).toBe('["projects","doc"]');

    await act(async () => current().actions.expandCategory('projects'));
    await flushStorage();

    expect(current().state.collapsedCategories).toEqual(new Set(['doc']));
    expect(storage.getItem(CATEGORY_COLLAPSE_KEY)).toBe('["doc"]');
    expect(backingStorage.getItem(CATEGORY_COLLAPSE_KEY)).toBe('["doc"]');
  });
});

test('repeated creation requests keep Projects open and preserve other categories', async () => {
  await withProjectView(async ({ current, backingStorage }) => {
    await act(async () => current().actions.expandCategory('projects'));
    const expandedCategories = current().state.collapsedCategories;

    await act(async () => {
      current().actions.expandCategory('projects');
      current().actions.expandCategory('projects');
    });
    await flushStorage();

    expect(current().state.collapsedCategories).toBe(expandedCategories);
    expect(current().state.collapsedCategories).toEqual(new Set(['doc']));
    expect(backingStorage.getItem(CATEGORY_COLLAPSE_KEY)).toBe('["doc"]');
  });
});

test('creation clears saved Projects collapse after a search forces the presentation open', async () => {
  await withProjectView(async ({ current, render, backingStorage }) => {
    // Search expands projected headers without mutating the saved category state.
    await render(true);
    expect(current().state.collapsedCategories).toEqual(new Set(['projects', 'doc']));
    expect(backingStorage.getItem(CATEGORY_COLLAPSE_KEY)).toBe('["projects","doc"]');

    await act(async () => current().actions.expandCategory('projects'));
    await flushStorage();
    await render(false);

    expect(current().state.collapsedCategories).toEqual(new Set(['doc']));
    expect(backingStorage.getItem(CATEGORY_COLLAPSE_KEY)).toBe('["doc"]');
  });
});
