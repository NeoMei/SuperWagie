/**
 * What the entry module needs before `main.mjs` loads: app identity, the
 * first window on the splash, the login-shell probe, and the marks and app
 * events that main picks up later. Imported by the entry before the rest of
 * the main process, so it must stay small: Electron, Node built-ins and the
 * two tiny helpers below, no electron-log, no server code.
 *
 * Electron holds `ready` until the entry module's whole graph has evaluated,
 * and the main bundle takes a few hundred milliseconds of main-thread time to
 * load and set up. The entry module creates the window on the splash the
 * moment `ready` fires; `main.mjs` adopts it through `takeEarlyWindow()` and
 * attaches everything else. Both bundles must share this one module instance
 * (it stays external in `scripts/bundle-main.mjs`), or the handoff slots
 * below would be two different objects.
 *
 * The helpers here are also the main bundle's only copy: settings reading,
 * window state, splash markup and window options live here so the early
 * window and a later main window cannot drift apart.
 */

import { app, BrowserWindow, nativeTheme, protocol, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createShellEnvironmentLoader } from './shell-environment.mjs';
import { isSplashColor } from './remote-page-policy.mjs';
import { clearAppImageArgv0FromProcessEnv } from '@openchamber/web/server/lib/inherited-env.js';
import { APP_NAME, DEEP_LINK_PROTOCOL } from './branding.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const isDev = process.env.OPENCHAMBER_ELECTRON_DEV === '1' || !app.isPackaged;

export { DEEP_LINK_PROTOCOL };
export const UI_PROTOCOL = 'openchamber-ui';
const PACKAGED_APP_USER_MODEL_ID = 'com.quukk.lingxi';
const DEV_APP_USER_MODEL_ID = 'com.quukk.lingxi.dev';
export const APP_USER_MODEL_ID = app.isPackaged ? PACKAGED_APP_USER_MODEL_ID : DEV_APP_USER_MODEL_ID;
export const BACKGROUND_START_ARG = '--background';

export const getLoginItemOptions = () => {
  if (process.platform === 'win32') {
    return {
      path: process.execPath,
      args: [BACKGROUND_START_ARG],
      name: APP_USER_MODEL_ID,
    };
  }
  return {};
};

export const readLoginItemSettings = () => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null;
  try {
    return app.getLoginItemSettings(getLoginItemOptions());
  } catch {
    return null;
  }
};

export const shouldStartInBackground = (loginItemSettings = readLoginItemSettings()) => {
  return (
    process.argv.includes(BACKGROUND_START_ARG) ||
    loginItemSettings?.wasOpenedAtLogin === true
  );
};

// Startup clock shared by every process-lifetime mark: the entry module
// evaluates this import first, so this is as close to "our code started" as
// the main process can observe.
export const startupStartedAt = performance.now();

// Marks recorded before the logger exists are held until `main.mjs` installs
// its `[startup-performance]` sink; later marks (a splash that becomes ready
// after main loaded) go straight to it.
const pendingStartupMarks = [];
let startupMarkSink = null;
export const recordEarlyStartupMark = (phase, details = {}) => {
  const mark = {
    phase,
    at: Date.now(),
    totalDurationMs: Math.max(0, performance.now() - startupStartedAt),
    ...details,
  };
  if (startupMarkSink) startupMarkSink(mark);
  else pendingStartupMarks.push(mark);
};
export const installStartupMarkSink = (sink) => {
  startupMarkSink = sink;
  for (const mark of pendingStartupMarks.splice(0)) sink(mark);
};

export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 520;
const MIN_RESTORE_WINDOW_WIDTH = 900;
const MIN_RESTORE_WINDOW_HEIGHT = 560;
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 800;

export const settingsFilePath = () => {
  if (typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.trim()) {
    return path.join(process.env.OPENCHAMBER_DATA_DIR.trim(), 'settings.json');
  }
  return path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
};

const readJsonFile = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    // Parse errors can happen if a concurrent writer just truncated the file
    // and hasn't finished writing yet. Log loudly so we notice, then return
    // {} as before. Writes are atomic (tmp + rename) so this race is rare.
    console.warn('[electron] failed to read JSON file', filePath, error);
    return {};
  }
};

