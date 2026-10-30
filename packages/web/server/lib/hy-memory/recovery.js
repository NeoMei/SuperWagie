import { segmentSchema } from '../conversation-memory/reader.js';
import { EXTRACTOR_VERSION } from '../conversation-memory/extractor.js';
import { z } from 'zod';

const retrySchema = z.object({ attempts: z.number().int().nonnegative(), nextRetryAt: z.number().finite().nonnegative().nullable(), error: z.string().nullable() });
const legacySchema = z.object({ documentId: z.string().nullable(), knowledgeId: z.string().nullable(), retired: z.boolean(), error: z.string().nullable() });

const retryableErrors = new Set([
  'backend_unavailable', 'memory_backend_unavailable', 'knowledge_backend_unavailable',
  'backend_request_failed', 'backend_request_timeout', 'request_timeout', 'hy_commit_failed',
  'indexing_failed', 'index_failed', 'memory_projection_missing', 'state_conflict',
  'unavailable', 'timeout', 'backend_error', 'conflict',
  'hy_space_migration_pending',
]);
const safeCode = (error) => /^[a-z][a-z0-9_:-]{0,79}$/.test(error?.code ?? '') ? error.code : 'legacy_cleanup_failed';
const sourceValid = (state, job) => {
  const parsed = segmentSchema.safeParse(job.segment);
  if (!parsed.success) return false;
  const segment = parsed.data;
  const session = state.sessions[segment.sessionId];
  return job.id === segment.id && session && !session.deleted && !session.reconciling
    && session.directory === segment.directory && session.revision === job.sourceRevision;
};
const storedCards = (state, job) => state.entries.filter((entry) => entry.segmentId === job.id
  && ['active', 'candidate'].includes(entry.status) && !entry.cleanupPending && !state.tombstones.includes(entry.id)
  && entry.sourceHash === job.segment.sourceHash && entry.sessionId === job.segment.sessionId
  && entry.projectId === job.segment.projectId && entry.directory === job.segment.directory);

/** Version compatibility permits deterministic indexing of retained cards only. */
export const storedJobCanIndex = (state, job) => job.extractorVersion === EXTRACTOR_VERSION && job.state === 'indexing'
  && sourceValid(state, job) && storedCards(state, job).some((entry) => state.engine.records.some((record) => record.collection === 'legacy-projection'
    && record.projectId === entry.projectId && record.id === entry.id));

