import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeMetadataPatch } from '../openchamber-sessions/session-metadata-store.js';
import { createSessionLead } from './runtime.js';

const temporary = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const fixture = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'openchamber-lead-'));
  temporary.push(dataDir);
  const sessions = new Map([
    ['ses_lead', { id: 'ses_lead', title: 'Release', directory: '/repo', model: { providerID: 'unihub' }, metadata: { openchamber: { lead: { at: 1 }, unrelated: true } } }],
    ['ses_other', { id: 'ses_other', directory: '/elsewhere', metadata: {} }],
    ['ses_native', { id: 'ses_native', parentID: 'ses_lead', directory: '/repo', metadata: { openchamber: { lead: { at: 1 } } } }],
    ['ses_existing', { id: 'ses_existing', title: 'Check', directory: '/repo', metadata: {} }],
  ]);
  const readSession = vi.fn(async (id) => sessions.get(id));
  const updateMetadata = vi.fn(async (id, decide) => {
    const session = sessions.get(id);
    const patch = decide(session.metadata);
    if (!patch) return { changed: false };
    session.metadata = mergeMetadataPatch(session.metadata, patch);
    return { changed: true };
  });
  const registerResult = vi.fn(async () => ({ id: 'dispatch-1' }));
  const createChild = vi.fn(async (payload, parentId) => {
    sessions.set('ses_job', { id: 'ses_job', directory: payload.directory, metadata: { openchamber: { leadParentID: parentId } } });
    return { sessionId: 'ses_job', directory: payload.directory, promptDispatched: true };
  });
  const deps = { dataDir, readSession, updateMetadata, registerResult, createChild,
    listSessions: async () => [...sessions.values()],
    isArchived: async () => false,
  };
  const lead = createSessionLead(deps);
  const tool = (action, input, contextSessionId = 'ses_lead', directory = '/repo') =>
    lead.executeTool(action, input, directory, { contextSessionId });
  return { lead, tool, deps, sessions, createChild, registerResult, readSession };
};

describe('session lead', () => {
  it('explains why a Lead tool call is unavailable before reading the session', async () => {
    const { deps, readSession } = await fixture();
    const lead = createSessionLead({ ...deps, isEnabled: async () => false });
    await expect(lead.executeTool('lead.brief', {}, '/repo', { contextSessionId: 'ses_lead' }))
      .rejects.toMatchObject({ statusCode: 501, message: 'Leads need the managed OpenCode runtime and the SuperWagie control tool' });
    expect(readSession).not.toHaveBeenCalled();
  });

  it('persists brief edits across runtime recreation and writes bounded digest into metadata', async () => {
    const { tool, deps, sessions } = await fixture();
    const digest = { needsYou: [{ question: 'Ship?', options: ['Yes', 'Wait'], recommended: 'Wait' }], now: ['Checking'], news: [], suggestions: ['Update docs'] };
    await expect(tool('lead.digest', digest)).rejects.toMatchObject({ statusCode: 409 });
    await tool('lead.brief', { brief: '# Outcome\nCheck the release' });
    await tool('lead.brief', { edits: [{ find: 'Check', replace: 'Verify' }] });
    const fresh = createSessionLead(deps);
    await expect(fresh.executeTool('lead.brief', {}, '/repo', { contextSessionId: 'ses_lead' }))
      .resolves.toMatchObject({ brief: '# Outcome\nVerify the release' });
    await tool('lead.digest', digest);
    expect(sessions.get('ses_lead').metadata.openchamber).toMatchObject({ unrelated: true, lead: { at: 1, digest } });
    await expect(tool('lead.digest', { ...digest, needsYou: [{ question: 'Ship?', options: ['Yes'], recommended: 'Wait' }] }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(tool('lead.brief', { edits: [{ find: 'Verify', replace: 'Ship' }, { find: 'missing', replace: 'new' }] }))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(tool('lead.brief', {})).resolves.toMatchObject({ brief: '# Outcome\nVerify the release' });
  });

  it('authorizes the tool caller as a top-level lead in its own directory', async () => {
    const { tool, createChild, registerResult } = await fixture();
    await expect(tool('lead.brief', { brief: 'fake' }, 'ses_native')).rejects.toMatchObject({ statusCode: 409 });
    await expect(tool('lead.brief', { brief: 'fake' }, 'ses_lead', '/elsewhere')).rejects.toMatchObject({ statusCode: 409 });
    await expect(tool('lead.dispatch', { prompt: 'check', directory: '/elsewhere' })).rejects.toMatchObject({ statusCode: 400 });
    expect(createChild).not.toHaveBeenCalled();
    expect(registerResult).not.toHaveBeenCalled();
  });

  it('dispatches scoped work, persists its association and reports retained paid feedback', async () => {
    const { tool, createChild, registerResult } = await fixture();
    const result = await tool('lead.dispatch', { title: 'Check tests', prompt: 'Run tests', model: 'test/model' });
    expect(createChild).toHaveBeenCalledWith({ directory: '/repo', title: 'Check tests', prompt: 'Run tests', model: 'test/model' }, 'ses_lead');
    expect(registerResult).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'ses_lead', sessionId: 'ses_job', afterIdleId: null, resume: false,
      parentDirectory: '/repo', directory: '/repo',
    }));
    expect(result).toMatchObject({ sessionId: 'ses_job', resultDelivery: { status: 'pending', resume: false } });
    await expect(tool('lead.children', {})).resolves.toMatchObject({ sessions: [{ id: 'ses_job' }] });
  });

  it('restores the previous Lead state when OpenCode cannot save guidance', async () => {
    const { deps, sessions } = await fixture();
    const lead = createSessionLead({
      ...deps,
      syncGuidance: async () => { throw new Error('instructions unavailable'); },
    });
    await expect(lead.setLead('ses_existing', true)).rejects.toThrow('instructions unavailable');
    expect(sessions.get('ses_existing').metadata.openchamber?.lead).toBeUndefined();
    await expect(lead.setLead('ses_lead', false)).rejects.toThrow('instructions unavailable');
    expect(sessions.get('ses_lead').metadata.openchamber.lead).toEqual({ at: 1 });
  });

  it('refuses cross-directory handover and preserves unrelated session data on take-over', async () => {
    const { lead, sessions } = await fixture();
    await expect(lead.handover('ses_other', 'ses_lead')).rejects.toMatchObject({ statusCode: 409 });
    await lead.handover('ses_existing', 'ses_lead');
    expect(sessions.get('ses_existing').metadata.openchamber.leadParentID).toBe('ses_lead');
    await lead.takeOver('ses_existing');
    expect(sessions.get('ses_existing').metadata.openchamber.leadParentID).toBeUndefined();
  });
});
