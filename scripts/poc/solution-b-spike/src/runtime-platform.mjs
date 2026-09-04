import { join } from 'node:path';

export function runtimePlatform(platform = process.platform, architecture = process.arch) {
  if (platform === 'win32' && architecture === 'x64') {
    return {
      id: 'windows-11-x64',
      fixture: 'G0-SHELL-002-WINDOWS-SPIKE',
      archive: 'electron-v44.1.0-win32-x64.zip',
      candidateElectronRoot: 'Electron',
      candidateElectron: 'Electron/electron.exe',
      developmentElectron: ['node_modules', 'electron', 'dist', 'electron.exe'],
      coreDebug: ['core', 'target', 'debug', 'solution-b-core.exe'],
      coreRelease: ['core', 'target', 'release', 'solution-b-core.exe'],
      processNames: { electron: 'electron.exe', core: 'solution-b-core.exe' },
    };
  }
  if (platform === 'darwin' && architecture === 'arm64') {
    return {
      id: 'macos-15-arm64',
      fixture: 'G0-SHELL-002-MACOS-SPIKE',
      archive: 'electron-v44.1.0-darwin-arm64.zip',
      candidateElectronRoot: 'Electron.app',
      candidateElectron: 'Electron.app/Contents/MacOS/Electron',
      developmentElectron: ['node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'],
      coreDebug: ['core', 'target', 'debug', 'solution-b-core'],
      coreRelease: ['core', 'target', 'release', 'solution-b-core'],
      processNames: { electron: 'Electron', core: 'solution-b-core' },
    };
  }
  throw new Error(`unsupported Solution B validation platform: ${platform}-${architecture}`);
}

export const joinRuntimePath = (root, parts) => join(root, ...parts);
