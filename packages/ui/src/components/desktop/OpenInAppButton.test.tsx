import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { dict as enDict } from '@/lib/i18n/messages/en';
import { dict as zhDict } from '@/lib/i18n/messages/zh-CN';
import { OPEN_IN_APPS } from '@/lib/openInApps';
import { useOpenInAppsStore } from '@/stores/useOpenInAppsStore';

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children, ...props }: React.ComponentProps<'div'>) => React.createElement('div', props, children),
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => React.createElement('button', { type: 'button', onClick }, children),
  DropdownMenuSeparator: () => React.createElement('hr'),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
mock.module('@/components/ui', () => ({
  toast: {
    success: () => undefined,
    error: () => undefined,
    info: () => undefined,
  },
}));

// The component renders nothing unless it believes it runs in the desktop shell,
// so the shell checks answer yes and the installed-app scan stays empty.
const desktop = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({
  ...desktop,
  isDesktopShell: () => true,
  isDesktopLocalOriginActive: () => true,
  fetchDesktopInstalledApps: async () => ({
    apps: [
      { name: 'Ghostty', iconDataUrl: undefined },
      { name: 'Visual Studio Code', iconDataUrl: undefined },
    ],
    success: true,
    hasCache: true,
    isCacheStale: false,
  }),
}));

const { OpenInAppButton } = await import('./OpenInAppButton');

describe('OpenInAppButton', () => {
  let windowInstance: Window;
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    windowInstance = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      Node: windowInstance.Node,
      Element: windowInstance.Element,
      HTMLElement: windowInstance.HTMLElement,
      Event: windowInstance.Event,
      MouseEvent: windowInstance.MouseEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    useI18nStore.setState({ locale: 'en', dictionary: enDict });
    useOpenInAppsStore.setState({
      selectedAppId: 'vscode',
      availableApps: OPEN_IN_APPS.filter((app) => app.id === 'vscode' || app.id === 'ghostty'),
      hasLoadedApps: true,
      isScanning: false,
      isCacheStale: false,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  // A menu in the floating work-status card renders in a body portal, so the
  // card's outside-press dismissal needs the marker to know the press is its own.
  test('the app picker menu carries the work-status popup marker', async () => {
    await act(async () => {
      root.render(
        React.createElement(I18nProvider, null,
          React.createElement(OpenInAppButton, { directory: '/repo' }),
        ),
      );
    });
    await act(async () => { await Promise.resolve(); });

    expect(host.querySelector('[data-work-status-popup]')).not.toBeNull();
  });

  test('refreshing installed apps keeps Windows file manager names and native app identities', async () => {
    window.__OPENCHAMBER_PLATFORM__ = 'win32';
    await useOpenInAppsStore.getState().loadInstalledApps(true);

    expect(useOpenInAppsStore.getState().availableApps.find((app) => app.id === 'finder'))
      .toEqual({ id: 'finder', label: 'File Explorer', appName: 'File Explorer', iconDataUrl: undefined });
    expect(useOpenInAppsStore.getState().availableApps.some((app) => app.id === 'iterm2')).toBe(false);
  });

  test('Windows file and terminal actions use native wording without bundled Mac icons', async () => {
    window.__OPENCHAMBER_PLATFORM__ = 'win32';
    useOpenInAppsStore.setState({
      selectedAppId: 'finder',
      availableApps: OPEN_IN_APPS.filter((app) => app.id === 'finder' || app.id === 'terminal'),
    });
    await act(async () => {
      root.render(
        React.createElement(I18nProvider, null,
          React.createElement(OpenInAppButton, { directory: 'C:/repo' }),
        ),
      );
    });

    expect(host.querySelector('button[aria-label="Open in File Explorer"]')).not.toBeNull();
    expect(host.textContent).toContain('Open in File Explorer');
    expect(host.textContent).toContain('Terminal');
    expect(host.querySelector('img')).toBeNull();

    await act(async () => {
      useI18nStore.setState({ locale: 'zh-CN', dictionary: zhDict });
    });
    expect(host.querySelector('button[aria-label="在文件资源管理器中打开"]')).not.toBeNull();
    expect(host.textContent).toContain('终端');
  });
});
