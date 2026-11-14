import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
const { createSpaceDispatcher } = await import(process.env.OC_SPACE_DISPATCHER_MODULE || '../spaces/dispatcher.js');
import express from 'express';
import request from 'supertest';
const { registerMobileOfficialRoutes } = await import(process.env.OC_MOBILE_OFFICIAL_MODULE || './mobile-official.js');

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-official-'));
  roots.push(root);
  const directory = path.join(root, 'project');
  const otherDirectory = path.join(root, 'other');
  await fs.mkdir(directory); await fs.mkdir(otherDirectory);
  await fs.writeFile(path.join(directory, 'sample.md'), 'Selected version 1');
  await fs.writeFile(path.join(directory, '任务.md'), '- [ ] Selected task <!-- sw {"id":"selected","note":"Only this note","session":"session-a"} -->\n- [ ] Private task <!-- sw {"id":"other","note":"Do not share"} -->');
  const identities = new Map([
    ['desktop', { userId: 'same-user', issuer: 'https://identity.example', accountId: 'account-a', authSession: 'desktop-login' }],
    ['phone', { userId: 'same-user', issuer: 'https://identity.example', accountId: 'account-a', authSession: 'phone-login' }],
    ['outsider', { userId: 'different-user', issuer: 'https://identity.example', accountId: 'account-a', authSession: 'other-login' }],
  ]);
  const actor = (who) => {
    const entry = identities.get(who.id);
    if (!entry) throw new Error('signed out');
    return { actingUserId: entry.userId, billingAccountId: entry.accountId, expiresAt: Date.now() + 60_000, authSession: entry.authSession };
  };
  const runtime = { refreshSession: actor, actor, instancePrincipal: (who) => ({ issuer: identities.get(who.id).issuer, userId: identities.get(who.id).userId }) };
  let source = 'bundled';
  const settings = { projects: [{ id: 'a', path: directory }, { id: 'b', path: otherDirectory }] };
  const dependencies = {
    dataDir: path.join(root, 'data'), getAccountRuntime: () => runtime,
    resolveIdentity: async (req) => ({ type: 'client', id: req.headers['test-identity'] ?? req.headers.authorization?.slice(7), client: { clientKind: req.headers['test-identity'] === 'desktop' ? 'desktop-local' : 'mobile' } }),
    classifyRequestScope: () => 'local', isRequestOriginAllowed: async (req) => req.headers.origin === 'http://localhost',
    readSettings: async () => settings,
    readSession: async (id, directory) => ({ id, directory }),
    findGuest: async () => ({ source, enabled: true, capabilityGrants: ['files'] }),
  };
  const app = express(); const native = registerMobileOfficialRoutes(app, dependencies);
  return { root, directory, native, api: request(app), settings, identities, dependencies,
    setSource: (value) => { source = value; },
    publish: (body = {}, isCurrent = () => true) => native.select({ authentication: { kind: 'bearer', token: 'desktop' }, isCurrent, input: {
      extensionId: 'openchamber-builtin-creation', projectId: 'a', sessionId: 'session-a', title: 'Sample', source: { kind: 'artifact', path: 'sample.md' }, ...body,
    } }),
  };
};
describe('official mobile read-only selections', () => {
  test('phone reads exactly the selected immutable project version with another device login', async () => {
    const f = await fixture();
    await f.api.post('/api/official-selections').set('test-identity', 'phone').set('Origin', 'http://localhost').send({ extensionId: 'openchamber-builtin-creation', projectId: 'a', sessionId: 'session-a', title: 'Guessed file', source: { kind: 'artifact', path: 'sample.md' } }).expect(403);
    await f.api.post('/api/official-selections').set('test-identity', 'desktop').set('x-openchamber-relay-connection', 'phone-relay').set('Origin', 'http://localhost').send({ extensionId: 'openchamber-builtin-creation', projectId: 'a', sessionId: 'session-a', title: 'Guessed file', source: { kind: 'artifact', path: 'sample.md' } }).expect(403);
    const selected = await f.publish();
    await fs.writeFile(path.join(f.directory, 'sample.md'), 'Version 2 changed later');
    const list = await f.api.get('/api/mobile-official?projectId=a').set('test-identity', 'phone').expect(200);
    expect(list.body.selections).toHaveLength(1);
    const restarted = express(); registerMobileOfficialRoutes(restarted, f.dependencies);
    expect((await request(restarted).get('/api/mobile-official?projectId=a').set('test-identity', 'phone').expect(200)).body.selections).toHaveLength(1);
    expect(list.body.selections[0].revision).toBe(selected.revision);
    expect(JSON.stringify(list.body)).not.toContain(f.directory);
    const content = await f.api.get(`/api/mobile-official/${selected.id}/content`).set('test-identity', 'phone').expect(200);
    expect(content.text).toBe('Selected version 1');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    const otherProject = await f.api.get('/api/mobile-official?projectId=b').set('test-identity', 'phone').expect(200);
    expect(otherProject.body.selections).toEqual([]);
    await f.api.get(`/api/mobile-official/${selected.id}/content`).set('test-identity', 'outsider').expect(404);
    f.identities.get('phone').accountId = 'account-b';
    expect((await f.api.get('/api/mobile-official?projectId=a').set('test-identity', 'phone').expect(200)).body.selections).toEqual([]);
  });
  test('task snapshot contains one selected task and phone mutations never write the Markdown file', async () => {
    const f = await fixture();
    const before = await fs.readFile(path.join(f.directory, '任务.md'), 'utf8');
    const selected = await f.publish({ extensionId: 'openchamber-builtin-workbench', source: { kind: 'task', taskId: 'selected' } });
    expect(selected.card).toMatchObject({ title: 'Selected task', text: 'Only this note' });
    expect(JSON.stringify(selected)).not.toContain('Do not share');
    for (const method of ['post', 'put', 'delete', 'patch']) {
      await f.api[method](`/api/mobile-official/${selected.id}`).set('test-identity', 'phone').send({ state: 'completed' }).expect(405);
    }
    expect(await fs.readFile(path.join(f.directory, '任务.md'), 'utf8')).toBe(before);
  });
  test('rejects third-party IDs, spoofed official source, traversal, symlink escapes, unregistered projects and origin failures', async () => {
    const f = await fixture();
    await expect(f.publish({ extensionId: 'third-party' })).rejects.toMatchObject({ status: 400 });
    f.setSource('path'); await expect(f.publish()).rejects.toMatchObject({ status: 403 }); f.setSource('bundled');
    await expect(f.publish({ source: { kind: 'artifact', path: '../outside.md' } })).rejects.toMatchObject({ status: 400 });
    await fs.writeFile(path.join(f.root, 'outside.md'), 'secret');
    await fs.symlink(path.join(f.root, 'outside.md'), path.join(f.directory, 'escape.md'));
    await expect(f.publish({ source: { kind: 'artifact', path: 'escape.md' } })).rejects.toMatchObject({ status: 403 });
    await expect(f.publish({ projectId: 'unregistered' })).rejects.toMatchObject({ status: 403 });
    await f.api.post('/api/official-selections').set('test-identity', 'desktop').send({}).expect(403);
  });
  test('rejects account replacement while selecting, preserves IO errors, and revokes only the selected grant', async () => {
    const f = await fixture();
    const first = await f.publish();
    const second = await f.publish();
    await f.native.revoke({ authentication: { kind: 'bearer', token: 'desktop' }, id: first.id, isCurrent: () => true });
    await f.api.get(`/api/mobile-official/${first.id}/content`).set('test-identity', 'phone').expect(404);
    await f.api.get(`/api/mobile-official/${second.id}/content`).set('test-identity', 'phone').expect(200);
    const read = f.dependencies.readSession;
    f.dependencies.readSession = async (...args) => { f.identities.get('desktop').authSession = 'replaced-login'; return read(...args); };
    // Re-register with the changed dependency to exercise an account replacement during IO.
    const app = express(); const native = registerMobileOfficialRoutes(app, f.dependencies);
    await expect(native.select({ authentication: { kind: 'bearer', token: 'desktop' }, isCurrent: () => true, input: { extensionId: 'openchamber-builtin-creation', projectId: 'a', sessionId: 'session-a', title: 'Sample', source: { kind: 'artifact', path: 'sample.md' } } })).rejects.toMatchObject({ status: 409 });
    const owners = await fs.readdir(path.join(f.root, 'data', 'mobile-official'));
    const snapshotFile = path.join(f.root, 'data', 'mobile-official', owners[0], `${second.id}.json`);
    const corrupt = JSON.parse(await fs.readFile(snapshotFile, 'utf8'));
    corrupt.content = Buffer.from('different bytes').toString('base64');
    await fs.writeFile(snapshotFile, JSON.stringify(corrupt));
    await f.api.get(`/api/mobile-official/${second.id}/content`).set('test-identity', 'phone').expect(503);
    await fs.rename(path.join(f.root, 'data', 'mobile-official'), path.join(f.root, 'data', 'unavailable'));
    await fs.writeFile(path.join(f.root, 'data', 'mobile-official'), 'unreadable directory');
    await f.api.get('/api/mobile-official?projectId=a').set('test-identity', 'phone').expect(503);
  });
});