export const readSettingsRoot = () => {
  const root = readJsonFile(settingsFilePath());
  return root && typeof root === 'object' && !Array.isArray(root) ? root : {};
};

// The user's profile (theme mode among it) lives in preferences.json beside
// settings.json since the settings split; each entry is { value, updatedAt }.
// Installs that predate the split still carry those keys in settings.json, so
// readers merge both, preferences winning.
const readPreferencesValues = () => {
  const root = readJsonFile(path.join(path.dirname(settingsFilePath()), 'preferences.json'));
  const fields = root && typeof root === 'object' && root.version === 1 && root.fields && typeof root.fields === 'object'
    ? root.fields
    : {};
  // Per-surface keys (theme mode among them) are resolved for the desktop
  // shell: its own value first, the base value otherwise.
  const values = {};
  for (const [key, entry] of Object.entries(fields)) {
    if (!entry || typeof entry !== 'object') continue;
    const own = entry.surfaces && typeof entry.surfaces === 'object' ? entry.surfaces.desktop : undefined;
    if (own && typeof own === 'object' && 'value' in own) {
      values[key] = own.value;
    } else if ('value' in entry) {
      values[key] = entry.value;
    }
  }
  return values;
};

export const readThemeSource = () => {
  const settings = { ...readSettingsRoot(), ...readPreferencesValues() };
  // themeMode is the user's intent; themeVariant is only the resolved
  // concrete appearance at persist time. When mode === 'system', we must
  // follow the OS even if variant was saved as a specific value.
  if (settings.themeMode === 'system' || settings.useSystemTheme === true) return 'system';
  if (settings.themeMode === 'light') return 'light';
  if (settings.themeMode === 'dark') return 'dark';
  if (settings.themeVariant === 'light') return 'light';
  if (settings.themeVariant === 'dark') return 'dark';
  return 'system';
};

// The UI language, for the few strings main shows before the renderer runs.
export const readPreferredLocale = () => {
  const settings = { ...readSettingsRoot(), ...readPreferencesValues() };
  return typeof settings.locale === 'string' ? settings.locale : 'en';
};

export const getWindowIconPath = () => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return undefined;
  // A Windows dev copy shows the Windows icon behind construction tape
  // (dev-icon-win.svg), like the macOS Dock's dev icon, in its taskbar, window
  // and tray. GNOME takes the dock icon from the installed app's .desktop
  // entry, whatever the window sets, so Linux keeps the usual icon.
  const devWindowsIcon = isDev && process.platform === 'win32';
  const iconFileName = devWindowsIcon ? 'dev-icon.ico' : process.platform === 'linux' ? 'icon.png' : 'icon.ico';
  const iconPath = isDev
    ? path.join(__dirname, 'resources', 'icons', iconFileName)
    : path.join(process.resourcesPath, 'icons', iconFileName);
  return fs.existsSync(iconPath) ? iconPath : undefined;
};

const readWindowState = () => {
  const stateValue = readSettingsRoot().desktopWindowState;
  return stateValue && typeof stateValue === 'object' ? stateValue : null;
};

const clampWindowBoundsToVisibleWorkArea = (bounds) => {
  const width = Math.max(MIN_RESTORE_WINDOW_WIDTH, Math.round(Number(bounds?.width) || 0));
  const height = Math.max(MIN_RESTORE_WINDOW_HEIGHT, Math.round(Number(bounds?.height) || 0));
  const x = Math.round(Number(bounds?.x));
  const y = Math.round(Number(bounds?.y));

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { width, height };
  }

  try {
    const display = screen.getDisplayMatching({ x, y, width, height }) || screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const clampedWidth = Math.min(width, Math.max(MIN_WINDOW_WIDTH, workArea.width));
    const clampedHeight = Math.min(height, Math.max(MIN_WINDOW_HEIGHT, workArea.height));
    const maxX = workArea.x + workArea.width - clampedWidth;
    const maxY = workArea.y + workArea.height - clampedHeight;

    return {
      x: clampedWidth >= workArea.width ? workArea.x : Math.min(Math.max(x, workArea.x), maxX),
      y: clampedHeight >= workArea.height ? workArea.y : Math.min(Math.max(y, workArea.y), maxY),
      width: clampedWidth,
      height: clampedHeight,
    };
  } catch {
    return { x, y, width, height };
  }
};

