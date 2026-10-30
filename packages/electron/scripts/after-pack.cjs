const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyPackagedAppContents } = require('./packaged-app-contents.cjs');
const { Arch } = require('electron-builder');
const { verifyHyMemoryResources } = require('./prepare-hy-memory.mjs');

const plistSet = (plistPath, key, value) => {
  execFileSync('plutil', ['-replace', key, '-string', value, plistPath], { stdio: 'inherit' });
};
const plistGet = (plistPath, key) => execFileSync('plutil', ['-extract', key, 'raw', plistPath], { encoding: 'utf8' }).trim();

/**
 * macOS takes the application menu's title from CFBundleName, not from the
 * menu template. Electron also locates its helper bundles by that name, so the
 * helpers are renamed with it instead of leaving the app unable to start.
 * This keeps the bundle itself (犇马.app) for Finder while the menu bar
 * reads SuperWagie.
 */
const useEnglishMenuName = (appPath, productFilename) => {
  const contents = path.join(appPath, 'Contents');
  const infoPlist = path.join(contents, 'Info.plist');
  plistSet(infoPlist, 'CFBundleName', 'SuperWagie');
  plistSet(infoPlist, 'CFBundleDisplayName', 'SuperWagie');

  const frameworks = path.join(contents, 'Frameworks');
  if (!fs.existsSync(frameworks)) return;
  for (const entry of fs.readdirSync(frameworks)) {
    if (!entry.startsWith(`${productFilename} Helper`) || !entry.endsWith('.app')) continue;
    const oldBase = entry.slice(0, -4);
    const newBase = oldBase.replace(productFilename, 'SuperWagie');
    const oldApp = path.join(frameworks, entry);
    const newApp = path.join(frameworks, `${newBase}.app`);
    fs.renameSync(oldApp, newApp);

    const helperPlist = path.join(newApp, 'Contents', 'Info.plist');
    plistSet(helperPlist, 'CFBundleName', newBase);
    plistSet(helperPlist, 'CFBundleDisplayName', newBase);

    const oldExecutable = plistGet(helperPlist, 'CFBundleExecutable');
    const newExecutable = oldExecutable.replace(productFilename, 'SuperWagie');
    if (newExecutable !== oldExecutable) {
      const macos = path.join(newApp, 'Contents', 'MacOS');
      fs.renameSync(path.join(macos, oldExecutable), path.join(macos, newExecutable));
      plistSet(helperPlist, 'CFBundleExecutable', newExecutable);
    }
  }
};

module.exports = (context) => {
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const remoteClient = context.packager?.config?.extraMetadata?.superwagieClientMode === 'remote-client';
  if (remoteClient && (context.electronPlatformName !== 'darwin' || Arch[context.arch] !== 'x64')) {
    throw new Error('Remote compatibility packaging requires macOS x64');
  }
  verifyPackagedAppContents(resourcesPath, { remoteClient });
  if (!remoteClient) verifyHyMemoryResources(path.join(resourcesPath, 'hy-memory'), { target: `${context.electronPlatformName}-${Arch[context.arch]}` });
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  useEnglishMenuName(appPath, context.packager.appInfo.productFilename);

  const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

  // The .icns already carries the rounded icon. A cached asset catalog would
  // take precedence in the Dock and keep the old square mark, so only copy one
  // when this build actually generated it.
  if (fs.existsSync(sourceAssetsPath)) {
    fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
  }
};
