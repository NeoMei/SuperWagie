import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { WorkingPlaceholder } from './WorkingPlaceholder';

const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
  currentTheme: theme,
  availableThemes: [theme],
  setTheme: unexpectedThemeChange,
  customThemesLoading: false,
  reloadCustomThemes: unexpectedThemeChange,
  importTheme: unexpectedThemeChange,
  deleteImportedTheme: unexpectedThemeChange,
  customThemeIds: [],
  isSystemPreference: false,
  setSystemPreference: unexpectedThemeChange,
  themeMode: 'light',
  setThemeMode: unexpectedThemeChange,
  lightThemeId: theme.metadata.id,
  darkThemeId: getDefaultTheme(true).metadata.id,
  setLightThemePreference: unexpectedThemeChange,
  setDarkThemePreference: unexpectedThemeChange,
};

test('permission and retry replace thinking immediately and locale changes preserve the status', async () => {
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
  try {
    useI18nStore.getState().setLocale('en');
    const render = async (permission: boolean, retry: boolean) => {
      await act(async () => root.render(
        <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
          <WorkingPlaceholder isWorking status={{ key: 'chat.agentStatus.thinking', seed: 'reasoning-0' }}
            isWaitingForPermission={permission} retryInfo={retry ? { attempt: 2 } : null} />
        </ThemeSystemContext.Provider></I18nProvider>,
      ));
    };
    await render(false, false);
    expect(container.textContent).not.toBe('');
    await render(true, false);
    expect(container.textContent).toBe('Waiting for permission');
    await render(false, true);
    expect(container.textContent).toBe('Retrying (attempt 2)');
    await act(async () => { useI18nStore.getState().setLocale('zh-CN'); for (let wait = 0; useI18nStore.getState().loadingLocale && wait < 100; wait += 1) await new Promise(resolve => setTimeout(resolve, 1)); });
    expect(container.textContent).toContain('重试');
    expect(container.textContent).not.toContain('Retrying');
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    happyWindow.happyDOM.abort();
  }
});