test('public password issuance claiming desktop-local cannot select or revoke host material', async () => {
  const f = await fixture();
  const clients = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath: path.join(f.root, 'clients.json') });
  const auth = createUiAuth({ password: 'synthetic-password', clientAuthController: clients, readSettingsFromDiskMigrated: async () => ({}) });
  const app = express();
  app.post('/auth/session', express.json(), auth.handleSessionCreate);
  const actor = (who) => {
    if (!who?.token) throw new Error('Verified local identity required');
    return { actingUserId: 'same-user', billingAccountId: 'account-a', expiresAt: Date.now() + 60_000, authSession: crypto.createHash('sha256').update(who.token).digest('hex') };
  };
  const account = { refreshSession: actor, actor, instancePrincipal: () => ({ issuer: 'https://identity.example', userId: 'same-user' }) };
  const native = registerMobileOfficialRoutes(app, { ...f.dependencies, getAccountRuntime: () => account,
    resolveIdentity: (req, res) => auth.resolvePlatformAuthContext(req, res) });
  const login = await request(app).post('/auth/session').set('Host', '127.0.0.1:57123').send({ password: 'synthetic-password', issueClientToken: true, clientKind: 'desktop-local' }).expect(200);
  expect(login.body.client.clientKind).toBe('desktop-local');
  expect((await clients.authenticateBearerToken(login.body.clientToken)).ok).toBe(true);
  const selected = await native.select({ authentication: { kind: 'bearer', token: login.body.clientToken }, isCurrent: () => true, input: {
    extensionId: 'openchamber-builtin-creation', projectId: 'a', sessionId: 'session-a', title: 'Sample', source: { kind: 'artifact', path: 'sample.md' },
  } });
  for (const marker of [{}, { 'x-openchamber-relay-connection': 'relay' }]) {
    await request(app).post('/api/official-selections').set(marker).set('Origin', 'http://localhost').auth(login.body.clientToken, { type: 'bearer' })
      .send({ extensionId: 'openchamber-builtin-creation', projectId: 'a', sessionId: 'session-a', title: 'Sample', source: { kind: 'artifact', path: 'sample.md' } }).expect(403);
    await request(app).delete(`/api/official-selections/${selected.id}`).set(marker).auth(login.body.clientToken, { type: 'bearer' }).expect(403);
  }
  await f.api.get(`/api/mobile-official/${selected.id}/content`).set('test-identity', 'phone').expect(200);
  const cookie = login.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');
  const selectedByCookie = await native.select({ authentication: { kind: 'cookie', cookie, host: '127.0.0.1:57123' }, isCurrent: () => true, input: {
    extensionId: 'openchamber-builtin-creation', projectId: 'a', sessionId: 'session-a', title: 'Cookie-authenticated native owner', source: { kind: 'artifact', path: 'sample.md' },
  } });
  await request(app).delete(`/api/official-selections/${selectedByCookie.id}`).set('Cookie', cookie).expect(403);
  const revokedDuringRead = registerMobileOfficialRoutes(express(), { ...f.dependencies, getAccountRuntime: () => account,
    resolveIdentity: (req, res) => auth.resolvePlatformAuthContext(req, res), readSession: async (id, directory) => {
      await clients.revokeClient(login.body.client.id); return { id, directory };
    } });
  await expect(revokedDuringRead.select({ authentication: { kind: 'bearer', token: login.body.clientToken }, isCurrent: () => true, input: {
    extensionId: 'openchamber-builtin-creation', projectId: 'a', sessionId: 'session-a', title: 'Revoked during IO', source: { kind: 'artifact', path: 'sample.md' },
  } })).rejects.toMatchObject({ code: 'mobile_session_changed', status: 409 });
});

