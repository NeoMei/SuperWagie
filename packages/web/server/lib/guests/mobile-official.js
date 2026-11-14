import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { findInstalledGuest } from './catalog.js';
import { extensionsPersistPath } from './persist.js';
import { isSpaceDirectory, isSpaceRequest } from '../spaces/dispatcher.js';
import { createCreationDecisionRuntime } from './creation-decisions.js';

const OFFICIAL = ['openchamber-builtin-workbench', 'openchamber-builtin-creation'];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SELECTIONS = 32;
const key = z.string().min(1).max(200);
const relativePath = z.string().min(1).max(1024).refine((value) => !value.startsWith('/') && !value.startsWith('~')
  && !/^[A-Za-z]:/.test(value) && !value.includes('\\') && !value.includes('\0')
  && !value.split('/').some((part) => part === '.' || part === '..'));
const selectionRequest = z.object({
  extensionId: z.enum(OFFICIAL), projectId: key, sessionId: key.nullable(),
  title: z.string().trim().min(1).max(200), version: z.string().max(200).optional(),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('artifact'), path: relativePath }).strict(),
    z.object({ kind: z.literal('task'), taskId: key }).strict(),
  ]),
}).strict();
const actorSchema = z.object({ actingUserId: key, billingAccountId: key, expiresAt: z.number(), authSession: key });
const principalSchema = z.object({ issuer: z.string().min(1), userId: key });
const cardSchema = z.object({ title: z.string().min(1).max(200), text: z.string().max(2000).optional(), version: z.string().max(200).optional(), path: relativePath.optional() }).strict();
const publicSchema = z.object({
  id: z.string().uuid(), projectId: key, projectName: z.string().min(1).max(200), extensionId: z.enum(OFFICIAL),
  sessionId: key.nullable(), createdAt: z.number(), revision: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.union([z.object({ kind: z.literal('artifact'), path: relativePath }), z.object({ kind: z.literal('task'), taskId: key })]),
  card: cardSchema, preview: z.object({ kind: z.enum(['image', 'text', 'unavailable']), contentType: z.string(), byteLength: z.number().int().nonnegative() }),
});
const storedSchema = z.object({ version: z.literal(2), snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/), owner: z.string().regex(/^[a-f0-9]{64}$/), selection: publicSchema, content: z.string().max(Math.ceil(MAX_BYTES / 3) * 4), projectBinding: z.string().regex(/^[a-f0-9]{64}$/) });
const projectSchema = z.object({ id: key, path: z.string().min(1), label: z.string().max(200).optional() });
const taskMetadata = z.object({ id: key, note: z.string().max(2000).optional(), state: z.string().max(40).optional(), session: key.optional() }).passthrough();
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, status = 403) => { const error = new Error(code); error.code = code; error.status = status; throw error; };
const isInside = (target, root) => target !== root && !path.relative(root, target).startsWith(`..${path.sep}`) && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target));

