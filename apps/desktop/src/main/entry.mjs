import { app } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDesktop } from './main.mjs';

const runtimeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

startDesktop({ runtimeRoot }).then((desktop) => {
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    desktop.close().finally(() => app.exit(0));
  });
  if (process.env.SUPERWAGIE_SMOKE === '1') setTimeout(() => app.quit(), 500);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
