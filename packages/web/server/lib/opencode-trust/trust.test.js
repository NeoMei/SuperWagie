import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createOpenCodeTrust } from './index.js';
import { createOpenCodeTrustFetch } from './fetch.js';
import { registerOpenCodeProxy } from '../opencode/proxy.js';

const temporaryDirectories = [];
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sw-folder-trust-')));
  temporaryDirectories.push(root);
  const homeDirectory = path.join(root, 'home');
  const repo = path.join(homeDirectory, 'project');
  const nested = path.join(repo, 'src');
  const globalDirectory = path.join(homeDirectory, '.config', 'opencode');
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(globalDirectory, { recursive: true })]);
  const storePath = path.join(root, 'trust.json');
  const trust = createOpenCodeTrust({ storePath, homeDirectory, globalConfigDirectories: [globalDirectory] });
  return { trust, storePath, repo, nested, globalDirectory };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OpenCode folder admission', () => {
  it('admits a repository with model settings and no executable configuration', async () => {
    const { trust, repo } = await fixture();
    await writeFile(path.join(repo, 'opencode.jsonc'), '{ // repository preferences\n "model": "provider/model", }');
    expect(await trust.inspect(repo)).toMatchObject({ trusted: true, fingerprint: null, items: [] });
  });

  it('requires the current fingerprint of inherited configuration and rejects stale decisions', async () => {
    const { trust, repo, nested } = await fixture();
    const config = path.join(repo, 'opencode.json');
    await writeFile(config, JSON.stringify({ mcp: { example: { type: 'local', command: ['fixture-command', 'fixture-argument-one'] } } }));
    const first = await trust.inspect(nested);
    expect(first).toMatchObject({
      trusted: false,
      items: [{ kind: 'mcp', name: 'example', detail: '' }],
    });
    await writeFile(config, JSON.stringify({ mcp: { example: { type: 'local', command: ['fixture-command', 'fixture-argument-two'] } } }));
    expect(await trust.answer(nested, first.fingerprint)).toMatchObject({ ok: false, assessment: { trusted: false } });
    const second = await trust.inspect(nested);
    expect(await trust.answer(nested, second.fingerprint)).toMatchObject({ ok: true });
    expect(await trust.isTrusted(nested)).toBe(true);
  });

  it('reviews native v2 MCP commands and omits argument values from the assessment', async () => {
    const { trust, repo } = await fixture();
    const config = { mcp: { servers: { native: { type: 'local', command: ['fixture-command', 'fixture-argument'] } } } };
    await writeFile(path.join(repo, 'opencode.json'), JSON.stringify(config));
    expect(await trust.inspect(repo)).toMatchObject({
      trusted: false,
      items: [{ kind: 'mcp', name: 'native', detail: '' }],
    });
  });

  it('requires review when recognized execution settings are malformed', async () => {
    const { trust, repo } = await fixture();
    const config = { formatter: { example: { command: 'fixture-value' } } };
    await writeFile(path.join(repo, 'opencode.json'), JSON.stringify(config));
    expect(await trust.inspect(repo)).toMatchObject({
      trusted: false,
      items: [{ kind: 'config', name: '', detail: '' }],
    });
  });

  it('reports environment and file references by name and detects effects in agent files', async () => {
    const { trust, repo, globalDirectory } = await fixture();
    await writeFile(path.join(globalDirectory, 'opencode.json'), JSON.stringify({ permissions: [{ action: 'shell', effect: 'ask' }] }));
    await writeFile(path.join(repo, 'opencode.json'), JSON.stringify({ mcp: { example: {
      type: 'remote', url: 'https://example.invalid', headers: { one: '{env:TRUST_TEST_VALUE}', two: '{file:example.txt}' },
    } } }));
    const agents = path.join(repo, '.opencode', 'agents');
    await mkdir(agents, { recursive: true });
    await writeFile(path.join(agents, 'quality.md'), '---\npermission:\n  bash: allow\n---\nReview the result.');
    const assessment = await trust.inspect(repo);
    expect(assessment.trusted).toBe(false);
    expect(assessment.items.map(({ kind, name }) => [kind, name])).toEqual([
      ['env', 'TRUST_TEST_VALUE'], ['file', 'example.txt'], ['permission', 'quality'],
    ]);
  });

  it('keeps the trust rule before any location load and checks a session owner', async () => {
    const { trust, repo, nested } = await fixture();
    await writeFile(path.join(repo, 'opencode.json'), JSON.stringify({ shell: 'fixture-shell' }));
    const resolveSessionDirectory = async () => nested;
    const scope = { 'x-opencode-directory': encodeURIComponent(nested) };
    expect(await trust.refusalFor({ method: 'GET', path: '/api/session', headers: scope })).toBeNull();
    expect(await trust.refusalFor({ method: 'GET', path: '/api/session/ses_fixture', headers: scope })).toBeNull();
    expect(await trust.refusalFor({ method: 'GET', path: '/api/agent', headers: scope })).toMatchObject({
      status: 403, body: { code: 'opencode_trust_required', directory: nested },
    });
    expect(await trust.refusalFor({ method: 'POST', path: '/api/session/ses_fixture/prompt', resolveSessionDirectory })).toMatchObject({
      status: 403, body: { code: 'opencode_trust_required', directory: nested },
    });
    expect(await trust.refusalFor({ method: 'PATCH', path: '/api/session/ses_fixture', resolveSessionDirectory })).toMatchObject({
      status: 403, body: { code: 'opencode_trust_required', directory: nested },
    });
  });

  it('assesses a location after its worktree preparation finishes', async () => {
    const { trust, repo } = await fixture();
    const result = await trust.refusalFor({
      method: 'POST',
      path: '/api/session',
      readBody: async () => JSON.stringify({ location: { directory: repo } }),
      prepareDirectory: async (directory) => {
        await writeFile(path.join(directory, 'opencode.json'), JSON.stringify({ shell: 'fixture-shell' }));
        return null;
      },
    });
    expect(result).toMatchObject({ status: 403, body: { directory: repo } });
  });

  it('keeps a folder owned by another runtime out of the local trust store', async () => {
    const { storePath, repo, nested } = await fixture();
    const trust = createOpenCodeTrust({ storePath, allowDirectory: (directory) => directory !== nested });
    const prepareDirectory = () => { throw new Error('Another runtime owns this preparation'); };
    await expect(trust.inspect(nested)).rejects.toThrow(/another runtime/);
    expect(await trust.refusalFor({
      method: 'POST', path: '/api/session', readBody: async () => JSON.stringify({ location: { directory: nested } }), prepareDirectory,
    })).toMatchObject({ status: 503 });
    expect(await trust.inspect(repo)).toMatchObject({ trusted: true });
  });

  it('pauses the direct proxy before the upstream location starts', async () => {
    const { trust, repo } = await fixture();
    await writeFile(path.join(repo, 'opencode.json'), JSON.stringify({ shell: 'fixture-shell' }));
    const listen = (app) => new Promise((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    const close = (listener) => new Promise((resolve) => listener.close(resolve));
    const upstream = express();
    upstream.use(express.json());
    let requests = 0;
    let createBody;
    upstream.get('/api/agent', (_req, res) => { requests++; res.json([]); });
    upstream.post('/api/session', (req, res) => { ++requests; createBody = req.body; res.json({ data: { id: 'ses_fixture' } }); });
    const engine = await listen(upstream);
    const app = express();
    const port = engine.address().port;
    registerOpenCodeProxy(app, {
      getRuntime: () => ({ openCodePort: port, isOpenCodeReady: true }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (resource) => 'http://127.0.0.1:' + port + resource,
      ensureOpenCodeApiPrefix: () => {},
      readWorktreeBootstrapStatus: async () => ({ status: 'ready' }),
      waitForWorktreeRemovalToSettle: async () => {},
      openCodeTrust: trust,
    });
    const listener = await listen(app);
    const base = 'http://127.0.0.1:' + listener.address().port;
    const scoped = { 'x-opencode-directory': encodeURIComponent(repo) };
    try {
      const rejected = await fetch(base + '/api/agent', { headers: scoped });
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({ code: 'opencode_trust_required', directory: repo });
      const body = { location: { directory: repo } };
      const create = () => fetch(base + '/api/session', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect((await create()).status).toBe(403);
      expect(requests).toBe(0);
      const shown = await (await fetch(base + '/api/opencode/trust?directory=' + encodeURIComponent(repo))).json();
      const answer = await fetch(base + '/api/opencode/trust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directory: repo, fingerprint: shown.fingerprint }),
      });
      expect(answer.status).toBe(200);
      expect((await fetch(base + '/api/agent', { headers: scoped })).status).toBe(200);
      expect((await create()).status).toBe(200);
      expect(createBody).toEqual(body);
      expect(requests).toBe(2);
    } finally {
      await close(listener);
      await close(engine);
    }
  });

  it('does not forward an internal call after its engine origin changes during folder verification', async () => {
    const { trust } = await fixture();
    let origin = 'http://127.0.0.1:3901';
    let awaited = () => {};
    let beginValidation = () => {};
    const started = new Promise((resolve) => { beginValidation = resolve; });
    const release = new Promise((resolve) => { awaited = resolve; });
    const request = createOpenCodeTrustFetch({
      openCodeTrust: {
        ...trust,
        refusalFor: async () => { beginValidation(); await release; return null; },
      },
      buildOpenCodeUrl: (resource) => origin + resource,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: async () => { throw new Error('Unexpected engine fetch'); },
    });
    const pending = request(origin + '/api/agent');
    await started;
    origin = 'http://127.0.0.1:3902';
    awaited();
    expect((await pending).status).toBe(503);
  });
});