/** Account-owned immutable snapshots. The phone never supplies a path to read. */
export const registerMobileOfficialRoutes = (app, {
  dataDir, getAccountRuntime, resolveIdentity, readSettings, readSession,
  findGuest = (id) => findInstalledGuest(id, extensionsPersistPath(dataDir)),
  creationDecisionFs = fs,
}) => {
  const storageRoot = path.join(dataDir, 'mobile-official');
  const queues = new Map();
  const serial = async (owner, work) => {
    const previous = queues.get(owner) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(work);
    queues.set(owner, operation);
    try { return await operation; } finally { if (queues.get(owner) === operation) queues.delete(owner); }
  };
  const identity = async (req, res) => {
    const who = await resolveIdentity(req, res, { allowUrlToken: false });
    const runtime = getAccountRuntime();
    if (!runtime) fail('mobile_account_unavailable', 503);
    let refreshed;
    try { refreshed = await runtime.refreshSession(who); } catch { fail('mobile_account_required', 409); }
    const actor = actorSchema.safeParse(refreshed);
    const principal = principalSchema.safeParse(runtime.instancePrincipal(who));
    if (!actor.success || !principal.success || actor.data.expiresAt <= Date.now() || principal.data.userId !== actor.data.actingUserId) fail('mobile_account_required', 409);
    return { who, request: req, runtime, actor: actor.data, owner: hash(JSON.stringify([principal.data.issuer, principal.data.userId, actor.data.billingAccountId])) };
  };
  const assertCurrent = (context) => {
    if (context.nativeCurrent && !context.nativeCurrent()) fail('mobile_selection_cancelled', 409);
    if (getAccountRuntime() !== context.runtime) fail('mobile_session_changed', 409);
    const actor = actorSchema.safeParse(context.runtime.actor(context.who));
    const principal = principalSchema.safeParse(context.runtime.instancePrincipal(context.who));
    if (!actor.success || !principal.success || actor.data.expiresAt <= Date.now() || actor.data.authSession !== context.actor.authSession
      || hash(JSON.stringify([principal.data.issuer, principal.data.userId, actor.data.billingAccountId])) !== context.owner) fail('mobile_session_changed', 409);
  };
  const verifyIdentity = async (context) => {
    const current = await resolveIdentity(context.request, undefined, { allowUrlToken: false });
    if (!current || current.type !== context.who?.type || current.token !== context.who?.token) fail('mobile_session_changed', 409);
    assertCurrent(context);
  };
  const project = async (projectId, directory) => {
    const settings = await readSettings();
    const projects = z.array(projectSchema).safeParse(settings?.projects);
    const found = projects.success ? projects.data.find((entry) => projectId === null ? path.resolve(entry.path) === path.resolve(directory) : entry.id === projectId) : null;
    if (!found || isSpaceDirectory(found.path) || isSpaceDirectory(await fs.realpath(found.path))) fail('mobile_project_forbidden');
    return found;
  };
  const official = async (id) => {
    if (!OFFICIAL.includes(id)) fail('mobile_extension_forbidden');
    const guest = await findGuest(id);
    if (!guest || guest.source !== 'bundled' || guest.enabled === false || !guest.capabilityGrants?.includes('files')) fail('mobile_extension_unavailable');
    return guest;
  };
  const checkedSession = async (id, directory) => {
    if (!id) return null;
    if (!readSession) fail('mobile_session_unavailable', 503);
    const session = await readSession(id, directory);
    if (session?.id !== id || path.resolve(session.directory) !== path.resolve(directory)) fail('mobile_session_forbidden');
    return id;
  };
  const readBytes = async (directory, relative) => {
    const root = await fs.realpath(directory);
    const absolute = await fs.realpath(path.resolve(root, relative));
    if (!isInside(absolute, root)) fail('mobile_file_forbidden');
    const handle = await fs.open(absolute, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) fail('mobile_file_too_large', 413);
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_BYTES || bytesRead !== stat.size) fail('mobile_file_changed', 409);
      // Recheck the canonical source after IO. A replaced link cannot select another file.
      if (await fs.realpath(path.resolve(root, relative)) !== absolute) fail('mobile_file_changed', 409);
      return bytes.subarray(0, bytesRead);
    } finally { await handle.close(); }
  };
  const filesFor = async (owner) => {
    try { return (await fs.readdir(path.join(storageRoot, owner))).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const readStored = async (context, id, onlyProject = null) => {
    if (!z.string().uuid().safeParse(id).success) fail('mobile_selection_not_found', 404);
    let stored;
    try {
      const filename = path.join(storageRoot, context.owner, `${id}.json`);
      if ((await fs.stat(filename)).size > 8 * 1024 * 1024) fail('mobile_snapshot_invalid', 503);
      stored = storedSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
      const { snapshotDigest, version: _version, ...snapshot } = stored;
      if (hash(JSON.stringify(snapshot)) !== snapshotDigest) fail('mobile_snapshot_invalid', 503);
      if (stored.selection.source.kind === 'artifact' && stored.selection.preview.kind !== 'unavailable'
        && hash(Buffer.from(stored.content, 'base64')) !== stored.selection.revision) fail('mobile_snapshot_invalid', 503);
    }
    catch (error) { if (error.code === 'ENOENT') fail('mobile_selection_not_found', 404); throw error; }
    if (stored.owner !== context.owner || stored.selection.id !== id) fail('mobile_selection_forbidden');
    if (onlyProject !== null && stored.selection.projectId !== onlyProject) return null;
    const selectedProject = await project(stored.selection.projectId);
    if (hash(await fs.realpath(selectedProject.path)) !== stored.projectBinding) fail('mobile_project_changed', 409);
    await official(stored.selection.extensionId);
    await verifyIdentity(context);
    return stored;
  };
  const route = (handler) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (isSpaceRequest(req)) fail('mobile_host_only');
      await handler(req, res);
    }
    catch (error) {
      const transportExpired = error.code === 'platform_runtime_auth_required';
      const known = error.code?.startsWith('mobile_');
      res.status(transportExpired ? 401 : known ? error.status : 503).json({ error: transportExpired || known ? error.code : 'mobile_read_failed' });
    }
  };
  // This controller is retained by the embedded native shell only. HTTP credentials
  // authenticate the account but never grant selection or revocation authority.
  const nativeContext = async (authentication, nativeCurrent) => {
    const nativeLease = z.function().safeParse(nativeCurrent);
    if (!nativeLease.success || !nativeLease.data()) fail('mobile_local_desktop_required');
    const credentials = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('bearer'), token: z.string().min(1).max(512) }).strict(),
      z.object({ kind: z.literal('cookie'), cookie: z.string().min(1).max(16 * 1024), host: z.string().min(1).max(512) }).strict(),
    ]).safeParse(authentication);
    if (!credentials.success) fail('mobile_account_required', 409);
    const headers = credentials.data.kind === 'bearer' ? { authorization: `Bearer ${credentials.data.token}` } : { cookie: credentials.data.cookie, host: credentials.data.host };
    const context = await identity({ headers });
    if (!context.who) fail('mobile_account_required', 409);
    context.nativeCurrent = nativeLease.data;
    assertCurrent(context);
    return context;
  };
  const select = async ({ authentication, input, isCurrent }) => {
    const parsed = selectionRequest.safeParse(input);
    if (!parsed.success) fail('mobile_invalid_selection', 400);
    const request = parsed.data;
    const context = await nativeContext(authentication, isCurrent);
    const selectedProject = await project(request.projectId);
    await official(request.extensionId);
    if ((request.source.kind === 'task') !== (request.extensionId === OFFICIAL[0])) fail('mobile_source_forbidden');
    const relative = request.source.kind === 'task' ? '任务.md' : request.source.path;
    const projectBinding = hash(await fs.realpath(selectedProject.path));
    const bytes = await readBytes(selectedProject.path, relative);
    let card = { title: request.title, path: relative };
    if (request.version) card.version = request.version;
    let content = '';
    let preview = { kind: 'unavailable', contentType: 'application/octet-stream', byteLength: bytes.length };
    let revision = hash(bytes);
    let sessionId = request.sessionId;
    if (request.source.kind === 'task') {
      const matches = bytes.toString('utf8').split('\n').flatMap((line) => {
        const match = /^\s*[-*+] \[[ xX]\]\s+(.*?)\s*<!--\s*sw\s+(\{.*\})\s*-->\s*$/.exec(line);
        if (!match) return [];
        let metadata;
        try { metadata = taskMetadata.safeParse(JSON.parse(match[2])); } catch { return []; }
        return metadata.success && metadata.data.id === request.source.taskId ? [{ line, title: match[1], metadata: metadata.data }] : [];
      });
      if (matches.length !== 1) fail('mobile_task_changed', 409);
      const task = matches[0];
      card = { title: task.title, text: task.metadata.note ?? '', version: task.metadata.state ?? '', path: '任务.md' };
      if (!cardSchema.safeParse(card).success) fail('mobile_task_too_large', 413);
      revision = hash(task.line);
      sessionId = task.metadata.session ?? null;
      preview = { kind: 'unavailable', contentType: 'text/plain', byteLength: 0 };
    } else {
      const extension = path.extname(relative).toLowerCase();
      const imageType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extension];
      if (imageType) { preview = { kind: 'image', contentType: imageType, byteLength: bytes.length }; content = bytes.toString('base64'); }
      else if (bytes.length <= 256 * 1024 && ['.txt', '.md', '.json', '.csv', '.tsv'].includes(extension)) { preview = { kind: 'text', contentType: 'text/plain; charset=utf-8', byteLength: bytes.length }; content = bytes.toString('base64'); }
    }
    sessionId = await checkedSession(sessionId, selectedProject.path);
    const selection = publicSchema.parse({ id: crypto.randomUUID(), projectId: selectedProject.id,
      projectName: selectedProject.label ?? path.basename(selectedProject.path), extensionId: request.extensionId,
      sessionId, source: request.source, createdAt: Date.now(), revision, card, preview });
    await serial(context.owner, async () => {
      const ownerRoot = path.join(storageRoot, context.owner);
      await fs.mkdir(ownerRoot, { recursive: true, mode: 0o700 });
      if ((await filesFor(context.owner)).length >= MAX_SELECTIONS) fail('mobile_selection_limit', 409);
      const currentProject = await project(request.projectId);
      if (hash(await fs.realpath(currentProject.path)) !== projectBinding) fail('mobile_project_changed', 409);
      await verifyIdentity(context);
      const target = path.join(ownerRoot, `${selection.id}.json`);
      const temporary = `${target}.tmp-${crypto.randomBytes(8).toString('hex')}`;
      const snapshot = { owner: context.owner, selection, content, projectBinding };
      let published = false;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 2, snapshotDigest: hash(JSON.stringify(snapshot)), ...snapshot }), { mode: 0o600, flag: 'wx' });
        assertCurrent(context);
        await fs.rename(temporary, target);
        published = true;
        await verifyIdentity(context);
      } catch (error) {
        if (published) await fs.rm(target, { force: true });
        throw error;
      } finally { await fs.rm(temporary, { force: true }); }
    });
    assertCurrent(context);
    return selection;
  };
  const revoke = async ({ authentication, id, isCurrent }) => {
    const context = await nativeContext(authentication, isCurrent);
    await serial(context.owner, async () => {
      await readStored(context, id);
      assertCurrent(context);
      await fs.unlink(path.join(storageRoot, context.owner, `${id}.json`));
    });
    return { revoked: true };
  };
  app.all(['/api/official-selections', '/api/official-selections/{*path}'], (_req, res) =>
    res.status(403).json({ error: 'mobile_local_desktop_required' }));
  app.get(['/api/mobile-official/projects', '/api/mobile-official/reader/projects'], route(async (req, res) => {
    const context = await identity(req, res);
    const projects = new Map();
    for (const file of await filesFor(context.owner)) {
      const stored = await readStored(context, file.slice(0, -5));
      projects.set(stored.selection.projectId, { id: stored.selection.projectId, name: stored.selection.projectName });
    }
    await verifyIdentity(context);
    res.json({ projects: [...projects.values()] });
  }));
  app.get(['/api/mobile-official', '/api/mobile-official/reader'], route(async (req, res) => {
    const context = await identity(req, res);
    const projectId = key.safeParse(req.query.projectId);
    if (!projectId.success) fail('mobile_project_required', 400);
    await project(projectId.data);
    const selections = [];
    for (const file of await filesFor(context.owner)) {
      const stored = await readStored(context, file.slice(0, -5), projectId.data);
      if (stored) selections.push(stored.selection);
    }
    await verifyIdentity(context);
    res.json({ state: 'ready', selections: selections.sort((left, right) => right.createdAt - left.createdAt) });
  }));
  app.get(['/api/mobile-official/:id/content', '/api/mobile-official/reader/:id/content'], route(async (req, res) => {
    const context = await identity(req, res);
    const stored = await readStored(context, req.params.id);
    if (stored.selection.preview.kind === 'unavailable') fail('mobile_preview_unavailable', 415);
    assertCurrent(context);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(stored.selection.preview.contentType).send(Buffer.from(stored.content, 'base64'));
  }));
  app.all(['/api/mobile-official', '/api/mobile-official/{*path}'], (_req, res) => res.status(405).json({ error: 'mobile_read_only' }));
  const creationApproval = createCreationDecisionRuntime({ dataDir, authorize: nativeContext, verifyIdentity, assertCurrent, project, official, checkedSession, fsPromises: creationDecisionFs });
  return { select, revoke, creationApproval };
};
