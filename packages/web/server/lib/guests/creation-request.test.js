import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

import { registerBuiltInGuests } from './catalog.js';
import { registerGuestRoutes } from './routes.js';
import { stopAllGuestServices } from './service.js';

const roots = [];
const releases = [];
const id = 'openchamber-builtin-creation';
const otherId = 'openchamber-builtin-other';

afterEach(async () => {
  await stopAllGuestServices();
  for (const release of releases.splice(0)) release();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const manifest = {
  name: 'creation', version: '1.0.0', type: 'module',
  openchamber: { apiVersion: 1, contributes: {
    panel: { id, name: 'Creation', icon: 'quill-pen', entry: 'panel/index.html' },
    capabilities: ['files'],
  } },
};

const fixture = async (creationProjectService) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-creation-request-'));
  roots.push(root);
  const bundle = path.join(root, 'app-bundle');
  const packageRoot = path.join(bundle, 'creation');
  const otherRoot = path.join(bundle, 'other');
  const data = path.join(root, 'data');
  await fs.mkdir(path.join(packageRoot, 'panel'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(packageRoot, 'panel/index.html'), '<script src="main.js"></script>');
  await fs.writeFile(path.join(packageRoot, 'panel/main.js'), 'console.log("creation");');
  await fs.mkdir(path.join(otherRoot, 'panel'), { recursive: true });
  await fs.writeFile(path.join(otherRoot, 'package.json'), JSON.stringify({
    name: 'other', version: '1.0.0', type: 'module',
    openchamber: { apiVersion: 1, contributes: {
      panel: { id: otherId, name: 'Other', icon: 'box', entry: 'panel/index.html' },
    } },
  }));
  await fs.writeFile(path.join(otherRoot, 'panel/index.html'), '<script src="main.js"></script>');
  await fs.writeFile(path.join(otherRoot, 'panel/main.js'), 'console.log("other");');
  await fs.writeFile(path.join(bundle, 'registry.json'), JSON.stringify({ version: 1, extensions: [{ id, directory: 'creation' }, { id: otherId, directory: 'other' }] }));
  releases.push(await registerBuiltInGuests({ persistPath: path.join(data, 'extensions.json'), root: bundle }));

  const app = express();
  registerGuestRoutes(app, {
    openchamberDataDir: data,
    openchamberVersion: '1.23.2',
    resolveGitBinaryForSpawn: () => 'git',
    resolveOptionalProjectDirectory: () => ({ directory: null }),
    creationProjectService,
  });
  return { api: request(app) };
};

describe('creation guest request', () => {
  test('runs the allowlisted creation call without an integration', async () => {
    const create = async (payload) => ({ projectId: 'p1', path: `/works/${payload.title}` });
    const { api } = await fixture({ create });

    const created = await api.post(`/api/guests/${id}/request`).send({
      method: 'POST', path: '/api/creation/projects',
      body: JSON.stringify({ kind: 'deck', title: '季度汇报', brief: '# 季度汇报\n' }),
    }).expect(200);
    // The guest request channel answers the proxy envelope the SDK's
    // `host.request` returns; the panel parses `body` itself.
    expect(created.body.status).toBe(200);
    expect(JSON.parse(created.body.body)).toEqual({ projectId: 'p1', path: '/works/季度汇报' });
  });

  test('keeps other paths and methods off the allowlist', async () => {
    const { api } = await fixture({ create: async () => ({ projectId: 'p1', path: '/works/x' }) });

    await api.post(`/api/guests/${id}/request`).send({ method: 'POST', path: '/api/other', body: '{}' }).expect(404);
    await api.post(`/api/guests/${id}/request`).send({ method: 'GET', path: '/api/creation/projects' }).expect(404);
  });

  test('keeps other guests off the creation path', async () => {
    let calls = 0;
    const create = async () => { calls += 1; return { projectId: 'p1', path: '/works/x' }; };
    const { api } = await fixture({ create });

    await api.post(`/api/guests/${otherId}/request`).send({
      method: 'POST', path: '/api/creation/projects', body: JSON.stringify({ kind: 'deck', title: 'x', brief: 'x' }),
    }).expect(404);
    expect(calls).toBe(0);
  });

  test('answers a creation failure with its status and message', async () => {
    const failure = Object.assign(new Error('unknown-kind'), { statusCode: 400 });
    const { api } = await fixture({ create: async () => { throw failure; } });

    const response = await api.post(`/api/guests/${id}/request`).send({
      method: 'POST', path: '/api/creation/projects', body: JSON.stringify({ kind: 'zip' }),
    }).expect(200);
    // The route answers 200 with the guest envelope; the failure lives in its
    // status, which the panel checks before parsing the body.
    expect(response.body.status).toBe(400);
    expect(JSON.parse(response.body.body)).toEqual({ error: 'unknown-kind' });
  });

  test('a paused creation guest stays paused', async () => {
    const { api } = await fixture({ create: async () => ({ projectId: 'p1', path: '/works/x' }) });
    await api.put(`/api/guests/${id}/enabled`).send({ enabled: false }).expect(200);

    const response = await api.post(`/api/guests/${id}/request`).send({
      method: 'POST', path: '/api/creation/projects', body: '{}',
    }).expect(400);
    expect(response.body.error).toBe('DISABLED');
  });
});
