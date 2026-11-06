import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerProductHelpRoutes } from './routes.js';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { BUNDLED_PRODUCT_HELP_CONTENT, parseProductHelpContent } from './content.js';

describe('product help routes', () => {
  let server;
  let base;
  let calls;
  let responder;
  let content;
  let contentReads;
  const result = { kind: 'answer', text: 'Reviewed help', sources: [], actions: [], mode: 'local', modelStatus: 'unconfigured' };
  const request = (body, signal) => fetch(`${base}/api/product-help/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });

  beforeEach(async () => {
    calls = [];
    contentReads = [];
    content = BUNDLED_PRODUCT_HELP_CONTENT;
    responder = async () => result;
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerProductHelpRoutes(app, {
      getDefaultDirectory: () => '/last-used-project',
      getContent: async (options) => { contentReads.push(options); return content; },
      answerProductHelp: async (input, options) => { calls.push({ input, options }); return responder(input, options); },
    });
    app.use('/api', (_req, res) => res.status(418).json({ error: 'generic upstream fallback' }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('serves translated bundled articles without asking the answer service', async () => {
    const response = await fetch(`${base}/api/product-help/articles?locale=zh-CN`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const [identity, digest] = body.catalogVersion.split(':');
    expect(identity).toBe(`${content.catalogVersion}@${content.revision}`);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(body.articles).toHaveLength(content.articles.length);
    expect(body.articles[0].title).toBe('首次接入模型');
    expect(body.articles.find(article => article.id === 'mcp').actions).toEqual([
      { id: 'mcp-locate', kind: 'locate', target: 'mcp' },
      { id: 'mcp-guide', kind: 'guide', target: 'mcp' },
    ]);
    expect(calls).toEqual([]);
    const fallback = await fetch(`${base}/api/unowned`);
    expect(fallback.status).toBe(418);
  });

  it('rejects unknown languages without silently changing the language', async () => {
    const response = await fetch(`${base}/api/product-help/articles?locale=unsupported`);
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('serves the current independent content version without restarting routes', async () => {
    const original = await (await fetch(`${base}/api/product-help/articles?locale=en`)).json();
    content = parseProductHelpContent({
      ...BUNDLED_PRODUCT_HELP_CONTENT, revision: 2, catalogVersion: 'fixture.2',
      articles: BUNDLED_PRODUCT_HELP_CONTENT.articles.map(article => article.id === 'terminal'
        ? { ...article, en: { ...article.en, text: 'Updated terminal instructions.' } } : article),
    });
    const updated = await (await fetch(`${base}/api/product-help/articles?locale=en`)).json();
    expect(original.catalogVersion).not.toBe(updated.catalogVersion);
    expect(updated.catalogVersion).toMatch(/^fixture\.2@2:[a-f0-9]{64}$/);
    expect(updated.articles.find(article => article.id === 'terminal').text).toBe('Updated terminal instructions.');
    await request({ question: 'How do I use the terminal?' });
    expect(calls[0].options.content).toBe(content);
  });

  it('answers a healthy parsed request and scopes it to the lifecycle default', async () => {
    const response = await request({ question: 'Where are model settings?', locale: 'en', context: { page: 'chat' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(calls[0].input.directory).toBe('/last-used-project');
    expect(calls[0].options.signal.aborted).toBe(false);
    expect(contentReads).toEqual([{ refresh: false }]);
  });

  it('honors an explicitly supplied active directory', async () => {
    await request({ question: 'How to change the theme?', directory: '/current-project' });
    expect(calls[0].input.directory).toBe('/current-project');
  });

  it('rejects malformed or unrelated data before calling the service', async () => {
    const response = await request({ question: 'test', files: ['private-file'], providerID: 'incomplete-provider' });
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('rejects bodies over the route limit before calling the service', async () => {
    const response = await request({ question: 'x'.repeat(128 * 1024) });
    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it('does not expose unexpected provider errors', async () => {
    responder = async () => { throw new Error('private provider payload'); };
    const response = await request({ question: 'How do I select a model?' });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('private');
    expect(text).toContain('product_help_unavailable');
  });

  it('aborts service work when the response socket closes', async () => {
    let started;
    const received = new Promise((resolve) => { started = resolve; });
    let aborted;
    const cancelled = new Promise((resolve) => { aborted = resolve; });
    responder = (_input, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted(); reject(signal.reason); }, { once: true });
      started();
    });
    const controller = new AbortController();
    const pending = request({ question: 'Where are the settings?' }, controller.signal);
    await received;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await cancelled;
    expect(calls[0].options.signal.aborted).toBe(true);
  });
});
