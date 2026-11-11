import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { dict as en } from '@/lib/i18n/messages/en';
import { formatAgentStatus, type AgentStatus } from '@/lib/agentStatus';
import { formatMessage, type I18nKey, type I18nParams } from '@/lib/i18n/store';
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

type RenderProps = {
  status: AgentStatus;
  permission?: boolean;
  retry?: { attempt?: number; next?: number; resetsAt?: number } | null;
};

const englishLabel = (status: AgentStatus): string => formatAgentStatus(
  (key, params) => formatMessage(en, key, params),
  'en',
  status,
);

const retryLabel = (template: I18nKey, params: I18nParams): string => formatMessage(en, template, params);

const installDom = () => {
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
  return {
    container,
    root,
    restore: async () => {
      await act(async () => root.unmount());
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      happyWindow.happyDOM.abort();
    },
  };
};

const withPlaceholder = async (run: (render: (props: RenderProps) => Promise<void>, container: HTMLElement) => Promise<void>) => {
  const dom = installDom();
  useI18nStore.getState().setLocale('en');
  try {
    const render = async ({ status, permission = false, retry = null }: RenderProps) => {
      await act(async () => dom.root.render(
        <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
          <WorkingPlaceholder isWorking status={status} isWaitingForPermission={permission} retryInfo={retry} />
        </ThemeSystemContext.Provider></I18nProvider>,
      ));
    };
    await run(render, dom.container);
  } finally {
    await dom.restore();
  }
};

describe('WorkingPlaceholder', () => {
  test('holds a status phrase for 1200 ms and keeps the gray row still', async () => {
    await withPlaceholder(async (render, container) => {
      const reading: AgentStatus = { key: 'chat.agentStatus.read.withTarget', target: 'a.ts' };
      const command: AgentStatus = { key: 'chat.agentStatus.command.withTarget', target: 'npm test' };
      const firstLabel = englishLabel(command);
      const secondLabel = englishLabel(reading);

      await render({ status: command });
      expect(container.textContent).toBe(firstLabel);
      const row = container.querySelector('[role="status"]');
      expect(row?.className).toContain('text-muted-foreground');
      expect(/oc-breath|fx-shimmer|animate-|data-breath|data-shimmer/.test(container.innerHTML)).toBe(false);
      expect(row?.getAttribute('aria-label')).toBe(firstLabel);

      await render({ status: reading });
      expect(container.textContent).toBe(firstLabel);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1190)); });
      expect(container.textContent).toBe(firstLabel);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(container.textContent).toBe(secondLabel);
      expect(/oc-breath|fx-shimmer|animate-|data-breath|data-shimmer/.test(container.innerHTML)).toBe(false);
    });
  });

  test('permission and retry replace thinking immediately and locale changes preserve retry', async () => {
    await withPlaceholder(async (render, container) => {
      const thinking: AgentStatus = { key: 'chat.agentStatus.thinking', seed: 'reasoning-0' };
      const permission: AgentStatus = { key: 'chat.agentStatus.waitingPermission' };
      await render({ status: thinking });
      expect(container.textContent).toBe(englishLabel(thinking));

      await render({ status: thinking, permission: true });
      expect(container.textContent).toBe(englishLabel(permission));
      expect(container.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('assertive');
      expect(container.querySelector('[data-waiting="true"]')).not.toBeNull();

      await render({ status: thinking, retry: { attempt: 2 } });
      expect(container.textContent).toBe(retryLabel('chat.agentStatus.retry.attempt', { attempt: 2 }));
      await act(async () => {
        useI18nStore.getState().setLocale('zh-CN');
        for (let wait = 0; useI18nStore.getState().loadingLocale && wait < 100; wait += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      });
      expect(container.textContent).toContain('重试');
      expect(container.textContent).not.toContain('Retrying');
    });
  });
});