export const macosMajorVersion = () => {
  if (process.platform !== 'darwin') return 0;
  const result = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' });
  const raw = (result.stdout || '').trim();
  const [majorRaw, minorRaw] = raw.split('.');
  const major = Number.parseInt(majorRaw || '0', 10);
  const minor = Number.parseInt(minorRaw || '0', 10);
  return major === 10 ? minor : major;
};

let cachedMacTrafficLightPosition = null;

/**
 * Where macOS draws the window controls. The renderer sizes its titlebar per
 * macOS version around this point (`Header.tsx`, `MiniChatLayout.tsx`), so
 * change them together. macOS 26 draws 14px controls, centred in the 44px
 * titlebar: y = (44 - 14) / 2. Older releases keep the calibrated 56px layout.
 */
export const macTrafficLightPosition = () => {
  if (!cachedMacTrafficLightPosition) {
    cachedMacTrafficLightPosition = Object.freeze(macosMajorVersion() >= 26 ? { x: 14, y: 15 } : { x: 16, y: 17 });
  }
  return cachedMacTrafficLightPosition;
};

const SPLASH_DEFAULTS = { bgLight: '#FFFCF0', fgLight: '#100F0F', bgDark: '#151313', fgDark: '#CECDC3' };

const readSplashColor = (settings, key, fallback) => {
  // The renderer hands the colours over IPC (desktop_set_window_theme) and
  // main stores them under `desktopSplashColors`; the flat `splash*` keys are
  // what builds before the settings split wrote and are read as a fallback.
  const owned = settings.desktopSplashColors && typeof settings.desktopSplashColors === 'object'
    ? settings.desktopSplashColors[key]
    : undefined;
  const legacy = settings[`splash${key.charAt(0).toUpperCase()}${key.slice(1)}`];
  const value = typeof owned === 'string' ? owned : legacy;
  // Checked again on read: a value stored before the IPC check existed is
  // still interpolated into the trusted splash page.
  return isSplashColor(value) ? value : fallback;
};

