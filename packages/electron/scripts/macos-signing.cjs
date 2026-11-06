const path = require('node:path');
const { execFileSync } = require('node:child_process');

const applications = new Set();

function prepareMacSigning(context, adhoc) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.resolve(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (adhoc) {
    const mac = context.packager.platformSpecificBuildOptions;
    if (mac.identity !== '-') throw new Error('Ad-hoc packaging requires the explicit ad-hoc signing identity.');
    // These payloads have staged hash receipts. The outer seal covers them as
    // data; Electron frameworks, helper bundles and the launcher are still signed.
    const resources = path.join(appPath, 'Contents', 'Resources').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    mac.signIgnore = [...(Array.isArray(mac.signIgnore) ? mac.signIgnore : [mac.signIgnore].filter(Boolean)), `^${resources}(?:/|$)`];
  }
  applications.add(appPath);
}

async function afterPack(context) {
  await require('./after-pack.cjs')(context);
  prepareMacSigning(context, process.env.SUPERWAGIE_MACOS_ADHOC === '1');
}

function afterAllArtifactBuild(result) {
  const hasMacTarget = [...result.platformToTargets.keys()].some(platform => platform.nodeName === 'darwin');
  if (!hasMacTarget) return [];
  if (applications.size === 0) throw new Error('No macOS application was recorded for final signature verification.');
  for (const app of applications) {
    try {
      execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { encoding: 'utf8', timeout: 120_000 });
    } catch (error) {
      throw new Error(`macOS signature verification failed for ${app}`, { cause: error });
    }
  }
  applications.clear();
  return [];
}

module.exports = { prepareMacSigning, afterPack, afterAllArtifactBuild };
