import { afterEach, describe, expect, mock, test } from 'bun:test';

/**
 * The authenticated root starts a slow home read. A second caller must share
 * that read instead of starting another one.
 */

const HOME = '/home/user';
const CHATS_ROOT = '/home/user/.config/openchamber/chats';

const storage = new Map<string, string>();
const testLocalStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, String(value));
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
  key: () => null,
  length: 0,
} satisfies Storage;

interface TestWindow {
  localStorage: Storage;
  matchMedia: () => { matches: boolean };
  addEventListener: () => void;
  removeEventListener: () => void;
}

const setTestWindow = (value: TestWindow | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'localStorage');
    return;
  }
  Object.defineProperty(globalThis, 'window', { value, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: value.localStorage, configurable: true, writable: true });
};

let homeReads = 0;
let answerPageLoadRead: () => void = () => undefined;
const directoriesSet: string[] = [];

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: (directory: string) => {
      directoriesSet.push(directory);
    },
    getDirectory: () => directoriesSet.at(-1) ?? '/',
    getFilesystemHome: async () => {
      homeReads += 1;
      if (homeReads > 1) throw new Error('a second read must not happen');
      await new Promise<void>((resolve) => {
        answerPageLoadRead = resolve;
      });
      return HOME;
    },
    getSystemInfo: async () => {
      throw new Error('a second source must not be asked');
    },
    getFilesystemHomeInfo: async () => ({ home: HOME, chatsRoot: CHATS_ROOT }),
  },
}));

mock.module('@/lib/desktop', () => ({
  getDesktopHomeDirectory: async () => null,
  isVSCodeRuntime: () => false,
  isDesktopShell: () => false,
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: async () => undefined,
}));

mock.module('@/lib/runtime-switch', () => ({
  subscribeRuntimeEndpointChanged: () => () => undefined,
  getRuntimeApiBaseUrl: () => 'http://127.0.0.1:9',
  getRuntimeKey: () => 'test',
}));

mock.module('@/stores/useFileSearchStore', () => ({
  useFileSearchStore: {
    getState: () => ({ clearCache: () => undefined, invalidateDirectory: () => undefined }),
  },
}));

describe('home directory read still in flight when the gate asks for it', () => {
  afterEach(() => {
    setTestWindow(undefined);
  });

  test('shares an authenticated read and does not start a read at module load', async () => {
    setTestWindow({
      localStorage: testLocalStorage,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    // A browser has no process environment to fall back on; bun test does.
    // Scrub every variable the store reads for the process home: HOME on
    // POSIX, and USERPROFILE / HOMEDRIVE+HOMEPATH on Windows. Leaving the
    // Windows pair behind makes the store bootstrap on the real Windows home.
    const savedEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      HOMEDRIVE: process.env.HOMEDRIVE,
      HOMEPATH: process.env.HOMEPATH,
    };
    const savedCwd = process.cwd;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;
    process.cwd = () => '';
    const { ensureHomeDirectoryResolved, useDirectoryStore } = await import('@/stores/useDirectoryStore').finally(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      process.cwd = savedCwd;
    });
    expect(useDirectoryStore.getState().isHomeReady).toBe(false);
    expect(homeReads).toBe(0);

    const ensured = ensureHomeDirectoryResolved();
    const shared = ensureHomeDirectoryResolved();
    answerPageLoadRead();
    await Promise.all([ensured, shared]);

    expect(useDirectoryStore.getState()).toMatchObject({ homeDirectory: HOME, currentDirectory: CHATS_ROOT, isHomeReady: true });
    expect(homeReads).toBe(1);
  });
});
