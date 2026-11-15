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

describe('upstream activity render mode', () => {
  test('uses the normal information flow by default', () => {
    expect(useUIStore.getInitialState().activityRenderMode).toBe('summary');
  });

  for (const version of [24, 25, 26, 27]) {
    test(`restores a v${version} custom execution-fold default`, async () => {
      await hydrateFrom(version, 'collapsed');
      expect(useUIStore.getState().activityRenderMode).toBe('summary');
    });
  }

  test('keeps an expanded choice through the restoration', async () => {
    await hydrateFrom(27, 'summary');
    expect(useUIStore.getState().activityRenderMode).toBe('summary');
  });

  test('keeps a new collapsed choice after the restoration', async () => {
    await hydrateFrom(28, 'collapsed');
    expect(useUIStore.getState().activityRenderMode).toBe('collapsed');
  });
});
