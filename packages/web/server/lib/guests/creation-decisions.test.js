import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
const { registerMobileOfficialRoutes } = await import(process.env.OC_CREATION_CONTROLLER_MODULE || './mobile-official.js');

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'creation-decision-')); roots.push(root);
  const directory = path.join(root, 'project'); await fs.mkdir(directory);
  const state = JSON.stringify({ schema_version: 2, stage: 'chapters', revision: 7, active_object_id: 'chapter-a', objects: { 'chapter-a': { kind: 'chapter', status: 'pending_review', version: 2, path: 'chapter.md' } } });
  await fs.writeFile(path.join(directory, '协作状态.json'), state); await fs.writeFile(path.join(directory, 'chapter.md'), 'Current sample');
  const actor = (who) => ({ actingUserId: who.token === 'outsider' ? 'other' : 'user', billingAccountId: 'account', authSession: who.token, expiresAt: Date.now() + 60_000 });
  const runtime = { refreshSession: actor, actor, instancePrincipal: (who) => ({ issuer: 'https://synthetic.example', userId: actor(who).actingUserId }) };
  const deps = { dataDir: path.join(root, 'data'), getAccountRuntime: () => runtime, resolveIdentity: async (req) => ({ type: 'client', token: req.headers.authorization.slice(7) }), readSettings: async () => ({ projects: [{ id: 'registered', path: directory }] }), readSession: async (id, requested) => ({ id, directory: requested }), findGuest: async () => ({ source: 'bundled', enabled: true, capabilityGrants: ['files', 'sessions', 'prompt'] }) };
  const app = express();
  const native = registerMobileOfficialRoutes(app, deps);
  const call = (input, token = 'desktop-a', target = native) => target.creationApproval({ authentication: { kind: 'bearer', token }, isCurrent: () => true, input: { directory, sessionId: 'session-a', ...input } });
  const observed = { plan: null, prompts: null, directions: null, artifact: 'Current sample', result: null };
  const inspection = (await call({ action: 'inspect', kind: 'doc', state, observed })).inspection;
  return { root, directory, state, observed, deps, native, call, inspection, app };
};

test('concurrent clients and restarted hosts admit one dispatch and retain unknown after lost response', async () => {
  const f = await fixture();
  const restarted = registerMobileOfficialRoutes(express(), f.deps);
  const input = { action: 'claim', kind: 'doc', inspection: f.inspection, text: 'Approve chapter version 2' };
  const answers = await Promise.all(Array.from({ length: 8 }, (_, index) => f.call(input, index % 2 ? 'desktop-b' : 'desktop-a', index % 2 ? restarted : f.native)));
  expect(answers.filter((answer) => answer.dispatch)).toHaveLength(1);
  expect(new Set(answers.map((answer) => answer.receipt.id)).size).toBe(1);
  expect(answers[0].receipt.status).toBe('unknown');
  const replay = await f.call(input, 'desktop-b', restarted);
  expect(replay.dispatch).toBe(false);
  const inspected = await f.call({ action: 'inspect', kind: 'doc', state: f.state, observed: f.observed }, 'desktop-b', restarted);
  expect(inspected.receipt.status).toBe('unknown');
  const settled = await f.call({ action: 'settle', id: replay.receipt.id, outcome: 'accepted' });
  expect(settled.receipt.status).toBe('accepted');
  expect(settled.receipt.dispatch).toBe('confirmed');
  expect((await f.call(input)).dispatch).toBe(false);
});

