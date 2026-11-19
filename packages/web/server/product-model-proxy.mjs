import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { createModelBootstrapStore } from './lib/model-configuration/bootstrap-store.js';
import { createProductModelProxy } from './lib/platform-account/product-model-proxy.js';
import { acquireModelWriterLock } from './lib/platform-model/writer-lock.js';

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
await mkdir(config.vaultPath, { recursive: true, mode: 0o700 });
if (!(await lstat(config.vaultPath)).isDirectory()) throw new Error('Product model vault requires a private directory');
const releaseVault = await acquireModelWriterLock(config.vaultPath);
server.once('close', () => { void releaseVault().catch(() => { process.exitCode = 1; }); });
server.listen(config.port ?? 9443, host);