/** Recovery never repeats generation without a complete durable result. */
export function createHyRecovery({ store, now = () => Date.now(), baseDelayMs = 2000, maxAttempts = 3, removeLegacy = null }) {
  return {
    async migrate() {
      let migrated = 0;
      await store.update((state) => {
        if (state.engine.migrated) return;
        for (const entry of state.entries) {
          if (entry.extractorVersion !== EXTRACTOR_VERSION || !['active', 'candidate'].includes(entry.status)
            || entry.cleanupPending || state.tombstones.includes(entry.id) || state.sessions[entry.sessionId]?.deleted) continue;
          if (!state.engine.records.some((record) => record.collection === 'legacy-projection' && record.projectId === entry.projectId && record.id === entry.id)) {
            state.engine.records.push({ collection: 'legacy-projection', projectId: entry.projectId, id: entry.id,
              value: { documentId: entry.documentId, knowledgeId: entry.knowledgeId, retired: false, error: null } });
          }
          entry.documentId = null; entry.knowledgeId = null; entry.indexState = 'pending'; entry.error = null;
          const job = state.jobs.find((item) => item.id === entry.segmentId);
          if (job && sourceValid(state, job)) { job.state = 'indexing'; job.error = null; }
          const synthesis = state.syntheses.find((item) => item.id === entry.segmentId);
          if (synthesis && synthesis.entryId === entry.id) { synthesis.state = 'indexing'; synthesis.error = null; }
          migrated++;
        }
        state.engine.migrated = true;
      });
      return { migrated };
    },
    async schedule() {
      let scheduled = 0; let nextRetryAt = null;
      await store.update((state) => {
        for (const [kind, jobs] of [['capture', state.jobs], ['synthesis', state.syntheses]]) {
          for (const job of jobs) {
            if (job.state !== 'failed' || !retryableErrors.has(job.error)) continue;
            let cards = [];
            if (kind === 'capture') {
              if (!sourceValid(state, job)) continue;
              cards = storedCards(state, job);
              if (!job.generated && !cards.length && job.error !== 'hy_space_migration_pending') continue;
              if (!cards.length && state.tombstones.includes(`source:${job.segment.id}:${job.segment.sourceHash}`)) continue;
            } else {
              if (!job.generated || !job.supports.every((support) => {
                const entry = state.entries.find((item) => item.id === support.id);
                const session = state.sessions[support.sessionId];
                return entry && entry.projectId === job.projectId && ['active', 'candidate'].includes(entry.status) && !entry.cleanupPending
                  && !state.tombstones.includes(entry.id) && entry.sourceHash === support.sourceHash
                  && session && !session.deleted && !session.reconciling && session.revision === support.sourceRevision;
              })) continue;
              cards = state.entries.filter((entry) => entry.segmentId === job.id && ['active', 'candidate'].includes(entry.status) && !entry.cleanupPending);
            }
            const id = `${kind}:${job.id}`;
            let record = state.engine.records.find((item) => item.collection === 'hy-retry' && item.id === id);
            if (!record) {
              record = { collection: 'hy-retry', id, projectId: kind === 'capture' ? job.segment.projectId : job.projectId,
                value: { attempts: 0, nextRetryAt: null, error: null } };
              state.engine.records.push(record);
            }
            const parsedRetry = retrySchema.safeParse(record.value);
            if (!parsedRetry.success) { job.error = 'hy_retry_state_invalid'; continue; }
            const retry = parsedRetry.data; record.value = retry;
            if (retry.nextRetryAt === null) {
              if (retry.attempts >= maxAttempts) continue;
              retry.nextRetryAt = now() + baseDelayMs * (2 ** retry.attempts);
              retry.error = job.error;
            }
            if (retry.nextRetryAt > now()) {
              nextRetryAt = nextRetryAt === null ? retry.nextRetryAt : Math.min(nextRetryAt, retry.nextRetryAt);
              continue;
            }
            const missingProjection = job.error === 'memory_projection_missing';
            job.state = !cards.length && (job.generated || job.error === 'hy_space_migration_pending') ? 'queued' : 'indexing'; job.error = null;
            for (const entry of cards) if (entry.status === 'active') {
              entry.indexState = 'pending'; entry.error = null;
              if (missingProjection) { entry.documentId = null; entry.knowledgeId = null; }
            }
            retry.attempts++; retry.nextRetryAt = null; scheduled++;
          }
        }
      });
      return { scheduled, nextRetryAt };
    },
    async reset({ id, kind = 'capture' }) {
      await store.update((state) => { state.engine.records = state.engine.records.filter((record) => record.collection !== 'hy-retry' || record.id !== `${kind}:${id}`); });
    },
    async retireLegacy() {
      let retired = 0; let pending = 0;
      if (!removeLegacy) return { retired, pending };
      const state = await store.read();
      for (const record of state.engine.records.filter((row) => row.collection === 'legacy-projection')) {
        const legacy = legacySchema.safeParse(record.value);
        if (!legacy.success) { pending++; continue; }
        if (legacy.data.retired) continue;
        const entry = state.entries.find((item) => item.id === record.id && item.projectId === record.projectId);
        if (!entry || entry.status === 'active' && (entry.indexState !== 'ready' || entry.cleanupPending)) continue;
        try {
          const result = await removeLegacy({ projectId: record.projectId, id: record.id });
          if (result?.error) throw Object.assign(new Error('Legacy cleanup failed'), { code: 'legacy_cleanup_failed' });
          await store.update((next) => {
            const current = next.engine.records.find((row) => row.collection === 'legacy-projection' && row.id === record.id && row.projectId === record.projectId);
            if (current) current.value = { documentId: null, knowledgeId: null, retired: true, error: null };
          });
          retired++;
        } catch (error) {
          pending++;
          await store.update((next) => {
            const current = next.engine.records.find((row) => row.collection === 'legacy-projection' && row.id === record.id && row.projectId === record.projectId);
            if (current) current.value.error = safeCode(error);
          });
        }
      }
      return { retired, pending };
    },
  };
}
