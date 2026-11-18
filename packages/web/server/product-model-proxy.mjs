import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createModelBootstrapStore } from './lib/model-configuration/bootstrap-store.js';
import { createProductModelProxy } from './lib/platform-account/product-model-proxy.js';

const configFile = process.argv[2];
if (!configFile) throw new Error('Pass the isolated product model proxy configuration file');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const serviceCredential = readFileSync(config.serviceCredentialFile, 'utf8').trim();
const app = createProductModelProxy({
  api: config.uniHubOrigin,
  gateway: config.modelGateway,
  allowedModels: config.allowedModels,
  instanceId: config.instanceId,
  serviceCredential,
  vault: createModelBootstrapStore({ dataDir: config.vaultPath }),
});
if (Boolean(config.tlsKeyFile) !== Boolean(config.tlsCertificateFile)) throw new Error('Provide both the TLS key and certificate');
const tls = config.tlsKeyFile && config.tlsCertificateFile;
const host = config.host ?? '127.0.0.1';
if (!tls && !['127.0.0.1', '::1'].includes(host)) throw new Error('A non-loopback product proxy requires TLS');
const server = tls
  ? createSecureServer({ key: readFileSync(config.tlsKeyFile), cert: readFileSync(config.tlsCertificateFile) }, app)
  : createServer(app);
server.listen(config.port ?? 9443, host);
