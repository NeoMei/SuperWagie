import { createHash } from 'node:crypto';
import { isMessageNotFoundError } from '@opencode/client';
import { z } from 'zod';

const idSchema = z.string().min(1).max(1024);
const timestampSchema = z.number().finite().nonnegative();
const canonicalMessageSchema = z.object({
  id: idSchema,
  role: z.enum(['user', 'assistant', 'tool']),
  text: z.string().max(16_100),
  partId: idSchema.optional(),
  tool: z.string().max(200).optional(),
  status: z.enum(['completed', 'error']).optional(),
}).strict();

export const segmentSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  projectId: idSchema,
  directory: z.string().min(1),
  title: z.string().max(600),
  createdAt: timestampSchema,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  messageIds: z.array(idSchema).min(1).max(512),
  providerID: idSchema.optional(),
  modelID: idSchema.optional(),
  outcome: z.enum(['succeeded', 'failed', 'interrupted', 'unknown']),
  messages: z.array(canonicalMessageSchema).min(1).max(512),
}).strict();

const pendingSchema = z.object({
  createdAt: timestampSchema,
  lastCreatedAt: timestampSchema,
  messageIds: z.array(idSchema).min(1).max(512),
  messages: z.array(canonicalMessageSchema).min(1).max(512),
  providerID: idSchema.optional(),
  modelID: idSchema.optional(),
  unsettled: z.boolean(),
}).strict();

export const checkpointSchema = z.object({
  version: z.literal(1),
  sessionId: idSchema,
  projectId: idSchema,
  directory: z.string().min(1),
  revertId: idSchema.nullable(),
  cursor: z.string().min(1).nullable(),
  anchorId: idSchema.nullable(),
  anchorHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  pending: pendingSchema.nullable(),
}).strict();

const timeSchema = z.object({ created: timestampSchema, completed: timestampSchema.nullish() });
const base = { id: idSchema, time: timeSchema };
const errorSchema = z.object({ _tag: z.string().optional(), message: z.string().optional() });
const toolContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('file') }),
]);
const toolPartSchema = z.object({
  type: z.literal('tool'), id: idSchema, name: z.string().min(1), executed: z.boolean().optional(),
  state: z.object({
    status: z.enum(['streaming', 'running', 'completed', 'error']),
    content: z.array(toolContentSchema).optional(), error: errorSchema.optional(),
    metadata: z.object({ openchamberContentShell: z.json().optional() }).optional(),
  }),
});
const contentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning') }),
  toolPartSchema,
]);
const messageSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('user'), text: z.string() }),
  z.object({ ...base, type: z.literal('assistant'), content: z.array(contentSchema),
    model: z.object({ id: idSchema, providerID: idSchema }).optional(), error: errorSchema.optional() }),
  z.object({ ...base, type: z.literal('idle'), outcome: z.enum(['succeeded', 'failed', 'interrupted']) }),
  z.object({ ...base, type: z.enum(['synthetic', 'system', 'skill', 'shell', 'compaction', 'agent-switched', 'model-switched', 'location-switched']) }),
]);
const pageSchema = z.object({ data: z.array(messageSchema), cursor: z.object({ next: z.string().nullish() }).nullish() });
const sessionSchema = z.object({
  id: idSchema, parentID: idSchema.nullish(), title: z.string().nullish(),
  location: z.object({ directory: z.string().min(1) }),
  revert: z.object({ messageID: idSchema }).nullish(),
});
const readOptionsSchema = z.object({
  sessionId: idSchema, projectId: idSchema, directory: z.string().min(1),
  includeHistory: z.boolean(), after: timestampSchema,
  pageSize: z.number().int().min(1).max(100), maxPages: z.number().int().min(1).max(32),
});

/** Reuses the capture codec so an offline committed revert cannot keep an old anchor. */
export async function validateConversationAnchor({ client, sessionId, checkpoint, signal }) {
  const stored = checkpointSchema.parse(checkpoint);
  if (stored.sessionId !== sessionId || !stored.anchorId || !stored.anchorHash) return false;
  try {
    const anchor = messageSchema.parse(await client.session.message.get(
      { sessionID: sessionId, messageID: stored.anchorId }, { signal },
    ));
    return digest(anchor) === stored.anchorHash;
  } catch (error) {
    if (isMessageNotFoundError(error)) return false;
    throw error;
  }
}
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });

