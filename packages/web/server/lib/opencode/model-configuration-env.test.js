import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelConfigurationChildEnvironment } from './model-configuration-env.js';

describe('model configuration child environment', () => {
  it('scopes skill resolution to the active server data directory without copying credentials', () => {
    expect(modelConfigurationChildEnvironment({ serverDirectory: '/app/server', dataDir: '/profile/remote', execPath: '/runtime/node' }))
      .toEqual({
        OPENCHAMBER_DATA_DIR: '/profile/remote',
        SUPERWAGIE_MODEL_NODE: '/runtime/node',
        SUPERWAGIE_MODEL_RESOLVER: path.join('/app/server', 'lib/model-configuration/resolve-cli.js'),
      });
  });

  it('uses the unpacked standalone resolver when the server is inside an asar archive', () => {
    const serverDirectory = path.join('/app', 'app.asar', 'node_modules/@openchamber/web/server');
    const env = modelConfigurationChildEnvironment({ serverDirectory, dataDir: '/profile', execPath: '/app/Electron' });
    expect(env.SUPERWAGIE_MODEL_RESOLVER).toBe(path.join('/app', 'app.asar.unpacked', 'node_modules/@openchamber/web/server/generated/model-resolver.mjs'));
    expect(env.SUPERWAGIE_MODEL_NODE).toBe('/app/Electron');
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('passes the allocated OpenCode listener to the private resolver with a concrete reachable host', () => {
    const env = modelConfigurationChildEnvironment({ serverDirectory: '/server', dataDir: '/profile', openCodePort: 43001, openCodeHostname: '::' });
    expect(env.SUPERWAGIE_MODEL_OPENCODE_URL).toBe('http://127.0.0.1:43001');
    const ipv6 = modelConfigurationChildEnvironment({ serverDirectory: '/server', dataDir: '/profile', openCodePort: 43002, openCodeHostname: '::1' });
    expect(ipv6.SUPERWAGIE_MODEL_OPENCODE_URL).toBe('http://[::1]:43002');
  });
});
