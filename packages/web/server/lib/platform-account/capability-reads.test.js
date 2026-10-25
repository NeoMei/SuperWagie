import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerFsRoutes } from '../fs/routes.js';
import { registerGuestRoutes } from '../guests/routes.js';
import { createPlatformAccessGate } from './access-gate.js';
import { PlatformAccountError } from './runtime.js';

const roots = [];
const gates = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const gate of gates.splice(0)) gate.dispose();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-platform-capability-')));
  roots.push(root);
  const project = path.join(root, 'project');
  const packageRoot = path.join(root, 'extension');
  const data = path.join(root, 'data');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(project, 'index.html'), '<img src="logo.svg">');
  await fs.writeFile(path.join(project, 'logo.svg'), '<svg></svg>');
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'frame-test', version: '1.0.0', openchamber: {
    apiVersion: 1, contributes: { panel: { id: 'frame-test', name: 'Frame Test', icon: 'apps', entry: 'index.html' }, integration: {
      name: 'Fixture OAuth', description: 'Fixture', oauth: { authorizeUrl: 'https://provider.test/authorize', tokenUrl: 'https://provider.test/token', apiOrigin: 'https://provider.test' },
    } },
  } }));
  await fs.writeFile(path.join(packageRoot, 'index.html'), '<script src="main.js"></script>');
  await fs.writeFile(path.join(packageRoot, 'main.js'), 'console.log("frame");');
  await fs.writeFile(path.join(root, 'secret.txt'), 'outside');
  let signedIn = true;
  const gate = createPlatformAccessGate({
    resolveIdentity: async (req) => req.headers.authorization === 'Bearer test-user' ? { type: 'client', token: 'test-user' } : null,
    getAccountRuntime: () => ({ actor(identity) {
      if (!signedIn || !identity) throw new PlatformAccountError('platform_session_expired', 401);
      return { actingUserId: 'test-user', expiresAt: Date.now() + 60_000 };
    } }),
  });
  gates.push(gate);
  const app = express();
  app.use(gate.middleware);
  app.use(express.json());
  registerFsRoutes(app, {
    os, path, fsPromises: fs, spawn, crypto,
    normalizeDirectoryPath: (value) => value,
    resolveProjectDirectory: async () => ({ directory: project }),
    buildAugmentedPath: () => process.env.PATH,
    resolveGitBinaryForSpawn: () => 'git',
    openchamberUserConfigRoot: data,
  });
  registerGuestRoutes(app, { openchamberDataDir: data, resolveGitBinaryForSpawn: () => 'git' });
  await request(app).post('/api/guests').set('Authorization', 'Bearer test-user').send({ path: packageRoot }).expect(201);
  const page = path.join(project, 'index.html');
  const preview = (await request(app).post('/api/fs/preview').set('Authorization', 'Bearer test-user').send({ path: page }).expect(200)).body.grant;
  const frame = (await request(app).post('/api/guests/frame-test/frame-grant').set('Authorization', 'Bearer test-user').expect(200)).body.grant;
  return { app, page, preview, frame, signOut: () => { signedIn = false; } };
};

describe('grant-only documents behind the UniHub access gate', () => {
  it('serves minted preview and extension HTML and relative assets without runtime credentials, including after logout', async () => {
    const f = await fixture();
    f.signOut();
    const pageUrl = `/api/fs/preview/${f.preview}${f.page}`;
    const preview = await request(f.app).get(pageUrl).expect(200);
    expect(preview.text).toContain('src="logo.svg"');
    expect(preview.text).not.toContain('oc_url_token');
    expect(preview.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect((await request(f.app).get(new URL('logo.svg', `http://runtime.test${pageUrl}`).pathname).expect(200)).body.toString()).toBe('<svg></svg>');
    const frameUrl = `/api/guest-files/${f.frame}/index.html`;
    const frame = await request(f.app).get(frameUrl).expect(200);
    expect(frame.text).toContain('src="main.js"');
    expect(frame.text).not.toContain('oc_url_token');
    expect((await request(f.app).get(new URL('main.js', `http://runtime.test${frameUrl}`).pathname).expect(200)).text).toBe('console.log("frame");');
  });

  it('keeps unknown and expired grants with the owning route, and refuses package path escapes', async () => {
    const f = await fixture();
    await request(f.app).get(`/api/fs/preview/unknown${f.page}`).expect(403);
    await request(f.app).get(`/api/guest-files/${'a'.repeat(32)}/index.html`).expect(403);
    await request(f.app).get(`/api/guest-files/${f.frame}/..%2Fsecret.txt`).expect(404);
    const at = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(at + 13 * 60 * 60_000);
    await request(f.app).get(`/api/fs/preview/${f.preview}${f.page}`).expect(403);
    await request(f.app).get(`/api/guest-files/${f.frame}/index.html`).expect(403);
  });

  it('requires an actor to mint grants and does not exempt other filesystem or guest APIs or POST paths', async () => {
    const f = await fixture();
    for (const url of ['/api/fs/preview', '/api/guests/frame-test/frame-grant', `/api/fs/preview/${f.preview}${f.page}`, `/api/guest-files/${f.frame}/main.js`, '/api/guests/frame-test/oauth/callback', '/api/guests/frame-test/request']) {
      await request(f.app).post(url).send({ path: f.page }).expect(401);
    }
    await request(f.app).get('/api/fs/raw').query({ path: f.page }).expect(401);
    await request(f.app).get('/api/guests/frame-test/request').expect(401);
    await request(f.app).get('/api/guests').expect(401);
  });

  it('leaves exact guest OAuth callbacks to their state validator without opening nearby routes', async () => {
    const f = await fixture();
    const callback = await request(f.app).get('/api/guests/frame-test/oauth/callback?state=unknown&code=invalid');
    expect(callback.status).toBe(400);
    expect(callback.text).toContain('Authorization state was missing or expired.');
    expect(callback.text).not.toContain('platform_session_expired');
    await request(f.app).get('/api/guests/frame-test/oauth/callback/extra').expect(401);
    await request(f.app).get('/api/guests/frame-test/oauth/status').expect(401);
  });
});
