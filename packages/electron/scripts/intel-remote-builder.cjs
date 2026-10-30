const { build } = require('../package.json');

// This is an opt-in remote client. It keeps the JS helpers imported by main,
// while local services and their platform binaries remain on the remote host.
module.exports = {
  ...build,
  extraMetadata: { superwagieClientMode: 'remote-client' },
  files: [
    ...build.files,
    '!**/node_modules/{node-pty,bun-pty,sherpa-onnx*,@sherpa-onnx}{,/**}',
    '!**/node_modules/**/*.{node,dylib,dll,so,exe,a}',
  ],
  extraResources: [
    ...build.extraResources.filter(resource => ['web-dist', 'icons/icon.ico', 'icons/icon.png', 'icons/tray'].includes(resource.to)),
    { from: 'scripts/remote-client-mode.json', to: 'desktop-mode.json' },
  ],
  mac: { ...build.mac, minimumSystemVersion: '12.0' },
};
