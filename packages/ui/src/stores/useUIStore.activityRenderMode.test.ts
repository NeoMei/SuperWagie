import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();
afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

const hydrateFrom = async (version: number, activityRenderMode: 'collapsed' | 'summary'): Promise<void> => {
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version, state: { ...useUIStore.getInitialState(), activityRenderMode } }),
    setItem: () => undefined,
    removeItem: () => undefined,
  } });
  await useUIStore.persist.rehydrate();
};

describe('activity render mode default', () => {
  test('folds Activity by default', () => {
    expect(useUIStore.getInitialState().activityRenderMode).toBe('collapsed');
  });

  test('a v24 store that held the old expanded default hydrates folded', async () => {
    await hydrateFrom(24, 'summary');
    expect(useUIStore.getState().activityRenderMode).toBe('collapsed');
  });

  test('keeps an expanded choice stored after the default changed', async () => {
    await hydrateFrom(25, 'summary');
    expect(useUIStore.getState().activityRenderMode).toBe('summary');
  });
});
