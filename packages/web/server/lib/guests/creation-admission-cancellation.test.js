import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { registerMobileOfficialRoutes } from './mobile-official.js';
import { createOfficialSelectionIpc } from '../../../../electron/official-selection-ipc.mjs';
import { isAppShortcutFrame } from '../../../../electron/menu-shortcuts.mjs';
import { creationApprovalResultSchema, runCreationApprovalRequest } from '../../../../ui/src/lib/guests/creation-approval.ts';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'creation-cancel-')); roots.push(root);
  const directory = path.join(root, 'project'); await fs.mkdir(directory);
  const state = JSON.stringify({ schema_version: 2, stage: 'chapters', revision: 7, active_object_id: 'chapter', objects: { chapter: { kind: 'chapter', status: 'pending_review', version: 1, path: 'chapter.md' } } });
  await fs.writeFile(path.join(directory, '协作状态.json'), state); await fs.writeFile(path.join(directory, 'chapter.md'), 'Sample');
  const observed = { plan: null, prompts: null, directions: null, artifact: 'Sample', result: null };
  const actor = () => ({ actingUserId: 'user', billingAccountId: 'account', authSession: 'synthetic-auth-session', expiresAt: Date.now() + 60_000 });
  const account = { refreshSession: actor, actor, instancePrincipal: () => ({ issuer: 'https://synthetic.example', userId: 'user' }) };
  let afterClaimPublication = async () => {};
  let publications = 0;
  const deps = {
    dataDir: path.join(root, 'data'), getAccountRuntime: () => account,
    resolveIdentity: async () => ({ type: 'client', token: 'synthetic-credential' }),
    readSettings: async () => ({ projects: [{ id: 'registered', path: directory }] }),
    readSession: async (id, requested) => ({ id, directory: requested }),
    findGuest: async () => ({ source: 'bundled', enabled: true, capabilityGrants: ['files', 'prompt', 'sessions'] }),
    creationDecisionFs: { ...fs, link: async (...args) => {
      await fs.link(...args);
      if (!String(args[1]).includes(`${path.sep}sources${path.sep}`)) { publications++; await afterClaimPublication(); }
    } },
  };
  let native = registerMobileOfficialRoutes(express(), deps);
  const frame = { url: 'openchamber-ui://app/index.html', origin: 'openchamber-ui://app', parent: null };
  const sender = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: sender, isDestroyed: () => false };
  const event = { sender, senderFrame: frame };
  const ipc = createOfficialSelectionIpc({ isFrameAllowed: (candidate) => isAppShortcutFrame(candidate, window, 'http://127.0.0.1:5180'),
    isLocalTarget: (target) => target === 'http://127.0.0.1:57123', getController: () => native,
    resolveAuthentication: async () => ({ kind: 'bearer', token: 'synthetic-credential' }),
  });
  let operationId = '';
  const api = { perform: async (input) => {
    operationId = crypto.randomUUID();
    return creationApprovalResultSchema.parse(await ipc(event, 'desktop_creation_approval', { operationId, apiBaseUrl: 'http://127.0.0.1:57123', input }));
  } };
  const context = { directory, sessionId: 'session' };
  const inspectionAnswer = await api.perform({ ...context, action: 'inspect', kind: 'doc', state, observed });
  if (inspectionAnswer.type !== 'inspection') throw new Error('inspection missing');
  const inspection = inspectionAnswer.inspection;
  const submit = { method: 'POST', path: '/api/creation/decision', body: JSON.stringify({ action: 'submit', inspection, text: 'Approve this sample' }) };
  let sends = 0;
  return {
    directory, context, inspection, deps, get native() { return native; }, api,
    setAfterPublication(callback) { afterClaimPublication = callback; },
    cancel: () => ipc(event, 'desktop_official_selection_cancel', { operationId }),
    get publications() { return publications; }, get sends() { return sends; },
    restart() { native = registerMobileOfficialRoutes(express(), deps); },
    run: () => runCreationApprovalRequest({ request: submit, api, ...context, assertCurrent: () => {}, send: async () => { sends++; return { sent: 'sent' }; } }),
    raw: (input, isCurrent) => native.creationApproval({ input, authentication: { kind: 'bearer', token: 'synthetic-credential' }, isCurrent }),
  };
};

test('actual native cancel after exclusive claim publication admits no send and retains unknown across restart', async () => {
  const f = await fixture();
  f.setAfterPublication(async () => { await f.cancel(); });
  let failure = null;
  try { await f.run(); } catch (error) { if (!(error instanceof Error)) throw error; failure = error; }
  expect(f.publications).toBe(1);
  expect(f.sends).toBe(0);
  expect(failure).toBeInstanceOf(Error);
  f.setAfterPublication(async () => {});
  f.restart();
  const result = JSON.parse((await f.run()).body);
  expect(result.receipt.status).toBe('unknown');
  expect(result.receipt.dispatch).toBe('unknown');
  expect(f.sends).toBe(0);
  expect(f.publications).toBe(1);
});

test('the controller itself never returns dispatch after its lease expires during claim publication', async () => {
  const f = await fixture();
  let current = true;
  f.setAfterPublication(async () => { current = false; });
  await expect(f.raw({ ...f.context, action: 'claim', kind: 'doc', inspection: f.inspection, text: 'Approve this sample' }, () => current)).rejects.toThrow();
  expect(f.publications).toBe(1);
  f.restart();
  const retained = await f.raw({ ...f.context, action: 'claim', kind: 'doc', inspection: f.inspection, text: 'Approve this sample' }, () => true);
  expect(retained).toMatchObject({ type: 'claim', dispatch: false, receipt: { status: 'unknown' } });
});
