import crypto from 'node:crypto';
import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { readConfiguredVideoFromDisk } from './resolve-cli.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('reads an owned video status and verifies the bounded MP4 from the private broker', async () => {
  const bytes = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    requests.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
    if (req.url === '/media/video/status') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ callID: 'video_1', status: 'SUCCESS', settlement: 'SETTLED' })); return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'x-content-sha256': sha256 }); res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const environment = { OPENCHAMBER_UNIHUB_PROXY_URL: `http://127.0.0.1:${server.address().port}`, OPENCHAMBER_UNIHUB_PROXY_TOKEN: 'broker-secret' };
  expect(await readConfiguredVideoFromDisk({ sessionID: 'ses_1', callID: 'video_1' }, { environment })).toEqual({ callID: 'video_1', status: 'SUCCESS', settlement: 'SETTLED' });
  expect(await readConfiguredVideoFromDisk({ sessionID: 'ses_1', callID: 'video_1' }, { environment, result: true })).toEqual({ video: bytes.toString('base64'), contentType: 'video/mp4', sha256 });
  expect(requests).toEqual(['/media/video/status', '/media/video/result'].map(path => ({ path, authorization: 'Bearer broker-secret', body: { sessionID: 'ses_1', callID: 'video_1' } })));
});