test('space addressing cannot reach host phone snapshots or selection mutations', async () => {
  const f = await fixture(); const selected = await f.publish();
  let connections = 0;
  const dispatcher = createSpaceDispatcher({ transport: {
    listSpaceIds: async () => ({ ids: ['a1b2c3d4e5f6'], failure: null }),
    connect: async () => { connections++; throw new Error('Host-only route reached space'); },
    readToken: async () => 'synthetic-space-password',
  } });
  const app = express(); app.use(dispatcher.middleware); registerMobileOfficialRoutes(app, f.dependencies);
  const space = '/spaces/a1b2c3d4e5f6/project';
  const paths = [
    `/api/mobile-official?projectId=a&directory=${encodeURIComponent(space)}`,
    `/api/mobile-official/${selected.id}/content?directory=${encodeURIComponent(space)}`,
    `/api/mobile-official/${selected.id}/content?directory=/host&location%5Bdirectory%5D=${encodeURIComponent(space)}`,
    `/api/spaces/a1b2c3d4e5f6/mobile-official/${selected.id}/content`,
    `/api/mobile-official/${selected.id}/content`,
  ];
  try {
    for (const target of paths) {
      const call = request(app).get(target).set('test-identity', 'phone');
      if (target === paths.at(-1)) call.set('x-opencode-directory', encodeURIComponent(space)).set('x-opencode-directory-encoding', 'uri');
      expect((await call.expect(403)).body.code).toBe('host_only_route');
    }
    for (const method of ['post', 'delete']) {
      await request(app)[method](`/api/official-selections/${method === 'delete' ? selected.id : ''}?directory=${encodeURIComponent(space)}`).send({}).expect(403);
      await request(app)[method](`/api/spaces/a1b2c3d4e5f6/official-selections/${method === 'delete' ? selected.id : ''}`).send({}).expect(403);
    }
    expect(connections).toBe(0);
    await f.api.get(`/api/mobile-official/${selected.id}/content`).set('test-identity', 'phone').expect(200);
  } finally { dispatcher.close(); }
});