const buildStartupSplashHtml = () => {
  const settings = readSettingsRoot();
  // Defaults match packages/web/index.html, which shows the same logo next
  // and must not look different: the renderer overwrites both from the theme.
  const splashBgLight = readSplashColor(settings, 'bgLight', SPLASH_DEFAULTS.bgLight);
  const splashFgLight = readSplashColor(settings, 'fgLight', SPLASH_DEFAULTS.fgLight);
  const splashBgDark = readSplashColor(settings, 'bgDark', SPLASH_DEFAULTS.bgDark);
  const splashFgDark = readSplashColor(settings, 'fgDark', SPLASH_DEFAULTS.fgDark);

  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light dark; }
      :root {
        --splash-background: ${splashBgLight};
        --splash-stroke: ${splashFgLight};
        --splash-face-fill: rgba(0, 0, 0, 0.15);
        --splash-cell-fill: rgba(0, 0, 0, 0.35);
        --splash-logo-fill: var(--splash-stroke);
      }
      body {
        margin: 0;
        font-family: "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        display: grid;
        place-items: center;
        height: 100vh;
        background: var(--splash-background);
        color: var(--splash-stroke);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --splash-background: ${splashBgDark};
          --splash-stroke: ${splashFgDark};
          --splash-face-fill: rgba(255, 255, 255, 0.15);
          --splash-cell-fill: rgba(255, 255, 255, 0.35);
        }
      }
      @supports (color: color-mix(in srgb, white 50%, transparent)) {
        :root {
          --splash-face-fill: color-mix(in srgb, var(--splash-stroke) 15%, transparent);
          --splash-cell-fill: color-mix(in srgb, var(--splash-stroke) 35%, transparent);
        }
      }
      .stack {
        display: grid;
        justify-items: center;
        /* The window is on screen in the theme colour before this document
           paints; the logo eases in over the same 0.3s the application's own
           splash takes to ease out. */
        animation: splash-logo-in 0.3s ease-out both;
      }
      @keyframes splash-logo-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
    </style>
  </head>
  <body>
    <div class="stack">
      <img src="data:image/png;base64,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" width="120" height="120" alt="灵犀智能体" draggable="false" />
    </div>
  </body>
  </html>`;
};


export const resolveMainWindowBounds = () => {
  const saved = readWindowState();
  const useSaved = Boolean(saved && typeof saved.width === 'number' && typeof saved.height === 'number');
  return {
    bounds: useSaved ? clampWindowBoundsToVisibleWorkArea(saved) : null,
    maximized: useSaved && saved.maximized === true,
  };
};

// The splash background for the theme the window will open in, so the frame
// Chromium paints before the splash never flashes a foreign colour.
export const resolveSplashBackgroundColor = (themeSource = nativeTheme.themeSource) => {
  const settings = readSettingsRoot();
  const dark = themeSource === 'dark' || (themeSource !== 'light' && nativeTheme.shouldUseDarkColors);
  return dark
    ? readSplashColor(settings, 'bgDark', SPLASH_DEFAULTS.bgDark)
    : readSplashColor(settings, 'bgLight', SPLASH_DEFAULTS.bgLight);
};

export const isMacMenuBarEnabled = () => (
  process.platform !== 'darwin' || readSettingsRoot().desktopMacMenuBarEnabled !== false
);

export const resolvePreloadPath = () => (
  isDev ? path.join(__dirname, 'preload.mjs') : path.join(app.getAppPath(), 'preload.mjs')
);

export const resolveBrowserPanelPreloadPath = () => (
  isDev ? path.join(__dirname, 'browser-panel-preload.cjs') : path.join(app.getAppPath(), 'browser-panel-preload.cjs')
);

// Arguments the preload reads from process.argv. They are fixed at window
// creation: the main window is created before the backend resolves, so it
// carries empty runtime values and receives them through the init script.
export const buildRendererAdditionalArguments = ({
  localOrigin = '',
  apiBaseUrl = '',
  clientToken = '',
  requestHeaders = {},
  bootOutcome = null,
  relayHostId = '',
  explicitRuntime = false,
  trayEnabled = isMacMenuBarEnabled(),
  nativeFrame = usesLinuxNativeFrame(),
} = {}) => [
  `--openchamber-local-origin=${localOrigin}`,
  `--openchamber-api-base-url=${apiBaseUrl}`,
  `--openchamber-client-token=${clientToken}`,
  `--openchamber-runtime-headers=${JSON.stringify(requestHeaders)}`,
  `--openchamber-home=${os.homedir() || ''}`,
  `--openchamber-macos-major=${String(macosMajorVersion())}`,
  `--openchamber-tray-enabled=${trayEnabled ? '1' : '0'}`,
  `--openchamber-boot-outcome=${JSON.stringify(bootOutcome)}`,
  `--openchamber-relay-host-id=${relayHostId}`,
  `--openchamber-explicit-runtime=${explicitRuntime ? '1' : '0'}`,
  `--openchamber-native-frame=${nativeFrame ? '1' : '0'}`,
];

// Linux can opt into the desktop environment's own title bar (Settings ->
// Desktop); it takes effect at the next start, like the window it shapes.
const usesLinuxNativeFrame = () => (
  process.platform === 'linux' && readSettingsRoot().desktopLinuxNativeFrame === true
);

export const usesFramelessChrome = () => (
  process.platform === 'win32' || (process.platform === 'linux' && !usesLinuxNativeFrame())
);

export const buildMainWindowOptions = ({ bounds, backgroundColor, additionalArguments }) => {
  const frameless = usesFramelessChrome();
  const usesCustomTitleBar = process.platform === 'darwin' || frameless;
  const options = {
    title: APP_NAME,
    width: bounds?.width ?? DEFAULT_WINDOW_WIDTH,
    height: bounds?.height ?? DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    icon: getWindowIconPath(),
    show: false,
    backgroundColor,
    frame: frameless ? false : undefined,
    autoHideMenuBar: process.platform !== 'darwin',
    // Electron's hiddenInset adds its own extra inset, which leaves the controls
    // visibly lower than the app header. Use a plain hidden title bar instead.
    titleBarStyle: usesCustomTitleBar ? 'hidden' : 'default',
    titleBarOverlay: false,
    trafficLightPosition: process.platform === 'darwin' ? macTrafficLightPosition() : undefined,
    webPreferences: {
      additionalArguments,
      preload: resolvePreloadPath(),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      // sandbox must stay off: the preload uses contextBridge + ipcRenderer
      // from Electron's Node layer. contextIsolation + nodeIntegration:false
      // keep the renderer world walled off from Node. Do NOT flip to true —
      // the preload would fail to load and the desktop bridge would be unavailable.
      sandbox: false,
    },
  };
  // Without a saved position Electron centers the window on the primary display.
  if (Number.isFinite(bounds?.x) && Number.isFinite(bounds?.y)) {
    options.x = bounds.x;
    options.y = bounds.y;
  }
  return options;
};

export const shouldUsePackagedUi = () => {
  if (process.env.OPENCHAMBER_ELECTRON_LOAD_SERVER_UI === '1') return false;
  if (process.env.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI === '1') return true;
  return app.isPackaged;
};

// The splash lives on the application's own origin whenever the application
// is served from it. A splash on a data: URL is a different origin, so the
// navigation to the application swaps renderer processes and Chromium may
// show an empty frame in between; within one origin it keeps the previous
// frame until the new document has painted.
const SPLASH_PATHNAME = '/__splash';
let packagedUiRequestHandler = null;
let packagedUiSchemeRegistered = false;

// Registered once, by whichever comes first: the early window (it loads the
// splash from this scheme) or main.mjs installing the application handler
// (a background start has no early window). The splash is answered here,
// everything else goes to that handler; nothing asks for the application
// before main is loaded, because the splash has no subresources.
const registerPackagedUiScheme = () => {
  if (packagedUiSchemeRegistered) return;
  packagedUiSchemeRegistered = true;
  protocol.handle(UI_PROTOCOL, (request) => {
    if (new URL(request.url).pathname === SPLASH_PATHNAME) {
      return new Response(buildStartupSplashHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (!packagedUiRequestHandler) return new Response('', { status: 503 });
    return packagedUiRequestHandler(request);
  });
};

export const installPackagedUiRequestHandler = (handler) => {
  packagedUiRequestHandler = handler;
  registerPackagedUiScheme();
};

export const buildStartupSplashUrl = () => (
  shouldUsePackagedUi()
    ? `${UI_PROTOCOL}://app${SPLASH_PATHNAME}`
    : `data:text/html;charset=utf-8,${encodeURIComponent(buildStartupSplashHtml())}`
);

