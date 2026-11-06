import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { excalidrawChildEnvironment } from './excalidraw-runtime.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'excalidraw 中文 ')); roots.push(root);
  const driver = path.join(root, 'superweb/vendor/node_modules/playwright-core');
  const python = path.join(root, 'hy-memory/runtime/bin/python3');
  await fs.mkdir(driver, { recursive: true }); await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.writeFile(path.join(driver, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.64.1' }));
  for (const name of ['index.mjs', 'LICENSE', 'NOTICE']) await fs.writeFile(path.join(driver, name), 'fixture');
  await fs.writeFile(python, '', { mode: 0o755 });
  return { root, driver, python, options: { resourcesPath: root, executable: process.execPath, electron: true, platform: 'darwin' } };
}
it('binds only the owned physical driver and interpreter with captured Electron', async () => {
  const { driver, python, options } = await fixture();
  expect(await excalidrawChildEnvironment(options)).toEqual({
    SUPERWAGIE_EXCALIDRAW_NODE: process.execPath, SUPERWAGIE_EXCALIDRAW_NODE_MODE: 'electron',
    SUPERWAGIE_EXCALIDRAW_PLAYWRIGHT: driver, SUPERWAGIE_EXCALIDRAW_PYTHON: python,
  });
});
it('fails the managed preview binding when the driver is missing or has a foreign identity', async () => {
  const { driver, options } = await fixture();
  for (const manifest of [{ name: 'other', version: '1.64.1' }, { name: 'playwright-core', version: '1.62.0' }]) {
    await fs.writeFile(path.join(driver, 'package.json'), JSON.stringify(manifest));
    expect((await excalidrawChildEnvironment(options)).SUPERWAGIE_EXCALIDRAW_NODE_MODE).toBe('unavailable');
  }
  await fs.rm(driver, { recursive: true });
  expect((await excalidrawChildEnvironment(options)).SUPERWAGIE_EXCALIDRAW_NODE_MODE).toBe('unavailable');
});
it('refuses a driver link escaping the resource owner', async () => {
  const first = await fixture(); const foreign = await fixture();
  await fs.rm(first.driver, { recursive: true }); await fs.symlink(foreign.driver, first.driver, 'dir');
  expect((await excalidrawChildEnvironment(first.options)).SUPERWAGIE_EXCALIDRAW_NODE_MODE).toBe('unavailable');
});
it('leaves a standalone host without an owned complete binding on its standalone route', async () => {
  expect(await excalidrawChildEnvironment({ serverDirectory: '/missing/server', executable: process.execPath, electron: false })).toEqual({});
});