test('task and artifact envelope changes fail integrity checks and task fields are bounded', async () => {
  const f = await fixture();
  const task = await f.publish({ extensionId: 'openchamber-builtin-workbench', source: { kind: 'task', taskId: 'selected' } });
  const owners = await fs.readdir(path.join(f.root, 'data', 'mobile-official'));
  const filename = path.join(f.root, 'data', 'mobile-official', owners[0], `${task.id}.json`);
  const stored = JSON.parse(await fs.readFile(filename, 'utf8'));
  stored.selection.card.text = 'Tampered selected note';
  await fs.writeFile(filename, JSON.stringify(stored));
  await f.api.get('/api/mobile-official?projectId=a').set('test-identity', 'phone').expect(503);
  await fs.writeFile(path.join(f.directory, '任务.md'), `- [ ] ${'x'.repeat(201)} <!-- sw {"id":"selected"} -->`);
  await expect(f.publish({ extensionId: 'openchamber-builtin-workbench', source: { kind: 'task', taskId: 'selected' } })).rejects.toMatchObject({ code: 'mobile_task_too_large', status: 413 });
});

test('retired native selection cannot leave a snapshot after account, runtime or project changes', async () => {
  const f = await fixture(); let current = true;
  const app = express(); const native = registerMobileOfficialRoutes(app, { ...f.dependencies, readSession: async (id, directory) => {
    current = false; return { id, directory };
  } });
  await expect(native.select({ authentication: { kind: 'bearer', token: 'desktop' }, isCurrent: () => current, input: {
    extensionId: 'openchamber-builtin-creation', projectId: 'a', sessionId: 'session-a', title: 'Sample', source: { kind: 'artifact', path: 'sample.md' },
  } })).rejects.toMatchObject({ code: 'mobile_selection_cancelled', status: 409 });
  expect((await f.api.get('/api/mobile-official?projectId=a').set('test-identity', 'phone').expect(200)).body.selections).toEqual([]);
});


test('host snapshot reads reject space hints even while the optional dispatcher is absent', async () => {
  const f = await fixture(); const selected = await f.publish();
  await f.api.get(`/api/mobile-official/${selected.id}/content?directory=/spaces/a1b2c3d4e5f6/project`).set('test-identity', 'phone').expect(403);
  await f.api.get('/api/mobile-official?projectId=a').set('test-identity', 'phone')
    .set('x-opencode-directory', encodeURIComponent('/spaces/a1b2c3d4e5f6/project')).set('x-opencode-directory-encoding', 'uri').expect(403);
});

test('dispatcher never forwards either official route family into a space', async () => {
  let connections = 0;
  const dispatcher = createSpaceDispatcher({ transport: {
    listSpaceIds: async () => ({ ids: ['a1b2c3d4e5f6'], failure: null }),
    connect: async () => { connections++; throw new Error('Unexpected forwarding'); }, readToken: async () => 'synthetic-password',
  } });
  const app = express(); app.use(dispatcher.middleware); app.use((_req, res) => res.json({ reached: 'host' }));
  try {
    for (const route of ['mobile-official', 'official-selections']) {
      const response = await request(app).post(`/api/spaces/a1b2c3d4e5f6/${route}`).send({});
      expect(connections).toBe(0);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('host_only_route');
    }
  } finally { dispatcher.close(); }
});

test('removing or rebinding a project and disabling an official extension revoke access', async () => {
  const f = await fixture(); const selected = await f.publish();
  f.settings.projects[0].path = f.settings.projects[1].path;
  await f.api.get(`/api/mobile-official/${selected.id}/content`).set('test-identity', 'phone').expect(409);
  f.settings.projects[0].path = f.directory;
  f.setSource('path'); await f.api.get(`/api/mobile-official/${selected.id}/content`).set('test-identity', 'phone').expect(403);
  f.setSource('bundled'); f.settings.projects.shift();
  await f.api.get(`/api/mobile-official/${selected.id}/content`).set('test-identity', 'phone').expect(403);
});
