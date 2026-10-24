import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();
afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

const hydrateFrom = async (version: number, reasoning: {
  expandReasoningWhileStreaming: boolean;
  showReasoningTraces?: boolean;
  collapsibleThinkingBlocks?: boolean;
}): Promise<void> => {
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version, state: { ...useUIStore.getInitialState(), ...reasoning } }),
    setItem: () => undefined,
    removeItem: () => undefined,
  } });
  await useUIStore.persist.rehydrate();
};

describe('reasoning streaming default', () => {
  test('opens incoming reasoning by default', () => {
    expect(useUIStore.getInitialState().expandReasoningWhileStreaming).toBe(true);
  });

  test('upgrades the old indistinguishable local false once', async () => {
    await hydrateFrom(26, { expandReasoningWhileStreaming: false });
    expect(useUIStore.getState().expandReasoningWhileStreaming).toBe(true);
  });

  test('keeps a local false saved after the default changed', async () => {
    await hydrateFrom(27, { expandReasoningWhileStreaming: false });
    expect(useUIStore.getState().expandReasoningWhileStreaming).toBe(false);
  });

  test('keeps reasoning hidden when upgrading the streaming default', async () => {
    await hydrateFrom(26, { expandReasoningWhileStreaming: false, showReasoningTraces: false });
    expect(useUIStore.getState().expandReasoningWhileStreaming).toBe(true);
    expect(useUIStore.getState().showReasoningTraces).toBe(false);
  });

  test('keeps noncollapsible reasoning when upgrading the streaming default', async () => {
    await hydrateFrom(26, { expandReasoningWhileStreaming: false, collapsibleThinkingBlocks: false });
    expect(useUIStore.getState().expandReasoningWhileStreaming).toBe(true);
    expect(useUIStore.getState().collapsibleThinkingBlocks).toBe(false);
  });
});