// Both persisted source excerpts and generated prose cross this boundary.
// The original credential text is never retained alongside its replacement.
export function sanitizeMemoryText(text) {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:Authorization|Proxy-Authorization)\s*[:=]\s*[^\r\n]+/gi, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+/gi, '[redacted]')
    .replace(/\b(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|credential|cookie|set-cookie)\s*["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n]+)/gi, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|key|api_key|access_token|client_secret|auth|authorization|signature|sig|password|credential)=)[^\s&#)]+/gi, '$1[redacted]')
    .replace(/^.*(?:ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions|(?:system|developer)\s+(?:prompt|message)\s*:|<\|(?:im_start|im_end|system|assistant|developer)\|>|<\/?(?:system|developer|assistant)>).*$/gim, '[instruction omitted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
}

const excerpt = (text, limit) => {
  const safe = sanitizeMemoryText(text);
  return safe.length <= limit ? safe : `${safe.slice(0, limit)}\n[Source excerpt truncated]`;
};

const LOCAL_RESULT_TOOLS = new Set(['bash', 'shell', 'exec_command', 'write_stdin', 'terminal', 'apply_patch', 'edit', 'write', 'multiedit']);
const RESULT_LINE = /(?:\b(?:pass(?:ed)?|fail(?:ed|ure)?|error|warning|exit(?:ed)?|assertion|success(?:ful(?:ly)?)?|built|compiled|updated|modified|created|deleted|timeout|timed out|cancelled|interrupted|denied|refused)\b|\bHTTP\/\d[^\n]*\s[245]\d\d\b|\b\d+\s+(?:tests?|checks?)\b)/i;

function selectToolResult(part) {
  if (!LOCAL_RESULT_TOOLS.has(part.name.toLowerCase())) return '';
  const blocks = (part.state.content ?? []).filter((block) => block.type === 'text').map((block) => block.text);
  if (part.state.status === 'error' && part.state.error?.message) blocks.push(part.state.error.message);
  const lines = sanitizeMemoryText(blocks.join('\n')).split('\n').filter((line) => RESULT_LINE.test(line));
  return excerpt(lines.slice(0, 30).join('\n'), 4_000);
}

function parseSource(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw failure('conversation_memory_source_invalid', 'OpenCode returned an invalid conversation source.');
  return parsed.data;
}

async function readSource(read) {
  try { return await read(); } catch (error) {
    if (error?._tag === 'SessionNotFoundError' || error?._tag === 'MessageNotFoundError') throw error;
    throw failure('conversation_memory_source_unavailable', 'The conversation source could not be read.');
  }
}

function appendAssistant(pending, message) {
  pending.messageIds.push(message.id);
  pending.lastCreatedAt = message.time.created;
  if (message.model) {
    pending.providerID = message.model.providerID;
    pending.modelID = message.model.id;
  }
  const settled = Number.isFinite(message.time.completed);
  if (!settled) pending.unsettled = true;
  for (const part of message.content) {
    if (part.type === 'text' && settled) {
      const text = excerpt(part.text, 16_000);
      if (text) pending.messages.push({ id: message.id, role: 'assistant', text });
    }
    if (part.type !== 'tool') continue;
    if (part.state.status === 'running' || part.state.status === 'streaming') {
      pending.unsettled = true;
      continue;
    }
    // Provider-executed calls cannot substantiate a local observation.
    if (part.executed === false) continue;
    if (part.state.metadata?.openchamberContentShell) throw failure('conversation_memory_source_unavailable', 'A tool result has not been loaded.');
    const text = selectToolResult(part);
    if (text) pending.messages.push({ id: message.id, role: 'tool', text, partId: part.id, tool: excerpt(part.name, 160), status: part.state.status });
  }
}

function boundPending(pending) {
  if (!pending) return;
  if (pending.messages.length > 512 || pending.messageIds.length > 511 || pending.messages.reduce((size, message) => size + message.text.length, 0) > 96_000) {
    throw failure('conversation_memory_source_too_large', 'This conversation turn exceeds the capture limit.');
  }
}

function finishSegment(pending, end, session, options) {
  const messageIds = [...new Set([...pending.messageIds, end.id])];
  const contents = { sessionId: options.sessionId, projectId: options.projectId, directory: options.directory,
    title: excerpt(session.title ?? '', 500), createdAt: pending.createdAt, messageIds,
    outcome: end.outcome, messages: pending.messages };
  if (pending.providerID) contents.providerID = pending.providerID;
  if (pending.modelID) contents.modelID = pending.modelID;
  const sourceHash = digest(contents);
  return segmentSchema.parse({
    ...contents,
    id: `segment_${digest([options.projectId, options.directory, options.sessionId, messageIds[0], end.id, sourceHash]).slice(0, 24)}`,
    sourceHash,
  });
}

/** Reads one bounded, resumable suffix. Only a persisted idle record closes a turn. */
export async function readConversationSegments({ client, checkpoint = null, includeHistory = false, after = 0, pageSize = 100, maxPages = 8, ...scope }) {
  const options = readOptionsSchema.parse({ ...scope, includeHistory, after, pageSize, maxPages });
  const session = parseSource(sessionSchema, await readSource(() => client.session.get({ sessionID: options.sessionId })));
  if (session.id !== options.sessionId || session.location.directory !== options.directory) {
    throw failure('source_directory_changed', 'The conversation no longer belongs to the requested directory.');
  }
  const revertId = session.revert?.messageID ?? null;
  const freshCheckpoint = () => ({ version: 1, sessionId: options.sessionId, projectId: options.projectId,
    directory: options.directory, revertId, cursor: null, anchorId: null, anchorHash: null, pending: null });
  const parsedCheckpoint = checkpointSchema.safeParse(checkpoint);
  let current = parsedCheckpoint.success ? parsedCheckpoint.data : freshCheckpoint();
  let reset = checkpoint !== null && (!parsedCheckpoint.success || current.sessionId !== options.sessionId || current.projectId !== options.projectId
    || current.directory !== options.directory || current.revertId !== revertId);
  if (reset) current = freshCheckpoint();
  if (session.parentID) return { segments: [], checkpoint: freshCheckpoint(), reset: checkpoint !== null, sourceMessageIds: [], complete: true };

  let boundary = null;
  if (revertId) {
    try { boundary = parseSource(messageSchema, await readSource(() => client.session.message.get({ sessionID: options.sessionId, messageID: revertId }))); }
    catch { throw failure('conversation_memory_source_unavailable', 'The conversation revert boundary could not be read.'); }
  }
  if (current.anchorId) {
    let anchor;
    try { anchor = parseSource(messageSchema, await readSource(() => client.session.message.get({ sessionID: options.sessionId, messageID: current.anchorId }))); }
    catch (error) {
      if (error?._tag !== 'MessageNotFoundError') throw error;
    }
    if (!anchor || digest(anchor) !== current.anchorHash) {
      reset = true;
      current = freshCheckpoint();
    }
  }
  const segments = [];
  const sourceMessageIds = [];
  const finish = async (nextCheckpoint, complete) => {
    const latest = parseSource(sessionSchema, await readSource(() => client.session.get({ sessionID: options.sessionId })));
    if (latest.id !== options.sessionId || latest.location.directory !== options.directory) {
      throw failure('source_directory_changed', 'The conversation no longer belongs to the requested directory.');
    }
    if (latest.parentID !== session.parentID || (latest.revert?.messageID ?? null) !== revertId) {
      throw failure('conversation_memory_source_changed', 'The conversation changed while its sources were being read.');
    }
    return { segments, checkpoint: checkpointSchema.parse(nextCheckpoint), reset, sourceMessageIds, complete };
  };
  const seenCursors = new Set();
  let safeBeforeUnsettled = null;
  let cursorReset = false;
  for (let pageIndex = 0; pageIndex < options.maxPages; pageIndex += 1) {
    const beforePage = structuredClone(current);
    let raw;
    try {
      raw = await client.message.list({ sessionID: options.sessionId, limit: options.pageSize,
        ...(current.cursor ? { cursor: current.cursor } : { order: 'asc' }) });
    } catch (error) {
      if (current.cursor && !cursorReset && ['InvalidCursorError', 'InvalidRequestError'].includes(error?._tag)) {
        current = freshCheckpoint(); reset = true; cursorReset = true; pageIndex -= 1;
        segments.length = 0; sourceMessageIds.length = 0; seenCursors.clear();
        continue;
      }
      throw failure('conversation_memory_source_unavailable', 'The conversation source could not be read.');
    }
    const page = parseSource(pageSchema, raw);
    for (const message of page.data) {
      if (boundary && (message.id === boundary.id || message.time.created > boundary.time.created)) {
        return finish(beforePage, true);
      }
      sourceMessageIds.push(message.id);
      if (message.type === 'user') {
        const authored = { id: message.id, role: 'user', text: excerpt(message.text, 16_000) };
        if (current.pending) {
          current.pending.messageIds.push(message.id);
          current.pending.messages.push(authored);
          current.pending.lastCreatedAt = message.time.created;
        } else {
          current.pending = { createdAt: message.time.created, lastCreatedAt: message.time.created,
            messageIds: [message.id], messages: [authored], unsettled: false };
        }
      } else if (message.type === 'assistant' && current.pending) {
        appendAssistant(current.pending, message);
        if (current.pending.unsettled && !safeBeforeUnsettled) safeBeforeUnsettled = beforePage;
      } else if (message.type === 'idle' && current.pending) {
        if (current.pending.unsettled && message.outcome === 'succeeded') {
          return finish(safeBeforeUnsettled ?? beforePage, true);
        }
        if (options.includeHistory || message.time.created > options.after) segments.push(finishSegment(current.pending, message, session, options));
        current.pending = null;
        safeBeforeUnsettled = null;
      }
      boundPending(current.pending);
    }
    const next = page.cursor?.next ?? null;
    if (next && seenCursors.has(next)) throw failure('conversation_memory_source_invalid', 'OpenCode repeated a conversation cursor.');
    if (next) seenCursors.add(next);
    if (page.data.length && !next) throw failure('conversation_memory_source_invalid', 'OpenCode omitted a conversation cursor.');
    if (page.data.length) {
      current.cursor = next;
      current.anchorId = page.data.at(-1).id;
      current.anchorHash = digest(page.data.at(-1));
    }
    if (!next || page.data.length < options.pageSize) {
      return finish(safeBeforeUnsettled ?? current, true);
    }
  }
  return finish(safeBeforeUnsettled ?? current, false);
}
