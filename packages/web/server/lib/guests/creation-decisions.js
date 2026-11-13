import crypto from 'node:crypto';
import nodeFs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const key = z.string().min(1).max(200);
const kindSchema = z.enum(['deck', 'doc', 'video', 'page']);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, status = 409) => { const error = new Error(code); error.code = code; error.status = status; throw error; };
const row = z.record(z.string(), z.unknown());
const object = (value) => row.safeParse(value).data ?? {};
const text = (value) => z.string().safeParse(value).data ?? '';
const rows = (value) => z.array(row).safeParse(value).data ?? [];
const revision = (value) => z.union([key, z.number().int().nonnegative()]).transform(String).parse(value);
const inspectionSchema = z.object({ kind: kindSchema, stage: key, decisionId: key, artifactVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const observedSchema = z.object({ plan: z.string().nullable(), prompts: z.string().nullable(), directions: z.string().nullable(), artifact: z.string().nullable(), result: z.string().nullable() }).strict();
const contextSchema = z.object({ directory: z.string().min(1).max(4096), sessionId: key });
const operationSchema = z.discriminatedUnion('action', [
  contextSchema.extend({ action: z.literal('inspect'), kind: kindSchema, state: z.string().max(5 * 1024 * 1024), observed: observedSchema }).strict(),
  contextSchema.extend({ action: z.literal('claim'), kind: kindSchema, inspection: inspectionSchema, text: z.string().min(1).max(100_000) }).strict(),
  contextSchema.extend({ action: z.literal('settle'), id: z.string().regex(/^[a-f0-9]{64}$/), outcome: z.enum(['accepted', 'unknown']) }).strict(),
  contextSchema.extend({ action: z.literal('read'), id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
const receiptSchema = inspectionSchema.extend({ id: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(['accepted', 'completed', 'unknown']), acceptedAt: z.number(), dispatch: z.enum(['confirmed', 'unknown']) }).strict();
const storedSchema = z.object({ version: z.literal(1), owner: key, projectId: key, projectBinding: key, sessionId: key, textDigest: key, receipt: receiptSchema }).strict();
const sourceOwnerSchema = z.object({ version: z.literal(1), owner: key, projectId: key, projectBinding: key, sessionId: key, decisionId: key, receiptId: key }).strict();
const stateFiles = { deck: 'superppt.json', doc: '协作状态.json', video: 'project.json', page: 'superweb.json' };

// These are the authoritative state gates supported by the existing creation panel.
const sourceGate = (kind, state) => {
  if (kind === 'deck') {
    if (state.schemaVersion !== 'superppt-task-vnext') fail('creation_state_invalid');
    const pending = object(state.pendingDecision);
    const stage = { 'plan-review': 'deck-style', 'sample-review': 'deck-sample', 'deck-review': 'deck-deliver' }[text(pending.kind)];
    if (!stage) fail('creation_no_pending_decision');
    return { stage, decisionId: key.parse(pending.id), revision: revision(state.contentRevision) };
  }
  if (kind === 'doc') {
    if (state.schema_version !== 2) fail('creation_state_invalid');
    const active = object(object(state.objects)[text(state.active_object_id)]);
    if (active.status !== 'pending_review' || !Number.isInteger(active.version)) fail('creation_no_pending_decision');
    return { stage: 'doc-review', decisionId: revision(state.revision), revision: `${text(state.active_object_id)}:${active.version}:${revision(state.revision)}` };
  }
  if (kind === 'page') {
    if (state.version !== 1 || !['direction', 'sample', 'acceptance'].includes(state.stage)) fail('creation_no_pending_decision');
    const stageRevision = revision(state.stageRevision);
    return { stage: `web-${state.stage}`, decisionId: `web-${state.stage}-${stageRevision}`, revision: stageRevision };
  }
  if (state.schemaVersion !== 1 || !rows(state.scenes).length) fail('creation_state_invalid');
  const approvals = rows(state.approvals).filter((entry) => ['approved', 'waived'].includes(entry.decision));
  if (approvals.some((entry) => entry.stage === 'final' && Object.keys(object(entry.target)).length)) fail('creation_no_pending_decision');
  const scriptIds = approvals.filter((entry) => entry.stage === 'script').flatMap((entry) => z.array(z.string()).safeParse(entry.scope).data ?? []);
  const stage = approvals.some((entry) => entry.stage === 'sample') ? 'video-final'
    : rows(state.scenes).every((scene) => scriptIds.includes(text(scene.id))) ? 'video-sample' : 'video-script';
  return { stage, decisionId: revision(state.revision), revision: revision(state.revision) };
};

/** Durable at-most-once admission. An uncertain dispatch is retained and never replayed. */
export const createCreationDecisionRuntime = ({ dataDir, authorize, verifyIdentity, assertCurrent, project, official, checkedSession, fsPromises = nodeFs }) => {
  const fs = fsPromises;
  const root = path.join(dataDir, 'creation-decisions');
  const checkedOwner = async (authentication, input, isCurrent) => {
    const context = await authorize(authentication, isCurrent);
    const directory = z.string().min(1).max(4096).parse(input.directory);
    const sessionId = key.parse(input.sessionId);
    const selected = await project(null, directory);
    const guest = await official('openchamber-builtin-creation');
    if (!guest.capabilityGrants?.includes('prompt') || !guest.capabilityGrants?.includes('sessions')) fail('creation_source_forbidden', 403);
    await checkedSession(sessionId, selected.path);
    return { context, selected, directory: await fs.realpath(selected.path), sessionId };
  };
  const readBytes = async (directory, relative, optional = false) => {
    if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0') || relative.split('/').some((part) => part === '..')) fail('creation_source_forbidden', 403);
    let absolute;
    try { absolute = await fs.realpath(path.resolve(directory, relative)); }
    catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    const suffix = path.relative(directory, absolute);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) fail('creation_source_forbidden', 403);
    const handle = await fs.open(absolute, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 30 * 1024 * 1024) fail('creation_source_too_large', 413);
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.size !== bytes.length || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || await fs.realpath(path.resolve(directory, relative)) !== absolute) fail('creation_source_changed');
      return bytes;
    } finally { await handle.close(); }
  };
  const verifyOwner = async (owner) => {
    const selected = await project(owner.selected.id);
    if (await fs.realpath(selected.path) !== owner.directory) fail('creation_project_changed');
    const guest = await official('openchamber-builtin-creation');
    if (!guest.capabilityGrants?.includes('prompt') || !guest.capabilityGrants?.includes('sessions')) fail('creation_source_forbidden', 403);
    await checkedSession(owner.sessionId, owner.directory);
    await verifyIdentity(owner.context);
    assertCurrent(owner.context);
  };
  const snapshot = async (owner, kind, expectedState, observed) => {
    const bytes = await readBytes(owner.directory, stateFiles[kind]);
    if (expectedState !== undefined && bytes.toString('utf8') !== expectedState) fail('creation_stale_sample');
    const state = row.parse(JSON.parse(bytes.toString('utf8')));
    const gate = sourceGate(kind, state);
    const paths = new Set();
    const expectedFiles = new Map();
    const add = (value) => { if (text(value)) paths.add(text(value)); };
    const observedFile = (field, file) => { add(file); if (text(file) && observed) expectedFiles.set(file, observed[field]); };
    if (kind === 'deck') {
      observedFile('plan', state.planPath);
      observedFile('prompts', `planning/${text(state.contentRevision)}/sample-prompts.json`);
      if (text(state.activeJobId)) {
        const resultPath = `generation/${text(state.activeJobId)}/result.json`;
        observedFile('result', resultPath);
        const result = await readBytes(owner.directory, resultPath, true);
        if (result) for (const page of rows(object(JSON.parse(result.toString('utf8'))).pages)) add(object(page.artifact).path);
      }
    } else if (kind === 'doc') observedFile('artifact', object(object(state.objects)[text(state.active_object_id)]).path);
    else if (kind === 'page') {
      const artifacts = object(state.artifacts);
      observedFile('directions', artifacts.directions);
      if (gate.stage === 'web-sample') add(artifacts.sample || '预览/v0.html');
      if (gate.stage === 'web-acceptance') { add(artifacts.preview || '预览/index.html'); for (const file of z.array(z.string()).safeParse(object(state.acceptance).screenshots).data ?? []) add(file); }
    } else {
      for (const job of rows(state.jobs).filter((entry) => entry.kind === 'render' && entry.state === 'succeeded')) { add(job.manifestPath); if (text(job.manifestPath)) add(text(job.manifestPath).replace(/manifest\.json$/, 'video.mp4')); }
    }
    const files = [[stateFiles[kind], digest(bytes)]];
    for (const file of [...paths].sort()) {
      const content = await readBytes(owner.directory, file, true);
      if (expectedFiles.has(file) && (content?.toString('utf8') ?? null) !== expectedFiles.get(file)) fail('creation_stale_sample');
      files.push([file, content === null ? 'missing' : digest(content)]);
    }
    // Catch state replacement while dependent artifacts were read.
    if (digest(await readBytes(owner.directory, stateFiles[kind])) !== digest(bytes)) fail('creation_stale_sample');
    return inspectionSchema.parse({ kind, stage: gate.stage, decisionId: gate.decisionId, artifactVersion: digest(JSON.stringify([gate.revision, files])) });
  };
  const idFor = (owner, inspection) => digest(JSON.stringify([owner.context.owner, owner.selected.id, owner.directory, owner.sessionId, inspection.kind, inspection.stage, inspection.artifactVersion, inspection.decisionId]));
  // The canonical sample has one adopted session. Caller-selected session IDs
  // cannot manufacture an independent claim for the same source.
  const sourceFilename = (owner, inspection) => path.join(root, owner.context.owner, 'sources', `${digest(JSON.stringify([owner.selected.id, owner.directory, inspection.kind, inspection.stage, inspection.artifactVersion]))}.json`);
  const readSourceOwner = async (owner, inspection) => {
    let stored;
    try { stored = sourceOwnerSchema.parse(JSON.parse(await fs.readFile(sourceFilename(owner, inspection), 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stored.owner !== owner.context.owner || stored.projectId !== owner.selected.id || stored.projectBinding !== digest(owner.directory)
      || stored.sessionId !== owner.sessionId || stored.decisionId !== inspection.decisionId || stored.receiptId !== idFor(owner, inspection)) fail('creation_original_session_required', 403);
    return stored;
  };
  const filename = (owner, id) => path.join(root, owner.context.owner, `${id}.json`);
  const read = async (owner, id) => {
    let stored;
    try { stored = storedSchema.parse(JSON.parse(await fs.readFile(filename(owner, id), 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stored.owner !== owner.context.owner || stored.projectId !== owner.selected.id || stored.projectBinding !== digest(owner.directory) || stored.sessionId !== owner.sessionId || stored.receipt.id !== id) fail('creation_receipt_forbidden', 403);
    await verifyOwner(owner);
    return stored;
  };
  const persist = async (owner, target, stored, exclusive) => {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${crypto.randomBytes(12).toString('hex')}`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(stored)); await handle.sync(); } finally { await handle.close(); }
      await verifyOwner(owner);
      if (exclusive) await fs.link(temporary, target); else await fs.rename(temporary, target);
      if (process.platform !== 'win32') {
        const directory = await fs.open(path.dirname(target), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      // Published claims remain unknown if their caller retires during IO.
      // Rejection must never unlink a record that can have reached dispatch.
      await verifyOwner(owner);
    } finally { await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  };
  return async ({ authentication, input, isCurrent }) => {
    input = operationSchema.parse(input);
    const owner = await checkedOwner(authentication, input, isCurrent);
    if (input.action === 'settle' || input.action === 'read') {
      const id = z.string().regex(/^[a-f0-9]{64}$/).parse(input.id);
      const stored = await read(owner, id);
      if (!stored) fail('creation_receipt_missing', 404);
      if (input.action === 'read') return { type: 'receipt', receipt: stored.receipt };
      // A renderer may confirm message admission. It cannot claim generation completion.
      const confirmed = input.outcome === 'accepted';
      if (stored.receipt.status === 'accepted') return { type: 'receipt', receipt: stored.receipt };
      stored.receipt = { ...stored.receipt, status: confirmed ? 'accepted' : 'unknown', dispatch: confirmed ? 'confirmed' : 'unknown' };
      await persist(owner, filename(owner, stored.receipt.id), stored, false);
      return { type: 'receipt', receipt: stored.receipt };
    }
    const kind = kindSchema.parse(input.kind);
    const current = await snapshot(owner, kind, input.action === 'inspect' ? input.state : undefined, input.action === 'inspect' ? input.observed : undefined);
    const id = idFor(owner, current);
    if (input.action === 'inspect') {
      await readSourceOwner(owner, current);
      const stored = await read(owner, id);
      await verifyOwner(owner);
      return { type: 'inspection', inspection: current, receipt: stored?.receipt ?? null };
    }
    if (input.action !== 'claim' || !inspectionSchema.safeParse(input.inspection).success || JSON.stringify(current) !== JSON.stringify(inspectionSchema.parse(input.inspection))) fail('creation_stale_sample');
    if (!await readSourceOwner(owner, current)) {
      const adopted = { version: 1, owner: owner.context.owner, projectId: owner.selected.id, projectBinding: digest(owner.directory), sessionId: owner.sessionId, decisionId: current.decisionId, receiptId: id };
      try { await persist(owner, sourceFilename(owner, current), adopted, true); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await readSourceOwner(owner, current);
    }
    const textDigest = digest(z.string().min(1).max(100_000).parse(input.text));
    const existing = await read(owner, id);
    if (existing) {
      if (existing.textDigest !== textDigest) fail('creation_decision_conflict');
      return { type: 'claim', dispatch: false, receipt: existing.receipt };
    }
    const receipt = receiptSchema.parse({ ...current, id, acceptedAt: Date.now(), status: 'unknown', dispatch: 'unknown' });
    const stored = { version: 1, owner: owner.context.owner, projectId: owner.selected.id, projectBinding: digest(owner.directory), sessionId: owner.sessionId, textDigest, receipt };
    try { await persist(owner, filename(owner, id), stored, true); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const retained = await read(owner, id);
      if (!retained || retained.textDigest !== textDigest) fail('creation_decision_conflict');
      return { type: 'claim', dispatch: false, receipt: retained.receipt };
    }
    await verifyOwner(owner);
    assertCurrent(owner.context);
    return { type: 'claim', dispatch: true, receipt };
  };
};