const EARLY_WINDOW_SHOW_WAIT_MS = 500;
let pendingEarlyWindow = null;
let earlyWindowClosed = false;

// True once the user closed the first window before main.mjs adopted it: the
// app is quitting, and main must not open another window on its way out.
export const wasEarlyWindowClosed = () => earlyWindowClosed;

// Creates and shows the main window on the splash. Called from the entry
// module the moment Electron is ready; `main.mjs` adopts it later.
export const createEarlyWindow = () => {
  nativeTheme.themeSource = readThemeSource();
  if (shouldUsePackagedUi()) registerPackagedUiScheme();
  const { bounds, maximized } = resolveMainWindowBounds();
  const browserWindow = new BrowserWindow(buildMainWindowOptions({
    bounds,
    backgroundColor: resolveSplashBackgroundColor(),
    additionalArguments: buildRendererAdditionalArguments(),
  }));
  recordEarlyStartupMark('electron.window.created');
  if (maximized) browserWindow.maximize();
  // Shown at once in the theme colour, so the first thing on screen appears
  // before the splash document has painted; the logo then fades in.
  browserWindow.show();
  browserWindow.focus();
  let markShown;
  const early = {
    browserWindow,
    maximized,
    // Resolves once the splash document has painted; bounded, because a
    // renderer that never reports ready-to-show must not hold the rest of startup.
    whenShown: new Promise((resolve) => {
      const timer = setTimeout(resolve, EARLY_WINDOW_SHOW_WAIT_MS);
      markShown = () => {
        clearTimeout(timer);
        resolve();
      };
    }),
  };
  browserWindow.once('ready-to-show', () => {
    recordEarlyStartupMark('electron.window.ready-to-show', { documentClass: 'splash' });
    markShown();
  });
  // Closing the only window before the rest of the app has adopted it is a quit.
  browserWindow.once('closed', () => {
    if (pendingEarlyWindow !== early) return;
    pendingEarlyWindow = null;
    earlyWindowClosed = true;
    app.quit();
  });
  recordEarlyStartupMark('electron.navigation.start', { documentClass: 'splash' });
  browserWindow.loadURL(buildStartupSplashUrl()).then(() => {
    recordEarlyStartupMark('electron.navigation.ready', { documentClass: 'splash' });
  }).catch(() => {
    // The main module navigates the window to the application as soon as the
    // backend resolves, which aborts a splash still loading.
  });
  pendingEarlyWindow = early;
  return early;
};

