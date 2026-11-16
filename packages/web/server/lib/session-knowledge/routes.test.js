import http from 'node:http';
import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';

import { registerSessionKnowledgeRoutes } from './routes.js';

const createApp = (sync) => {
  const app = express();
  registerSessionKnowledgeRoutes(app, { sessionKnowledgeRuntime: { sync } });
  return app;
};

describe('session knowledge preparation requests', () => {
  test('passes a live signal and keeps it live after a completed response', async () => {
    let received;
    const app = createApp(async (...args) => { received = args; return true; });
    const response = await request(app).post('/api/session-knowledge/sync')
      .send({ sessionId: 'ses_a', directory: '/work/project', query: 'Current prompt' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ synced: true });
    expect(received.slice(0, 3)).toEqual(['ses_a', '/work/project', 'Current prompt']);
    expect(received[3]?.signal).toBeInstanceOf(AbortSignal);
    expect(received[3].signal.aborted).toBe(false);
  });

  test('finishing the request body does not cancel preparation still awaiting its response', async () => {
    let requestClosed;
    const closed = new Promise((resolve) => { requestClosed = resolve; });
    const app = express();
    app.use((req, _res, next) => { req.once('close', requestClosed); next(); });
    registerSessionKnowledgeRoutes(app, { sessionKnowledgeRuntime: {
      sync: async (_sessionId, _directory, _query, { signal } = {}) => {
        await closed;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal.aborted).toBe(false);
        return true;
      },
    } });
    const response = await request(app).post('/api/session-knowledge/sync')
      .send({ sessionId: 'ses_a', directory: '/work/project' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ synced: true });
  });

  test('cancels preparation when the client disconnects before its response', async () => {
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    const app = createApp(async (...args) => { entered(args[3]?.signal); await waiting; return false; });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const client = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/session-knowledge/sync', method: 'POST', headers: { 'Content-Type': 'application/json' } });
    client.on('error', () => {});
    client.end(JSON.stringify({ sessionId: 'ses_a', directory: '/work/project' }));
    try {
      const signal = await started;
      expect(signal).toBeInstanceOf(AbortSignal);
      const cancelled = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      client.destroy();
      await cancelled;
      expect(signal.aborted).toBe(true);
    } finally {
      client.destroy();
      release();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
