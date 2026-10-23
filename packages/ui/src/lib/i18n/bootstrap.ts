import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, normalizeLocale, type Locale } from './runtime';

type BootstrapMessages = {
  startingApi: string;
  initializing: string;
  connecting: string;
  connected: string;
  connectionError: string;
  disconnected: string;
  reconnecting: string;
  initialDataLoadFailed: string;
  cliNotFound: string;
  providersReady: string;
  providersLoading: string;
  agentsReady: string;
  agentsLoading: string;
  startingDevServer: (hostLabel: string) => string;
  waitingDevServer: (hostLabel: string, attempt: number) => string;
  loadingData: (providersText: string, agentsText: string) => string;
};

const EN_MESSAGES: BootstrapMessages = {
  startingApi: 'Starting OpenCode API…',
  initializing: 'Initializing…',
  connecting: 'Connecting…',
  connected: 'Connected!',
  connectionError: 'Connection error',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting…',
  initialDataLoadFailed: 'OpenCode connected, but initial data load failed.',
  cliNotFound: 'OpenCode CLI not found. Please install it first.',
  providersReady: '✓ Providers',
  providersLoading: '… Providers',
  agentsReady: '✓ Agents',
  agentsLoading: '… Agents',
  startingDevServer: (hostLabel) => `Starting webview dev server (${hostLabel})...`,
  waitingDevServer: (hostLabel, attempt) => `Waiting for webview dev server (${hostLabel})... attempt ${attempt}`,
  loadingData: (providersText, agentsText) => `Loading data (${providersText}, ${agentsText})…`,
};

const ZH_CN_MESSAGES: BootstrapMessages = {
  startingApi: '正在启动 OpenCode API…',
  initializing: '正在初始化…',
  connecting: '正在连接…',
  connected: '已连接！',
  connectionError: '连接错误',
  disconnected: '已断开连接',
  reconnecting: '正在重新连接…',
  initialDataLoadFailed: 'OpenCode 已连接，但初始数据加载失败。',
  cliNotFound: '未找到 OpenCode CLI。请先安装它。',
  providersReady: '✓ 提供商',
  providersLoading: '… 提供商',
  agentsReady: '✓ 智能体',
  agentsLoading: '… 智能体',
  startingDevServer: (hostLabel) => `正在启动 webview 开发服务器 (${hostLabel})...`,
  waitingDevServer: (hostLabel, attempt) => `正在等待 webview 开发服务器 (${hostLabel})... 第 ${attempt} 次尝试`,
  loadingData: (providersText, agentsText) => `正在加载数据 (${providersText}, ${agentsText})…`,
};

export const getBootstrapMessages = (locale: Locale): BootstrapMessages => {
  return locale === 'en' ? EN_MESSAGES : ZH_CN_MESSAGES;
};

export const readStoredLocaleForBootstrap = (): Locale => {
  if (typeof window === 'undefined') {
    return DEFAULT_LOCALE;
  }

  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_LOCALE;
    }

    const parsed = JSON.parse(raw) as { locale?: unknown };
    return typeof parsed.locale === 'string' ? normalizeLocale(parsed.locale) : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
};
