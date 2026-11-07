export const resolveElectronDevMode = (env = {}) => {
  const requestedBundledUi = env.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI === '1';
  const requestedHmr = env.OPENCHAMBER_ELECTRON_AUTO_START_HMR === '1';
  const startHmr = requestedHmr && !requestedBundledUi;

  return {
    startHmr,
    useBundledUi: requestedBundledUi || !startHmr,
  };
};
import fs from 'node:fs';
import path from 'node:path';
import { prepareDesktopOpenCodeEnvironment } from '../web/server/lib/opencode/desktop-private-runtime.js';


export const resolveElectronDevEnvironment = ({ env, electronDir }) => {
  const directory = path.join(electronDir, 'resources', 'opencode-cli');
  const binary = path.join(directory, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  if (!fs.existsSync(binary)) {
    throw new Error(`[electron:dev] bundled OpenCode CLI missing at ${binary}. Run bun run --cwd packages/electron prepare:opencode-cli to stage it.`);
  }
  return prepareDesktopOpenCodeEnvironment({ env: { ...env, OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR: directory } });
};
