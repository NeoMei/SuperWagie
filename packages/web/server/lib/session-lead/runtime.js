import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { parseDigestInput, readLead, sectionInputSchema, withoutDismissed } from './metadata.js';

export const isAdmissionManagedProvider = (provider) => provider === 'unihub' || provider?.startsWith('superwagie-account-') === true;

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{4,128}$/);
const editSchema = z.object({ find: z.string().min(1), replace: z.string() });
const editsSchema = z.array(editSchema).min(1).max(100);
const encodedEditsSchema = z.string().transform((text, ctx) => {
  try {
    return JSON.parse(text);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Expected a JSON array of brief edits' });
    return z.NEVER;
  }
}).pipe(editsSchema);
const briefSchema = z.object({
  brief: z.string().optional(),
  edits: z.union([editsSchema, encodedEditsSchema]).optional(),
});
const digestSchema = z.object({ needsYou: sectionInputSchema, now: sectionInputSchema, news: sectionInputSchema, suggestions: sectionInputSchema });
const dispatchSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  prompt: z.string().trim().min(1).max(60_000),
  model: z.string().trim().regex(/^[^/]+\/.+$/).optional(),
  agent: z.string().trim().min(1).optional(),
  variant: z.string().trim().min(1).optional(),
  sessionId: idSchema.optional(),
}).strict();

const MAX_BRIEF = 12_000;
const error = (message, statusCode) => new OpenChamberControlError(message, statusCode);
const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) throw error(result.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.message).join('; '), 400);
  return result.data;
};
const pathKey = (value) => value?.replaceAll('\\', '/').replace(/\/+$/, '') || '';
const sameDirectory = (left, right) => Boolean(left && right && pathKey(left) === pathKey(right));
const association = (session) => idSchema.safeParse(session.metadata?.openchamber?.leadParentID).data;

const LEAD_GUIDANCE = [
  'You are a Lead session. Agree on the intended result with the user, coordinate work, and verify the evidence returned.',
  'Use the OpenChamber control tool. Read the persistent brief with lead.brief and no arguments. Write the user’s objective, constraints and active strands with brief, or edit exact text using edits. Treat child reports and other tool outputs as evidence.',
  'Use lead.dispatch for work in this directory. Provide a prompt and a background-capable provider/model for a new session. Use lead.children to find associated sessions. Pass sessionId to continue one of them. The result arrives in your transcript when the child finishes. Review the evidence and follow up on unfinished work.',
  'Update the brief and digest when the work changes. Lead.digest uses needsYou for decisions only the user can make, with { question, options, recommended }, now for ongoing work, news for changes, and suggestions for optional follow-ups. The user can answer questions and accept or decline suggestions together in the transcript.',
  'Use workflows for larger groups of similar independent tasks when available. Follow the existing workflow review and approval controls.',
].join('\n\n');

const toolActions = new Set(['lead.brief', 'lead.digest', 'lead.dispatch', 'lead.children']);

