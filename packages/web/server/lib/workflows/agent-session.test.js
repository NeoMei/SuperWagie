import { describe, expect, it, vi } from 'vitest';

import { WorkflowAgentStopped, createWorkflowAgentSessions } from './agent-session.js';

/** Creates an agent's session and stops before its prompt, to read the request. */
const createSessionRequest = async ({ parent, allowTools, model }) => {
  const created = [];
  const sessions = createWorkflowAgentSessions({
    buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    globalEventHub: { subscribeEvent: () => () => {} },
    createClient: () => ({
      session: {
        get: async () => parent,
        create: async (request) => {
          created.push(request);
          return { id: 'ses_agent' };
        },
      },
    }),
  });
  const controller = new AbortController();
  await expect(sessions.start({
    directory: '/repo',
    parentSessionId: 'ses_parent',
    title: 'agent',
    model,
    allowTools,
    text: 'work',
    signal: controller.signal,
    onSession: () => controller.abort(),
  })).rejects.toBeInstanceOf(WorkflowAgentStopped);
  return created[0];
};

describe('workflow agent sessions', () => {
  it("allows the asked tools after the parent's own rules", async () => {
    const parentRule = { action: 'bash', resource: '*', effect: 'deny' };
    const request = await createSessionRequest({
      parent: { id: 'ses_parent', permissions: [parentRule] },
      allowTools: ['openchamber_workflow_answer'],
      model: 'openai/gpt-6-luna',
    });
    expect(request.permissions).toEqual([parentRule, { action: 'openchamber_workflow_answer', resource: '*', effect: 'allow' }]);
  });

  it('sets no permissions without tools to allow, so the parent rules are inherited', async () => {
    const request = await createSessionRequest({ parent: { id: 'ses_parent' }, allowTools: [], model: 'openai/gpt-6-luna' });
    expect(request).not.toHaveProperty('permissions');
  });

  it("leaves permissions alone when the parent's rules cannot be read", async () => {
    const request = await createSessionRequest({ parent: null, allowTools: ['openchamber_workflow_answer'], model: 'openai/gpt-6-luna' });
    expect(request).not.toHaveProperty('permissions');
  });
});


describe('workflow prompt admission and knowledge', () => {
  const harness = (model = { providerID: 'byok', id: 'model' }) => {
    const sync = vi.fn(async () => true);
    const create = vi.fn(async () => ({ id: 'ses_agent' }));
    const prompt = vi.fn(async () => { throw new Error('prompt reached'); });
    const sessions = createWorkflowAgentSessions({
      buildOpenCodeUrl: (path) => `http://fixture.invalid${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: { subscribeEvent: () => () => {} },
      sessionKnowledgeRuntime: { sync },
      createClient: () => ({
        session: { get: async () => ({ id: 'ses_parent', model, location: { directory: '/actual-worktree' } }), create, prompt },
        message: { list: async () => ({ data: [] }) },
      }),
    });
    return { sessions, sync, create, prompt };
  };
  it.each([undefined, 'unihub/managed'])('refuses managed child models before creating a session: %s', async (model) => {
    const { sessions, create } = harness({ providerID: 'unihub', id: 'managed' });
    await expect(sessions.start({ directory: '/repo', parentSessionId: 'ses_parent', title: 'child', model,
      text: 'work', signal: new AbortController().signal, onSession: () => {} })).rejects.toMatchObject({ code: 'platform_child_unsupported' });
    expect(create).not.toHaveBeenCalled();
  });
  it('syncs a new BYOK child before its first prompt', async () => {
    const { sessions, sync, create, prompt } = harness();
    await expect(sessions.start({ directory: '/repo', parentSessionId: 'ses_parent', title: 'child', model: 'byok/model',
      text: 'first prompt', signal: new AbortController().signal, onSession: () => {} })).rejects.toThrow('prompt reached');
    expect(create).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith('ses_agent', '/actual-worktree', 'first prompt');
    expect(prompt).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('syncs the current prompt and actual directory with best-effort failure: %s', async (fails) => {
    const { sessions, sync, prompt } = harness();
    if (fails) sync.mockRejectedValue(new Error('unavailable'));
    await expect(sessions.followUp({ directory: '/repo', sessionId: 'ses_agent', text: 'current prompt',
      signal: new AbortController().signal })).rejects.toThrow('prompt reached');
    expect(sync).toHaveBeenCalledWith('ses_agent', '/actual-worktree', 'current prompt');
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
