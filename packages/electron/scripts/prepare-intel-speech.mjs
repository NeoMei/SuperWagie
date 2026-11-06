import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMacSpeech } from './macos-speech-build.mjs';

export const intelSpeechProfile = {
  arch: 'x64', minimumMacOS: '12.0', appVersion: '2.7.40-intel',
  electronVersion: '43.8.4', electronDependency: '43.8.4', electronAbi: '148',
  originalAddonSha256: '73bd986df350a4dda71f081d898aa4bc6ef3f4e105c025b92a4e766360f07972',
  headersSha256: 'cccb253b87b50b5957d8bab8c80abaca744cae779a5aba8e4184fbcc087c9dbb',
  libraryHashes: {
    'libonnxruntime.dylib': '2bf27180c09e6fd3f407c9ab25205ebf1ff95f2d53bfa35e35409b5849e0ac70',
    'libsherpa-onnx-c-api.dylib': '7e9a3df88aed001c9dba2f2bdeceac6045613b6c573bd0223e92b898a04bf283',
    'libsherpa-onnx-cxx-api.dylib': 'e30ba3a85aaa3c235d94dbe10bc21889eed817a39f0b4b8fe7f62693cecb3978',
  },
  cacheRelativePath: '.cache/intel-compat/speech', receiptName: 'intel-speech.json',
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { prepareMacSpeech(intelSpeechProfile); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