export const takeEarlyWindow = () => {
  const early = pendingEarlyWindow;
  pendingEarlyWindow = null;
  return early && !early.browserWindow.isDestroyed() ? early : null;
};

// App events that can fire before `main.mjs` has registered its handlers: a
// deep link the app was launched with, or a second launch during startup.
// Buffered here and replayed by the main module once it takes them.
const deferredAppEvents = [];
const onEarlyOpenUrl = (event, url) => {
  event.preventDefault();
  deferredAppEvents.push({ type: 'open-url', url });
};
const onEarlySecondInstance = (_event, argv) => {
  deferredAppEvents.push({ type: 'second-instance', argv });
};

export const deferAppEventsUntilMainLoads = () => {
  app.on('open-url', onEarlyOpenUrl);
  app.on('second-instance', onEarlySecondInstance);
};

export const takeDeferredAppEvents = () => {
  app.off('open-url', onEarlyOpenUrl);
  app.off('second-instance', onEarlySecondInstance);
  return deferredAppEvents.splice(0);
};

const queryWindowsRegistryValue = (key, name) => {
  const result = spawnSync('reg.exe', ['query', key, '/v', name], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) return '';
  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.toLowerCase().startsWith(name.toLowerCase()));
  if (!line) return '';
  const match = line.match(/^\S+\s+REG_\S+\s+(.+)$/);
  return match?.[1]?.trim() || '';
};

const expandWindowsEnvRefs = (value) => String(value || '').replace(/%([^%]+)%/g, (_match, key) => process.env[key] || '');

const loadWindowsEnv = () => {
  const machinePath = queryWindowsRegistryValue('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path');
  const userPath = queryWindowsRegistryValue('HKCU\\Environment', 'Path');
  const homeDir = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const commonPaths = [
    path.join(homeDir, '.opencode', 'bin'),
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, '.local', 'bin'),
    path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin'),
    path.join(localAppData, 'Programs', 'Cursor', 'resources', 'app', 'bin'),
    path.join(appData, 'npm'),
  ];
  return {
    PATH: [machinePath, userPath, process.env.PATH, ...commonPaths]
      .map(expandWindowsEnvRefs)
      .filter(Boolean)
      .join(path.delimiter),
  };
};

// Finder-launched apps on macOS inherit a minimal PATH (no /opt/homebrew, mise, asdf, etc.).
// One shared probe that the backend awaits before it starts. The entry module
// starts it as early as it can so the user's shell startup files run while
// the window comes up instead of on the critical path; on Windows the loader
// is synchronous registry reads, so it waits until the splash is on screen.
export const shellEnvironmentAbort = new AbortController();
const loadShellEnv = createShellEnvironmentLoader({ loadWindowsEnv, signal: shellEnvironmentAbort.signal });

export const shellEnvironmentProbeBlocksMainThread = process.platform === 'win32';

// Clear before probing/merging so login-shell snapshots and children never
// inherit the AppImage path as argv[0] via zsh's ARGV0 parameter (#2588).
export const startShellEnvironmentProbe = () => {
  clearAppImageArgv0FromProcessEnv();
  return loadShellEnv();
};