test('one canonical sample adopts one session across two controllers and refuses a different same-project session', async () => {
  const f = await fixture();
  const second = registerMobileOfficialRoutes(express(), f.deps);
  const inspectionB = (await f.call({ action: 'inspect', kind: 'doc', state: f.state, observed: f.observed, sessionId: 'session-b' }, 'desktop-b', second)).inspection;
  expect(inspectionB).toEqual(f.inspection);
  const answers = await Promise.allSettled([
    f.call({ action: 'claim', kind: 'doc', inspection: f.inspection, text: 'Approve this sample' }),
    f.call({ action: 'claim', sessionId: 'session-b', kind: 'doc', inspection: inspectionB, text: 'Approve this sample' }, 'desktop-b', second),
  ]);
  expect(answers.filter((answer) => answer.status === 'fulfilled' && answer.value.dispatch)).toHaveLength(1);
  expect(answers.filter((answer) => answer.status === 'rejected' && answer.reason.code === 'creation_original_session_required')).toHaveLength(1);
  const aWon = answers[0].status === 'fulfilled';
  const losingSession = aWon ? 'session-b' : 'session-a';
  await expect(f.call({ action: 'inspect', kind: 'doc', state: f.state, observed: f.observed, sessionId: losingSession }, 'desktop-b', second)).rejects.toMatchObject({ code: 'creation_original_session_required' });
  await expect(f.call({ action: 'claim', kind: 'doc', inspection: { ...f.inspection, decisionId: 'caller-replaced-id' }, text: 'Approve this sample' })).rejects.toMatchObject({ code: 'creation_stale_sample' });
});

test('sample changes, wrong source, actor and session cannot reuse another decision receipt', async () => {
  const f = await fixture();
  const input = { action: 'claim', kind: 'doc', inspection: f.inspection, text: 'Approve chapter version 2' };
  const claimed = await f.call(input);
  await expect(f.call({ action: 'settle', id: claimed.receipt.id, outcome: 'accepted' }, 'outsider')).rejects.toMatchObject({ status: 404 });
  await expect(f.call({ action: 'settle', sessionId: 'other-session', id: claimed.receipt.id, outcome: 'accepted' })).rejects.toMatchObject({ status: 403 });
  await expect(f.call({ ...input, text: 'Different choice' })).rejects.toMatchObject({ code: 'creation_decision_conflict' });
  await fs.writeFile(path.join(f.directory, 'chapter.md'), 'Externally changed sample');
  await expect(f.call(input)).rejects.toMatchObject({ code: 'creation_stale_sample' });
  await expect(f.call({ action: 'inspect', kind: 'doc', state: f.state, observed: f.observed })).rejects.toMatchObject({ code: 'creation_stale_sample' });
  const state = JSON.parse(f.state); state.revision = 8;
  await fs.writeFile(path.join(f.directory, '协作状态.json'), JSON.stringify(state));
  expect((await f.call({ action: 'read', id: claimed.receipt.id })).receipt.id).toBe(claimed.receipt.id);
  await expect(f.call({ action: 'read', id: claimed.receipt.id }, 'outsider')).rejects.toMatchObject({ status: 404 });
  await expect(f.call({ action: 'inspect', kind: 'doc', state: f.state, observed: f.observed })).rejects.toMatchObject({ code: 'creation_stale_sample' });
  await request(f.app).post('/api/mobile-official/creation-decision').send({ action: 'claim' }).expect(405);
  await request(f.app).post('/api/official-selections/creation-decision').send({ action: 'claim' }).expect(403);
});

test('disk failure never grants dispatch and external artifact paths fail closed', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.root, 'data'), { recursive: true }); await fs.writeFile(path.join(f.root, 'data', 'creation-decisions'), 'blocked');
  await expect(f.call({ action: 'claim', kind: 'doc', inspection: f.inspection, text: 'Approve' })).rejects.toBeDefined();
  const state = JSON.parse(f.state); state.objects['chapter-a'].path = '../outside.md';
  await fs.writeFile(path.join(f.root, 'outside.md'), 'Synthetic material outside the registered project');
  const raw = JSON.stringify(state); await fs.writeFile(path.join(f.directory, '协作状态.json'), raw);
  await expect(f.call({ action: 'inspect', kind: 'doc', state: raw, observed: { ...f.observed, artifact: 'Synthetic material outside the registered project' } })).rejects.toMatchObject({ code: 'creation_source_forbidden' });
});
