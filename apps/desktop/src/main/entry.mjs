import { app } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDesktop } from './main.mjs';
import { isBackgroundUiTest } from './test-launch-policy.mjs';

const runtimeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const testMode = !app.isPackaged && process.env.SUPERWAGIE_TEST_MODE === '1';
const backgroundTest = isBackgroundUiTest(app.isPackaged, process.env);
if (backgroundTest && process.platform === 'darwin') app.setActivationPolicy('accessory');
if (testMode && process.env.SUPERWAGIE_TEST_PROFILE) {
  app.setPath('userData', process.env.SUPERWAGIE_TEST_PROFILE);
}

startDesktop({
  runtimeRoot,
  show: !backgroundTest,
  ...(testMode && process.env.SUPERWAGIE_TEST_STATE
    ? { stateRoot: process.env.SUPERWAGIE_TEST_STATE }
    : {}),
  ...(testMode && process.env.SUPERWAGIE_TEST_PROJECT
    ? { testProjectPath: process.env.SUPERWAGIE_TEST_PROJECT }
    : {}),
}).then((desktop) => {
  if (testMode) globalThis.__superwagieTestDesktop = desktop;
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    desktop.close().then((closed) => {
      if (closed) app.exit(0);
      else quitting = false;
    }).catch((error) => {
      console.error(error);
      quitting = false;
    });
  });
  if (process.env.SUPERWAGIE_SMOKE === '1') setTimeout(() => app.quit(), 500);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
