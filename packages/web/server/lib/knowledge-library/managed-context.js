import path from 'node:path';
import { z } from 'zod';
import { isSpaceDirectory } from '../spaces/dispatcher.js';
const fail = () => { throw Object.assign(new Error('knowledge_work_scope_required'), { code: 'knowledge_work_scope_required', status: 403 }); };
const same = (a, b) => a && b && a.actingUserId === b.actingUserId && a.billingAccountId === b.billingAccountId && a.authSession === b.authSession && a.expiresAt === b.expiresAt && b.expiresAt > Date.now();

// Resolve address hints against the server's saved project catalog. The memory
// resolver's arbitrary-directory fallback cannot establish this authority.
export function createManagedKnowledgeContext({ readSettings, resolveProjectId, resolvePrimaryWorktreeRoot, getAccountRuntime, readSession, readMessages }) {
  const sessions = new Map();
  const resolve = async (_identity, context) => {
    if (!context?.directory || !path.isAbsolute(context.directory)) fail();
    const settings = await readSettings();
    const projects = z.array(z.object({ path: z.string().min(1) }).passthrough()).parse(settings.projects ?? []);
    const directory = path.resolve(context.directory);
    if (isSpaceDirectory(directory)) throw Object.assign(new Error('knowledge_work_space_unsupported'), { code: 'knowledge_work_space_unsupported', status: 403 });
    const exact = projects.filter((project) => path.resolve(project.path) === directory);
    if (exact.length > 1) fail();
    let root = exact[0]?.path;
    if (!root) {
      const primary = await resolvePrimaryWorktreeRoot(directory);
      const matches = projects.filter((project) => path.resolve(project.path) === path.resolve(primary?.root ?? '/invalid-managed-project'));
      if (matches.length !== 1) fail();
      root = matches[0].path;
    }
    if (!root) fail();
    return { projectId: await resolveProjectId(root), spaceId: 'host', directory };
  };
  const bindPrompt = async (identity, sessionId) => {
    const actor = getAccountRuntime().actor(identity); const session = await readSession(sessionId);
    if (session?.id !== sessionId || !session?.location?.directory) fail();
    const context = { directory: session.location.directory, sessionId, actorFence: actor };
    await resolve(identity, context);
    if (!same(actor, getAccountRuntime().actor(identity))) fail();
    if (!sessions.has(sessionId) && sessions.size >= 4096) fail();
    sessions.set(sessionId, { identity, actor, context });
  };
  const agent = async ({ sessionId, callId, input }) => {
    const bound = sessions.get(sessionId); if (!bound || !callId || !same(bound.actor, getAccountRuntime().actor(bound.identity))) fail();
    const session = await readSession(sessionId);
    if (session?.id !== sessionId || session.location?.directory !== bound.context.directory) fail();
    const page = await readMessages(sessionId);
    if (!Array.isArray(page?.data) || page.data.length > 100) fail();
    const matches = (Array.isArray(page?.data) ? page.data : []).filter((message) => message.type === 'assistant').flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((part) => part.type === 'tool' && part.id === callId);
    if (matches.length !== 1) fail();
    const tool = matches[0];
    if (tool.name !== 'openchamber_library' || tool.executed === false || tool.state?.status !== 'running' || !tool.state.input || Array.isArray(tool.state.input)) fail();
    const searchParameters = z.object({ query: z.string().optional(), library: z.string().optional(), limit: z.number().optional() }).strict();
    const readParameters = z.object({ documentId: z.string().optional(), path: z.string().optional(), maxChars: z.number().optional() }).strict();
    const reading = input.action === 'library.read';
    const parameters = reading ? readParameters : searchParameters;
    const actions = reading ? z.enum(['read', 'library.read']) : z.enum(['search', 'library.search']);
    const native = parameters.extend({ action: actions, parameters: parameters.optional() }).strict().safeParse(tool.state.input);
    if (!native.success) fail();
    const { parameters: nested, ...flattened } = native.data;
    const canonicalAction = reading ? 'library.read' : 'library.search';
    const actual = parameters.extend({ action: z.literal(canonicalAction) }).strict().safeParse({ ...flattened, ...nested, action: canonicalAction });
    const supplied = parameters.extend({ action: z.literal(canonicalAction) }).strict().safeParse(input);
    if (!actual.success || !supplied.success) fail();
    if (reading ? !actual.data.documentId && !actual.data.path : !actual.data.query) fail();
    for (const field of parameters.keyof().options) if (actual.data[field] !== supplied.data[field]) fail();
    await resolve(bound.identity, bound.context);
    if (!same(bound.actor, getAccountRuntime().actor(bound.identity))) fail();
    return { identity: bound.identity, context: bound.context, intentId: callId };
  };
  return { resolve, bindPrompt, agent };
}

// The ordinary authenticated UI prompt is the only source of agent ownership.
// Browser directory headers remain address hints resolved by the runtime.
export function createManagedKnowledgeMiddleware({ enabled, resolveModelBinding, resolveIdentity, isRequestOriginAllowed, readSettings, getAccountRuntime, context }) {
  return async (req, res, next) => {
    const prompt = req.method === 'POST' && /^\/api\/session\/([^/]+)\/prompt$/.exec(req.path);
    const knowledge = req.path.startsWith('/api/knowledge-library/');
    if (!prompt && !knowledge) return next();
    try {
      if (!enabled() || (await resolveModelBinding('embedding'))?.protocol !== 'managed-media') return next();
      const identity = await resolveIdentity(req, res);
      if (!identity) return next();
      if (req.method !== 'GET' && !await isRequestOriginAllowed(req)) return res.status(403).json({ error: 'knowledge_work_origin_forbidden' });
      if (prompt) {
        await context.bindPrompt(identity, prompt[1]);
      } else {
        for (const header of ['x-opencode-directory', 'idempotency-key']) {
          if (req.headersDistinct?.[header]?.length > 1 || (req.headers[header] !== undefined && !z.string().max(4096).safeParse(req.headers[header]).success)) fail();
        }
        const settings = await readSettings();
        const selected = z.array(z.object({ id: z.string(), path: z.string() }).passthrough()).parse(settings.projects ?? []).filter((project) => project.id === settings.activeProjectId);
        if (!req.headers['x-opencode-directory'] && selected.length !== 1) fail();
        const directory = req.headers['x-opencode-directory'] ? decodeURIComponent(req.headers['x-opencode-directory']) : selected[0].path;
        req.knowledgeExecution = { identity, context: { directory, actorFence: getAccountRuntime().actor(identity) }, intentId: req.headers['idempotency-key'] };
      }
      next();
    } catch (error) {
      res.status(error?.status >= 400 && error.status < 600 ? error.status : 403).json({ error: error?.code ?? 'knowledge_work_scope_required' });
    }
  };
}
