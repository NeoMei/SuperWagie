import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const env = { ...process.env };
const adhoc = process.argv.includes('--adhoc');
const builderArgs = process.argv.slice(2).filter(argument => argument !== '--adhoc');
const targetArchitecture = resolveTargetArchitecture({ environment: env, builderArgs });

if (adhoc && (process.platform !== 'darwin' || builderArgs.some(argument => (
  ['--win', '--windows', '-w', '--linux', '-l'].includes(argument.split('=')[0])
)))) {
  throw new Error('--adhoc requires a macOS build on macOS.');
}

if (process.platform === 'darwin') {
  const signingHooks = fileURLToPath(new URL('./macos-signing.cjs', import.meta.url));
  env.SUPERWAGIE_MACOS_ADHOC = adhoc ? '1' : '0';
  builderArgs.push(`--config.afterPack=${signingHooks}`, `--config.afterAllArtifactBuild=${signingHooks}`);
  if (adhoc) {
    builderArgs.push('--config.mac.identity=-', '--config.forceCodeSigning=true', '--config.mac.strictVerify=true', '--publish=never');
    console.log('[electron] Ad-hoc signing enabled. This build is not notarized; macOS may still block downloaded copies.');
  }
}

if (process.platform === 'win32' && !env.CSC_LINK && !env.WINDOWS_CSC_LINK) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  console.log('[electron] Windows code signing disabled; building unsigned installer.');
}

const bunBinaryCandidates = [
  process.env.npm_execpath,
  process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun') : null,
  process.platform === 'win32' ? 'bun.exe' : 'bun',
].filter(Boolean);

const bunBinary = bunBinaryCandidates.find((candidate) => {
  if (path.basename(candidate).toLowerCase().startsWith('bun')) {
    return candidate === 'bun' || candidate === 'bun.exe' || fs.existsSync(candidate);
  }
  return false;
}) || (process.platform === 'win32' ? 'bun.exe' : 'bun');

if (process.platform === 'linux' && !builderArgs.some((argument) => (
  argument === '--x64' || argument === '--arm64' || argument === '--arch' || argument.startsWith('--arch=')
))) {
  builderArgs.push(`--${targetArchitecture.electronBuilder}`);
}

const child = spawn(bunBinary, ['x', 'electron-builder', ...builderArgs], {
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error('[electron] failed to start electron-builder:', error);
  process.exit(1);
});
