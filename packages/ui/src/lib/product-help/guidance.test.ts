import { describe, expect, test } from 'bun:test';
import { createStore } from 'zustand/vanilla';
import { createGuidanceState, getGuidanceStep, type GuidanceState } from './guidance';

function setup(supported = true) {
  const navigations: string[] = [];
  const store = createStore<GuidanceState>(createGuidanceState({
    isSupported: () => supported,
    navigate: (step) => { navigations.push(`${step.destination.kind === 'settings' ? step.destination.page : step.destination.kind}/${step.itemId}`); },
  }));
  return { store, navigations };
}

function finish(store: ReturnType<typeof setup>['store'], action: Parameters<GuidanceState['beginAction']>[0]) {
  const token = store.getState().beginAction(action);
  store.getState().reportAction(token, 'complete');
}

describe('product help guidance', () => {
  test('keeps the clicked instructions available through navigation and retry without claiming task success', () => {
    const { store } = setup();
    store.getState().start('skills', 'guide', 'Choose a skill, then select it in the chat input.');
    const session = store.getState().session;
    if (!session) throw new Error('Missing guide');
    expect(session.mode).toBe('guide');
    expect(session.instructions).toBe('Choose a skill, then select it in the chat input.');
    store.getState().markReady(session.requestId);
    finish(store, 'appearance.language.changed');
    expect(store.getState().session?.status).toBe('ready');
    store.getState().markUnavailable(session.requestId, 'hidden');
    store.getState().retry();
    expect(store.getState().session?.instructions).toBe(session.instructions);
    expect(store.getState().session?.status).toBe('locating');
    store.getState().stop();
    expect(store.getState().session).toBeNull();
  });
  test('opens registered product destinations without reporting an operation as complete', () => {
    for (const [target, itemId] of [['skills', 'settings-page.skills.installed'], ['files', 'files'], ['scheduled-tasks', 'scheduled-tasks']] as const) {
      const { store } = setup();
      store.getState().start(target, 'locate');
      const session = store.getState().session;
      if (!session) throw new Error('Missing location');
      expect(getGuidanceStep(session).itemId).toBe(itemId);
      store.getState().markReady(session.requestId);
      finish(store, 'models.connection.saved');
      expect(store.getState().session?.status).toBe('ready');
    }
  });

  test('reports unavailable navigation without pretending the destination opened', () => {
    const store = createStore<GuidanceState>(createGuidanceState({ isSupported: () => true, navigate: () => false }));
    store.getState().start('worktrees', 'locate');
    expect(store.getState().session).toMatchObject({ status: 'unavailable', reason: 'unsupported' });
  });
  test('selection, saved response and verified test advance the exact registered steps', () => {
    const { store, navigations } = setup();
    store.getState().start('models', 'guide');
    const first = store.getState().session;
    if (!first) throw new Error('Missing guide');
    store.getState().markReady(first.requestId);
    expect(store.getState().session?.stepIndex).toBe(0);
    // Seeing an anchor and an unrelated action are not task completion.
    finish(store, 'models.connection.tested');
    expect(store.getState().session?.stepIndex).toBe(0);
    finish(store, 'models.connection.selected');
    expect(store.getState().session?.stepIndex).toBe(1);
    finish(store, 'models.connection.saved');
    expect(store.getState().session?.stepIndex).toBe(2);
    expect(store.getState().session?.status).not.toBe('completed');
    finish(store, 'models.connection.tested');
    expect(store.getState().session?.status).toBe('completed');
    expect(navigations).toEqual(['models/models.connection-preset']);
  });

  test('failed saves and tests stay on their action and can be retried', () => {
    const { store } = setup();
    store.getState().start('models', 'guide');
    finish(store, 'models.connection.selected');
    store.getState().reportAction(store.getState().beginAction('models.connection.saved'), 'failed');
    expect(store.getState().session?.status).toBe('failed');
    expect(store.getState().session?.stepIndex).toBe(1);
    finish(store, 'models.connection.saved');
    store.getState().reportAction(store.getState().beginAction('models.connection.tested'), 'failed');
    expect(store.getState().session?.status).toBe('failed');
    expect(store.getState().session?.stepIndex).toBe(2);
    finish(store, 'models.connection.tested');
    expect(store.getState().session?.status).toBe('completed');
  });

  test('only the latest action attempt can complete the current step', () => {
    const { store } = setup();
    store.getState().start('appearance', 'guide');
    finish(store, 'appearance.language.opened');
    const old = store.getState().beginAction('appearance.language.changed');
    const current = store.getState().beginAction('appearance.language.changed');
    store.getState().reportAction(old, 'complete');
    expect(store.getState().session?.status).toBe('working');
    store.getState().reportAction(current, 'complete');
    expect(store.getState().session?.status).toBe('completed');
  });

  test('retry, close and restart invalidate old asynchronous callbacks', () => {
    const { store } = setup();
    store.getState().start('appearance', 'guide');
    const original = store.getState().session;
    if (!original) throw new Error('Missing guide');
    const old = store.getState().beginAction('appearance.language.opened');
    store.getState().markUnavailable(original.requestId, 'hidden');
    store.getState().retry();
    store.getState().reportAction(old, 'complete');
    store.getState().markReady(original.requestId);
    expect(store.getState().session?.status).toBe('locating');
    store.getState().stop();
    store.getState().reportAction(old, 'complete');
    expect(store.getState().session).toBeNull();
    store.getState().start('appearance', 'guide');
    store.getState().reportAction(old, 'complete');
    expect(store.getState().session?.stepIndex).toBe(0);
  });

  test('back returns to its control and does not fabricate a saved result', () => {
    const { store, navigations } = setup();
    store.getState().start('appearance', 'guide');
    finish(store, 'appearance.language.opened');
    store.getState().back();
    expect(navigations).toEqual(Array(2).fill('appearance/appearance.language'));
    expect(store.getState().session?.status).toBe('locating');
    expect(store.getState().session?.stepIndex).toBe(0);
  });

  test('unsupported runtimes explain failure without navigation', () => {
    const { store, navigations } = setup(false);
    store.getState().start('knowledge', 'locate');
    expect(store.getState().session?.reason).toBe('unsupported');
    expect(navigations).toEqual([]);
  });

  test('locations and unsupported task guides cannot report task completion', () => {
    for (const target of ['models', 'knowledge', 'theme', 'shortcuts'] as const) {
      const { store } = setup();
      store.getState().start(target, target === 'models' ? 'locate' : 'guide');
      const session = store.getState().session;
      if (!session) throw new Error('Missing location');
      store.getState().markReady(session.requestId);
      expect(session.mode).toBe('locate');
      finish(store, 'models.connection.saved');
      expect(store.getState().session?.status).toBe('ready');
      if (target === 'models') expect(getGuidanceStep(session).itemId).toBe('models.overview');
      if (target === 'theme') expect(getGuidanceStep(session).itemId).toBe('appearance.themes');
    }
  });
});
