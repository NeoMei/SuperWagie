import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { EXTRACTOR_VERSION } from './extractor.js';

export const memoryEntrySchema = z.object({
  id: z.string().min(1), kind: z.enum(['segment', 'experience', 'methodology']),
  title: z.string(), body: z.string(), status: z.enum(['candidate', 'active', 'superseded', 'forgotten']),
  verification: z.enum(['observed', 'unverified']), indexState: z.enum(['pending', 'ready', 'failed']),
  projectId: z.string().min(1), directory: z.string().min(1), sessionId: z.string().min(1),
  segmentId: z.string().min(1), sourceHash: z.string().min(1),
  sourceMessageIds: z.array(z.string()), sourcePartIds: z.array(z.string()).default([]), limitations: z.array(z.string()),
  createdAt: z.number(), updatedAt: z.number(), documentId: z.string().nullable().default(null),
  knowledgeId: z.string().nullable().default(null), error: z.string().nullable().default(null),
  cleanupPending: z.boolean().default(false),
  confirmed: z.boolean().default(false),
  extractorVersion: z.string().min(1).default(EXTRACTOR_VERSION),
  supportingEntryIds: z.array(z.string()).default([]),
  sourceReferences: z.array(z.object({ sessionId: z.string(), messageId: z.string() })).default([]),
});

export const conversationMemoryStateSchema = z.object({
  version: z.literal(1), enabled: z.boolean(), enabledAt: z.number(),
  pending: z.array(z.object({ sessionId: z.string(), directory: z.string(), includeHistory: z.boolean() })),
  // Reader and extractor own the opaque source/checkpoint codecs and reparse
  // them before use; this store owns only durable processing transitions.
  sessions: z.record(z.string(), z.object({
    directory: z.string(), checkpoint: z.json().nullable(), reconciling: z.boolean().default(false), segmentIds: z.array(z.string()).default([]),
    revision: z.number().int().nonnegative().default(0), deleted: z.boolean().default(false), historyAllowed: z.boolean().default(false),
  })),
  jobs: z.array(z.object({
    id: z.string(), segment: z.json(), state: z.enum(['queued', 'extracting', 'indexing', 'done', 'failed', 'unknown']),
    extractorVersion: z.string().min(1).default(EXTRACTOR_VERSION),
    error: z.string().nullable(), attempts: z.number().int().nonnegative(), sourceRevision: z.number().int().nonnegative().default(0),
    generated: z.json().nullable().default(null),
  })),
  syntheses: z.array(z.object({
    id: z.string(), projectId: z.string(), directory: z.string(),
    supports: z.array(z.object({ id: z.string(), sessionId: z.string(), sourceHash: z.string(), sourceRevision: z.number().int().nonnegative().default(0) })).min(2),
    state: z.enum(['queued', 'extracting', 'indexing', 'done', 'failed', 'unknown']),
    entryId: z.string().nullable(), error: z.string().nullable(), attempts: z.number().int().nonnegative(),
    automatic: z.boolean().default(false), generated: z.json().nullable().default(null),
    continuation: z.json().nullable().default(null),
  })).default([]),
  entries: z.array(memoryEntrySchema), tombstones: z.array(z.string()),
  lastError: z.string().nullable(),
  engine: z.object({
    records: z.array(z.object({ collection: z.string().min(1).max(100), id: z.string().min(1).max(1024), projectId: z.string().min(1), value: z.json() })).default([]),
    projections: z.array(z.object({ id: z.string(), projectId: z.string(), sourceSessionIds: z.array(z.string()), operations: z.array(z.json()), state: z.enum(['pending', 'done', 'failed']), error: z.string().nullable().default(null) })).default([]),
    dirtyProjects: z.array(z.string()).default([]),
    continuations: z.record(z.string(), z.json()).default({}),
    migrated: z.boolean().default(false),
  }).default({ records: [], projections: [], dirtyProjects: [], continuations: {}, migrated: false }),
});
const emptyState = () => conversationMemoryStateSchema.parse({ version: 1, enabled: false, enabledAt: 0, pending: [], sessions: {}, jobs: [], syntheses: [], entries: [], tombstones: [], lastError: null });

export const createConversationMemoryStore = ({ dataDir }) => {
  const directory = path.join(dataDir, 'conversation-memory');
  const file = path.join(directory, 'state.json');
  let cached = null;
  let queue = Promise.resolve();
  const load = async () => {
    if (cached) return cached;
    try {
      cached = conversationMemoryStateSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      cached = emptyState();
    }
    return cached;
  };
  const update = (change) => {
    const operation = queue.then(async () => {
      const draft = structuredClone(await load());
      change(draft);
      const next = conversationMemoryStateSchema.parse(draft);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await fs.rename(temporary, file);
      cached = next;
      return structuredClone(next);
    });
    queue = operation.catch(() => {});
    return operation;
  };
  return {
    read: async () => { await queue; return structuredClone(await load()); },
    update,
  };
};
