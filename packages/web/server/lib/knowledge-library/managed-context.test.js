import { expect, it } from 'vitest';
import { createManagedKnowledgeContext } from './managed-context.js';
const setup = () => {
  let actor = { actingUserId: 'owner', billingAccountId: 'payer', authSession: 'current', expiresAt: Date.now() + 60_000 };
  let directory = '/project';
  let projects = [{ path: '/project' }];
  let tool = { type: 'tool', id: 'call', name: 'openchamber_library', state: { status: 'running', input: { action: 'search', query: 'needle' } } };
  let afterMessages = () => {};
  const context = createManagedKnowledgeContext({
    readSettings: async () => ({ projects }), resolveProjectId: async (root) => `server:${root}`,
    resolvePrimaryWorktreeRoot: async (value) => ({ root: value === '/worktree' ? '/project' : value }),
    getAccountRuntime: () => ({ actor: (identity) => identity.token === 'ui' ? { ...actor } : null }),
    readSession: async (id) => ({ id, location: { directory } }),
    readMessages: async () => { afterMessages(); return { data: [{ type: 'assistant', content: Array.isArray(tool) ? tool : [tool] }] }; },
  });
  const identity = { type: 'session', token: 'ui' };
  const request = { sessionId: 'session', callId: 'call', input: { action: 'library.search', query: 'needle' } };
  return { context, identity, request, setActor: (value) => { actor = { ...actor, ...value }; }, setTool: (value) => { tool = value; }, tool: () => tool, setDirectory: (value) => { directory = value; }, setProjects: (value) => { projects = value; }, race: (fn) => { afterMessages = fn; } };
};
it('resolves only known server project/worktree hints and explicitly refuses isolated spaces', async () => {
  const f = setup();
  expect(await f.context.resolve(f.identity, { directory: '/worktree', projectId: 'forged' })).toEqual({ projectId: 'server:/project', spaceId: 'host', directory: '/worktree' });
  for (const directory of ['', '/unknown']) await expect(f.context.resolve(f.identity, { directory })).rejects.toThrow();
  await expect(f.context.resolve(f.identity, { directory: '/spaces/space/project' })).rejects.toMatchObject({ code: 'knowledge_work_space_unsupported' });
  f.setProjects([{ path: '/project' }, { path: '/project' }]);
  await expect(f.context.resolve(f.identity, { directory: '/project' })).rejects.toThrow();
});
it('requires a current UI prompt binding and exact authoritative running tool call', async () => {
  const f = setup(); await expect(f.context.agent(f.request)).rejects.toThrow();
  await f.context.bindPrompt(f.identity, 'session');
  const execution = await f.context.agent({ ...f.request, contextDirectory: '/injected', contextSessionId: 'other' });
  expect(execution.context.directory).toBe('/project'); expect(execution.context.actorFence.authSession).toBe('current');
  await expect(f.context.agent({ ...f.request, sessionId: 'another-session' })).rejects.toThrow();
  await expect(f.context.agent({ ...f.request, callId: 'other-call' })).rejects.toThrow();
  await expect(f.context.agent({ ...f.request, input: { ...f.request.input, query: 'other' } })).rejects.toThrow();
  const original = f.tool();
  for (const status of ['streaming', 'completed', 'error']) { f.setTool({ ...original, state: { ...original.state, status } }); await expect(f.context.agent(f.request)).rejects.toThrow(); }
  f.setTool([original, original]); await expect(f.context.agent(f.request)).rejects.toThrow();
  f.setTool({ ...original, executed: false }); await expect(f.context.agent(f.request)).rejects.toThrow();
  f.setTool({ ...original, state: { ...original.state, input: '{"query":"needle"}' } }); await expect(f.context.agent(f.request)).rejects.toThrow();
});
it('rejects logout, account switch, session movement and async capture races', async () => {
  const f = setup(); await f.context.bindPrompt(f.identity, 'session');
  f.setActor({ authSession: 'new-login' }); await expect(f.context.agent(f.request)).rejects.toThrow();
  await f.context.bindPrompt(f.identity, 'session'); f.setDirectory('/other'); await expect(f.context.agent(f.request)).rejects.toThrow();
  f.setDirectory('/project'); await f.context.bindPrompt(f.identity, 'session');
  f.race(() => f.setActor({ billingAccountId: 'other' })); await expect(f.context.agent(f.request)).rejects.toThrow();
  f.setActor({ expiresAt: 0 }); await expect(f.context.bindPrompt(f.identity, 'session')).rejects.toThrow();
});

it('normal middleware binds UI prompts and uses server-selected project without accepting browser actor fields', async () => {
  const { default: express } = await import('express'); const { default: request } = await import('supertest');
  const { createManagedKnowledgeMiddleware } = await import('./managed-context.js');
  const f = setup(); let allowed = true; let model = 'managed-media'; let selected = '/project';
  const app = express(); app.use(createManagedKnowledgeMiddleware({ enabled: () => true, resolveModelBinding: async () => ({ protocol: model }), resolveIdentity: async () => f.identity, isRequestOriginAllowed: async () => allowed, readSettings: async () => ({ projects: [{ id: 'saved', path: selected }], activeProjectId: 'saved' }), getAccountRuntime: () => ({ actor: () => ({ authSession: 'current' }) }), context: f.context }));
  app.post('/api/session/:id/prompt', (_req, res) => res.json({ forwarded: true }));
  app.get('/api/knowledge-library/status', (req, res) => res.json({ directory: req.knowledgeExecution?.context.directory, actor: req.knowledgeExecution?.context.actorFence }));
  expect((await request(app).post('/api/session/session/prompt').send({ actor: 'forged', contextDirectory: '/injected' })).status).toBe(200);
  expect((await f.context.agent(f.request)).context.directory).toBe('/project');
  const status = await request(app).get('/api/knowledge-library/status'); expect(status.body.directory).toBe('/project'); expect(status.body.actor).toEqual({ authSession: 'current' });
  const hint = await request(app).get('/api/knowledge-library/status').set('x-opencode-directory', encodeURIComponent('/worktree')); expect(hint.body.directory).toBe('/worktree');
  allowed = false; expect((await request(app).post('/api/session/session/prompt')).status).toBe(403);
  model = 'native'; expect((await request(app).post('/api/session/session/prompt')).status).toBe(200);
  selected = undefined; model = 'managed-media'; expect((await request(app).get('/api/knowledge-library/status')).status).toBe(403);
});

it('accepts the native tool parameter envelope with the same nested precedence as the plugin', async () => {
  const f = setup(); await f.context.bindPrompt(f.identity, 'session');
  const original = f.tool();
  f.setTool({ ...original, state: { status: 'running', input: { action: 'search', query: 'ignored flattened query', parameters: { query: 'needle' } } } });
  expect((await f.context.agent(f.request)).intentId).toBe('call');
  await expect(f.context.agent({ ...f.request, input: { action: 'library.search', query: 'ignored flattened query' } })).rejects.toThrow();
});
