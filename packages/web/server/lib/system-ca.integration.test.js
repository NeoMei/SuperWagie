import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const run = promisify(execFile);

test.skipIf(process.platform === 'win32')('a Node child trusts the added CA for real loopback TLS requests', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-system-ca-'));
  try {
    const key = path.join(directory, 'key.pem');
    const cert = path.join(directory, 'cert.pem');
    const config = path.join(directory, 'openssl.cnf');
    await fs.writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', config], { timeout: 10_000 });
    const source = `
      import tls from 'node:tls';
      import https from 'node:https';
      import fs from 'node:fs';
      import { applySystemCertificates } from ${JSON.stringify(new URL('./system-ca.js', import.meta.url).href)};
      const certificate = fs.readFileSync(${JSON.stringify(cert)}, 'utf8');
      const server = https.createServer({ key: fs.readFileSync(${JSON.stringify(key)}), cert: certificate }, (_req, res) => res.end('trusted'));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const url = 'https://127.0.0.1:' + server.address().port;
        let rejectedBefore = false;
        try { await fetch(url); } catch { rejectedBefore = true; }
        const added = applySystemCertificates({ tlsModule: {
          getCACertificates: store => store === 'system' ? [certificate] : tls.getCACertificates(store),
          setDefaultCACertificates: certificates => tls.setDefaultCACertificates(certificates),
        }, execArgv: [], nodeOptions: '' });
        const body = await (await fetch(url)).text();
        console.log(JSON.stringify({ rejectedBefore, added, body }));
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    `;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', source], {
      cwd: directory, env: { PATH: process.env.PATH }, timeout: 10_000,
    });
    expect(JSON.parse(stdout.trim())).toEqual({ rejectedBefore: true, added: true, body: 'trusted' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
