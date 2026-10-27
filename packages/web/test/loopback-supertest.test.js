import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

// SuperTest owns the servers it starts. They must bind only loopback and
// close when their final request settles, without closing caller-owned ones.
describe('supertest servers in the web suite', () => {
  it('listen on the loopback address the request goes to, and only there', async () => {
    const app = express();
    app.get('/where', (req, res) => res.json({ address: req.socket.server.address() }));

    const { body } = await request(app).get('/where').query({ probe: 1 }).expect(200);

    expect(body.address).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(body.address.port).toBeGreaterThan(0);
  });

  it('closes the server it started once the response is in', async () => {
    let server;
    const app = express();
    app.get('/', (req, res) => {
      server = req.socket.server;
      res.end('ok');
    });

    await request(app).get('/').expect(200);

    expect(server.listening).toBe(false);
  });

  it('keeps one factory server open until every concurrent response settles', async () => {
    const servers = new Set();
    const app = express();
    app.get('/:id', (req, res) => {
      servers.add(req.socket.server);
      setTimeout(() => res.json({ id: req.params.id }), req.params.id === 'slow' ? 30 : 0);
    });
    const factory = request(app);

    const responses = await Promise.all([
      factory.get('/slow').expect(200),
      factory.get('/fast').expect(200),
    ]);

    expect(responses.map(({ body }) => body.id)).toEqual(['slow', 'fast']);
    expect(servers.size).toBe(1);
    for (const server of servers) expect(server.listening).toBe(false);
  });

  it('leaves a caller-owned listening server open after the response', async () => {
    const app = express();
    app.get('/', (_req, res) => res.end('ok'));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await request(server).get('/').expect(200, 'ok');
      expect(server.listening).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
