import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from '@/stores/useUIStore';
import { PRODUCT_HELP_PANEL_KEY } from '@/lib/surfaces/panel-key';
import { shownContextModes } from '@/lib/workspace/zones';
import { openGuestSurface } from './open-surface';

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {}, contextSurfaceZones: {} });
});

describe('opening product help from the workbench', () => {
  test('opens one shared panel without a project and repeated requests keep it open', () => {
    const request = { mode: 'product-help', directory: null, supported: true } as const;
    expect(openGuestSurface(request)).toEqual({ ok: true });
    expect(openGuestSurface(request)).toEqual({ ok: true });
    const state = useUIStore.getState();
    const panel = state.contextPanelByDirectory[PRODUCT_HELP_PANEL_KEY];
    expect(panel.tabs.map((tab) => tab.mode)).toEqual(['product-help']);
    expect(shownContextModes(panel, state.contextSurfaceZones).has('product-help')).toBe(true);
  });

  test('uses the real directory when one exists', () => {
    expect(openGuestSurface({ mode: 'product-help', directory: '/repo/', supported: true })).toEqual({ ok: true });
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].tabs[0].mode).toBe('product-help');
    expect(useUIStore.getState().contextPanelByDirectory[PRODUCT_HELP_PANEL_KEY]).toBeUndefined();
  });

  test('keeps project panels out of the UI-only state key', () => {
    expect(openGuestSurface({ mode: 'file', directory: null, supported: true })).toMatchObject({ ok: false, code: 'NO_DIRECTORY' });
    const store = useUIStore.getState();
    store.openContextSurface(PRODUCT_HELP_PANEL_KEY, 'terminal');
    store.openContextPanelTab(PRODUCT_HELP_PANEL_KEY, { mode: 'file', targetPath: '/repo/file.txt' });
    expect(store.openTrackerItem(PRODUCT_HELP_PANEL_KEY, { key: 'issue', url: 'https://example.com/issue', label: 'Issue', targetDirectory: null })).toBeNull();
    expect(useUIStore.getState().contextPanelByDirectory[PRODUCT_HELP_PANEL_KEY]).toBeUndefined();
  });

  test('restores help width while dropping project tabs saved under the reserved key', async () => {
    openGuestSurface({ mode: 'product-help', directory: null, supported: true });
    useUIStore.getState().openContextSurface('/repo', 'terminal');
    const state = useUIStore.getState();
    const help = state.contextPanelByDirectory[PRODUCT_HELP_PANEL_KEY];
    const options = useUIStore.persist.getOptions();
    useUIStore.persist.setOptions({ storage: {
      getItem: () => ({
        version: options.version,
        state: {
          contextPanelByDirectory: {
            [PRODUCT_HELP_PANEL_KEY]: {
              ...help,
              tabs: [...help.tabs, ...state.contextPanelByDirectory['/repo'].tabs],
              widthByMode: { 'product-help': 480 },
            },
          },
        },
      }),
      setItem: () => undefined,
      removeItem: () => undefined,
    } });
    try {
      await useUIStore.persist.rehydrate();
      const panel = useUIStore.getState().contextPanelByDirectory[PRODUCT_HELP_PANEL_KEY];
      expect(panel.tabs.map((tab) => tab.mode)).toEqual(['product-help']);
      expect(panel.widthByMode['product-help']).toBe(480);
    } finally {
      useUIStore.persist.setOptions(options);
    }
  });

  test('returns an explicit unsupported result for runtimes without guest panels', () => {
    expect(openGuestSurface({ mode: 'product-help', directory: null, supported: false })).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(useUIStore.getState().contextPanelByDirectory).toEqual({});
  });
});
