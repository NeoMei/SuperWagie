import { join } from 'node:path';

export function resolveElectronBinary(root, platform = process.platform) {
  const relativeBinary = {
    darwin: 'Electron.app/Contents/MacOS/Electron',
    linux: 'electron',
    win32: 'electron.exe',
  }[platform];
  if (!relativeBinary) throw new Error(`Unsupported Electron platform: ${platform}`);
  return join(root, 'node_modules/electron/dist', relativeBinary);
}