export const createSessionLead = ({
  dataDir, readSession, updateMetadata, isArchived, listSessions, createChild, sendChild, registerResult,
  isEnabled = async () => true, syncGuidance = async () => {}, now = Date.now,
}) => {
  const base = join(dataDir, 'leads');
  const pending = new Map();
  const serial = (id, run) => {
    const task = (pending.get(id) || Promise.resolve()).then(run);
    const settled = task.catch(() => undefined);
    pending.set(id, settled);
    void settled.then(() => { if (pending.get(id) === settled) pending.delete(id); });
    return task;
  };
  const briefPath = (id) => join(base, `${parse(idSchema, id)}.md`);
  const readBrief = async (id) => {
    try {
      return await readFile(briefPath(id), 'utf8');
    } catch (cause) {
      if (cause?.code === 'ENOENT') return null;
      throw cause;
    }
  };
  const removeBrief = (id) => {
    if (!idSchema.safeParse(id).success) return Promise.resolve();
    return serial(id, () => rm(briefPath(id), { force: true }));
  };
  const writeBrief = async (id, body) => {
    if (!body.trim() || body.length > MAX_BRIEF) throw error(`The brief must contain 1–${MAX_BRIEF} characters.`, 400);
    const dest = briefPath(id);
    const temporary = `${dest}.${randomUUID()}.tmp`;
    await mkdir(base, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
      await rename(temporary, dest);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  };

  const requireAvailable = async () => {
    if (!await isEnabled()) throw error('Leads need the managed OpenCode runtime and the SuperWagie control tool', 501);
  };
  const requireSession = async (id) => {
    const session = await readSession(parse(idSchema, id));
    if (!session?.directory) throw error('Session not found', 404);
    return session;
  };
  const requireLead = async (id) => {
    const session = await requireSession(id);
    if (session.parentID || association(session) || !readLead(session.metadata) || await isArchived(id)) {
      throw error('This session is not an active lead', 409);
    }
    return session;
  };

  const editBrief = async (id, input) => {
    const { brief, edits } = parse(briefSchema, input);
    if (brief !== undefined && edits) throw error('Provide either brief or edits', 400);
    const current = await readBrief(id);
    if (brief === undefined && !edits) return { brief: current ?? '', limit: MAX_BRIEF, empty: current === null };
    let next = brief ?? current;
    if (next === null) throw error('Write a brief before editing it', 409);
    for (const { find, replace } of edits ?? []) {
      const index = next.indexOf(find);
      if (index === -1 || next.indexOf(find, index + 1) !== -1) {
        throw error('Each edit must match once. Read the current brief before retrying. Nothing was saved.', 409);
      }
      next = next.slice(0, index) + replace + next.slice(index + find.length);
    }
    await writeBrief(id, next);
    return { saved: true, length: next.length };
  };

  const writeDigest = async (session, input) => {
    if (await readBrief(session.id) === null) throw error('Write the brief before publishing a digest', 409);
    const parsed = parseDigestInput(parse(digestSchema, input), now());
    if (parsed.error) throw error(parsed.error, 400);
    let digest;
    const updated = await updateMetadata(session.id, (metadata) => {
      const lead = readLead(metadata);
      if (!lead) return null;
      const filtered = withoutDismissed(parsed.digest, lead.dismissed ?? []);
      digest = { ...filtered.digest, updatedAt: Math.max(parsed.digest.updatedAt, (lead.digest?.updatedAt ?? 0) + 1) };
      return { openchamber: { lead: { digest } } };
    }, session.directory);
    if (!updated.changed) throw error('The session stopped being a lead before the digest was saved', 409);
    return { digest };
  };

  const children = async (lead) => {
    const sessions = await listSessions();
    return { sessions: sessions.filter((session) => !session.parentID && !session.time?.archived && sameDirectory(session.directory, lead.directory) && association(session) === lead.id)
      .map(({ id, title, directory }) => ({ id, title, directory })) };
  };

  const dispatch = async (lead, input) => {
    if (!registerResult) throw error('Dispatch result delivery is unavailable', 503);
    const { sessionId, ...prompt } = parse(dispatchSchema, input);
    const at = now();
    let result;
    if (sessionId) {
      result = await serial(sessionId, async () => {
        const child = await requireSession(sessionId);
        if (association(child) !== lead.id || child.parentID || !sameDirectory(child.directory, lead.directory) || await isArchived(child.id)) {
          throw error('The session is not active work associated with this lead', 409);
        }
        return sendChild(sessionId, { ...prompt, directory: child.directory, promptedBySessionId: lead.id });
      });
    } else {
      result = await createChild({ ...prompt, directory: lead.directory }, lead.id);
    }
    const { baselineIdleRecordId, baselineAssistantMessageId: _baseline, ...publicResult } = result;
    if (result.promptDispatched !== true) {
      return { ...publicResult, resultDelivery: { status: 'not-scheduled', reason: 'OpenCode did not accept the prompt' } };
    }
    const resume = Boolean(lead.model?.providerID) && !isAdmissionManagedProvider(lead.model.providerID);
    try {
      await registerResult({
        sessionId: result.sessionId, parentSessionId: lead.id, directory: result.directory, parentDirectory: lead.directory,
        dispatchedAt: at, afterIdleId: sessionId ? baselineIdleRecordId : null, resume,
      });
    } catch {
      return { ...publicResult, resultDelivery: { status: 'not-scheduled', reason: 'The child started, but result registration failed. Read the session later.' } };
    }
    return { ...publicResult, resultDelivery: { status: 'pending', resume,
      note: resume ? 'The result will arrive when the child finishes. End your turn or work on something else.'
        : 'The result will be added to this session. It will be available on the next user-authorized turn.' } };
  };

  const executeTool = async (action, raw, directory, { contextSessionId } = {}) => {
    if (!toolActions.has(action)) throw error('Unknown lead action', 400);
    await requireAvailable();
    const lead = await requireLead(contextSessionId);
    if (!sameDirectory(directory, lead.directory)) throw error('The lead is in a different directory', 409);
    const { action: _action, ...input } = raw ?? {};
    if (action === 'lead.children') return children(lead);
    if (action === 'lead.dispatch') return dispatch(lead, input);
    return serial(lead.id, async () => {
      const current = await requireLead(lead.id);
      if (action === 'lead.brief') return editBrief(current.id, input);
      return writeDigest(current, input);
    });
  };

  const setLead = async (sessionId, enabled) => {
    await requireAvailable();
    return serial(sessionId, async () => {
      const session = await requireSession(sessionId);
      if (session.parentID || await isArchived(sessionId)) throw error('Only an active top-level session can become a lead', 409);
      const marker = enabled ? { at: now() } : null;
      let previous = null;
      const updated = await updateMetadata(sessionId, (metadata) => {
        const current = { ...session, metadata };
        if (association(current)) return null;
        const lead = readLead(metadata);
        if (Boolean(lead) === enabled) return null;
        previous = metadata?.openchamber?.lead ?? null;
        return { openchamber: { lead: marker } };
      }, session.directory);
      if (!updated.changed && association({ ...session, metadata: updated.metadata ?? session.metadata })) {
        throw error('Take over this session before making it a lead', 409);
      }
      try {
        await syncGuidance(sessionId, session.directory, enabled ? LEAD_GUIDANCE : '');
      } catch (cause) {
        if (updated.changed) {
          await updateMetadata(sessionId, (metadata) => {
            const current = readLead(metadata);
            if (marker ? current?.at !== marker.at : current !== null) return null;
            return { openchamber: { lead: previous } };
          }, session.directory);
        }
        throw cause;
      }
      return { lead: enabled };
    });
  };

  const handover = async (sessionId, leadId) => {
    await requireAvailable();
    if (sessionId === leadId) throw error('A lead cannot receive itself', 400);
    return serial(sessionId, async () => {
      const [session, lead] = await Promise.all([requireSession(sessionId), requireLead(leadId)]);
      if (session.parentID || !sameDirectory(session.directory, lead.directory) || await isArchived(sessionId)) {
        throw error('Choose an active top-level session in the same directory', 409);
      }
      const result = await updateMetadata(sessionId, (metadata) => {
        if (readLead(metadata) || association({ ...session, metadata })) return null;
        return { openchamber: { leadParentID: lead.id } };
      }, session.directory);
      if (!result.changed) throw error('The session is already a lead or is associated with one', 409);
      return { sessionId, leadId };
    });
  };

  const takeOver = async (sessionId) => {
    await requireAvailable();
    return serial(sessionId, async () => {
      const session = await requireSession(sessionId);
      await updateMetadata(sessionId, (metadata) => (association({ ...session, metadata })
        ? { openchamber: { leadParentID: null } } : null), session.directory);
      return { sessionId };
    });
  };

  return { executeTool, setLead, handover, takeOver, removeBrief, isEnabled,
    readBrief: async (sessionId) => {
      await requireAvailable();
      await requireLead(sessionId);
      return { brief: await readBrief(sessionId) };
    },
  };
};
