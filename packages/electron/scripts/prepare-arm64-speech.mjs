import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMacSpeech } from './macos-speech-build.mjs';
import { resolveTargetArchitecture } from './target-architecture.mjs';

export const arm64SpeechProfile = {
  arch: 'arm64', minimumMacOS: '13.0',
  electronVersion: '44.9.3', electronDependency: '^44.9.3', electronAbi: '149',
  originalAddonSha256: 'e37e09b2b21e0b07abf0c37d7423884a8ff161fdba8c67407bc99bfe99af8a55',
  headersSha256: '5f75ae1e70e69442c9d23f7d984e8ca211e49c5bee2298ca2d84d3c75c640710',
  libraryHashes: {
    'libonnxruntime.dylib': 'b0613d0ae53199a83b05fa48e169211498e9d40d54beaa372068ebe5ec5b0929',
    'libsherpa-onnx-c-api.dylib': '6baf16572b925c6d4722a3ffdb7d34c3de6477ba6e587baf8c4573cc3f889ca1',
    'libsherpa-onnx-cxx-api.dylib': '370e7b9e4a198dde7d07390c4aa8a49b0840974271065632fbacbde99a1a615c',
  },
  cacheRelativePath: '.cache/arm64-compat/speech', receiptName: 'arm64-speech.json',
};

export function shouldPrepareArm64Speech({ platform = process.platform, hostArchitecture = process.arch, environment = process.env, builderArgs = [] } = {}) {
  return platform === 'darwin' && resolveTargetArchitecture({ platform, hostArchitecture, environment, builderArgs }).node === 'arm64';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (shouldPrepareArm64Speech({ builderArgs: process.argv.slice(2) })) prepareMacSpeech(arm64SpeechProfile);
    else console.log('[electron] ARM64 speech preparation skipped for this target.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
