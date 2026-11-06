import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const EXCALIDRAW_ENV_KEYS = ['SUPERWAGIE_EXCALIDRAW_NODE', 'SUPERWAGIE_EXCALIDRAW_NODE_MODE', 'SUPERWAGIE_EXCALIDRAW_PLAYWRIGHT', 'SUPERWAGIE_EXCALIDRAW_PYTHON'];
const driverIdentity = z.object({ name: z.literal('playwright-core'), version: z.literal('1.64.1') });
const unavailable = () => Object.fromEntries(EXCALIDRAW_ENV_KEYS.map((key) => [key, key.endsWith('_NODE_MODE') ? 'unavailable' : '']));

async function ownedFile(root, relative, executable = false) {
  const filename = path.join(root, relative);
  const resolvedRoot = await fs.realpath(root);
  const resolved = await fs.realpath(filename);
  const inside = path.relative(resolvedRoot, resolved);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside) || resolved.split(path.sep).includes('app.asar')) throw new Error('Excalidraw runtime escapes its physical owner');
  if (!(await fs.stat(resolved)).isFile()) throw new Error('Excalidraw runtime file is missing');
  if (executable && process.platform !== 'win32') await fs.access(resolved, fs.constants.X_OK);
  return filename;
}

export async function excalidrawChildEnvironment({ serverDirectory, resourcesPath, executable = process.execPath, electron = Boolean(process.versions.electron), platform = process.platform, pythonExecutable } = {}) {
  let owner = resourcesPath;
  // A source checkout can reuse its already prepared desktop resources.
  if (electron && serverDirectory && !serverDirectory.split(path.sep).includes('app.asar') && !await fs.stat(path.join(owner || '', 'superweb')).catch(() => null)) {
    owner = path.resolve(serverDirectory, '../../electron/resources');
  }
  if (!electron && !pythonExecutable) return {};
  try {
    if (!path.isAbsolute(executable) || !(await fs.stat(executable)).isFile()) throw new Error('Application executable unavailable');
    const driverOwner = electron ? owner : path.join(serverDirectory, 'builtin-skills/skills/superweb');
    if (!driverOwner || !(await fs.lstat(driverOwner)).isDirectory()) throw new Error('Owned runtime unavailable');
    let relative = electron ? 'superweb/vendor/node_modules/playwright-core' : 'vendor/node_modules/playwright-core';
    if (!electron && !await fs.stat(path.join(driverOwner, relative)).catch(() => null)) relative = 'node_modules/playwright-core';
    let current = driverOwner;
    for (const segment of relative.split('/')) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Driver must be a physical owned directory');
    }
    const driver = path.join(driverOwner, relative);
    driverIdentity.parse(JSON.parse(await fs.readFile(await ownedFile(driverOwner, `${relative}/package.json`), 'utf8')));
    for (const file of ['index.mjs', 'LICENSE', 'NOTICE']) await ownedFile(driver, file);
    const python = electron
      ? await ownedFile(owner, `hy-memory/runtime/${platform === 'win32' ? 'python.exe' : 'bin/python3'}`, true)
      : pythonExecutable;
    if (!path.isAbsolute(python) || !(await fs.stat(python)).isFile()) throw new Error('Python unavailable');
    return { SUPERWAGIE_EXCALIDRAW_NODE: executable, SUPERWAGIE_EXCALIDRAW_NODE_MODE: electron ? 'electron' : 'node', SUPERWAGIE_EXCALIDRAW_PLAYWRIGHT: driver, SUPERWAGIE_EXCALIDRAW_PYTHON: python };
  } catch { return unavailable(); }
}
