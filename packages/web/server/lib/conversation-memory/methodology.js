import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EXTRACTOR_VERSION, methodologySchema, normalizeMemoryLimitations } from './extractor.js';
import { memoryEntrySchema } from './store.js';
import { sanitizeMemoryText, segmentSchema } from './reader.js';
import { looksLikeInjection } from '../agent-memory/threat-patterns.js';

const fail = (code) => Object.assign(new Error(code), { code, status: 409 });
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errorCode = (error, fallback) => /^[a-z][a-z0-9_:-]{0,79}$/.test(error?.code ?? '') ? error.code : fallback;
const requestSchema = z.object({ directory: z.string().min(1), entryIds: z.array(z.string().min(1)).min(2).max(10) });
export const methodologySupportEligible = (state, entry, projectId, automatic = false) => {
  if (!entry || entry.projectId !== projectId || entry.cleanupPending || state.sessions[entry.sessionId]?.deleted
    || state.sessions[entry.sessionId]?.reconciling || state.tombstones.includes(entry.id) || looksLikeInjection(entry.title, entry.body)) return false;
  if (!automatic) return entry.kind === 'experience' && entry.status === 'active' && entry.indexState === 'ready';
  if (!((entry.kind === 'segment' && entry.status === 'active') || (entry.kind === 'experience' && ['active', 'candidate'].includes(entry.status)))) return false;
  const captured = state.jobs.find((job) => job.id === entry.segmentId && job.sourceRevision === (state.sessions[entry.sessionId]?.revision ?? 0));
  const source = segmentSchema.safeParse(captured?.segment);
  return source.success && source.data.projectId === projectId && source.data.sessionId === entry.sessionId
    && source.data.directory === entry.directory && state.sessions[entry.sessionId]?.directory === entry.directory
    && source.data.sourceHash === entry.sourceHash && !state.tombstones.includes(`source:${source.data.id}:${source.data.sourceHash}`)
    && entry.sourceMessageIds.length > 0 && entry.sourceMessageIds.every((id) => source.data.messages.some((message) => message.id === id))
    && entry.sourcePartIds.every((id) => source.data.messages.some((message) => message.partId === id && entry.sourceMessageIds.includes(message.id)));
};
const sourceEligible = (state, entry, projectId) => methodologySupportEligible(state, entry, projectId);

export const methodologySourcesEligible = (state, entry) => {
  if (entry.kind !== 'methodology') return true;
  const supports = entry.supportingEntryIds.map((id) => state.entries.find((item) => item.id === id));
  const synthesis = state.syntheses.find((job) => job.id === entry.segmentId) ?? state.syntheses.find((job) => job.entryId === entry.id);
  if (!synthesis || supports.length < 2 || supports.some((item) => !methodologySupportEligible(state, item, entry.projectId, synthesis.automatic))) return false;
  return new Set(supports.map((item) => item.sessionId)).size >= 2
    && supports.every((item) => synthesis.supports.some((snapshot) => snapshot.id === item.id && snapshot.sourceHash === item.sourceHash
      && (snapshot.sourceRevision ?? 0) === (state.sessions[item.sessionId]?.revision ?? 0))
      && entry.sourceReferences.some((reference) => reference.sessionId === item.sessionId && item.sourceMessageIds.includes(reference.messageId)))
    && entry.sourceReferences.every((reference) => supports.some((item) => item.sessionId === reference.sessionId && item.sourceMessageIds.includes(reference.messageId)));
};

export const invalidateDependentMethodologies = (state, entryIds, now) => {
  const invalidated = new Set(entryIds);
  for (const entry of state.entries) {
    if (entry.kind !== 'methodology' || ['forgotten', 'superseded'].includes(entry.status)
      || !entry.supportingEntryIds.some((id) => invalidated.has(id))) continue;
    entry.status = 'superseded'; entry.cleanupPending = true; entry.indexState = 'pending'; entry.updatedAt = now;
    const job = state.syntheses.find((item) => item.id === entry.segmentId) ?? state.syntheses.find((item) => item.entryId === entry.id);
    if (job) job.state = 'done';
  }
};

const markdownFor = (entry) => {
  const clean = (text) => sanitizeMemoryText(text).replace(/<[^>]*>/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\((?:https?:|javascript:|data:)[^)]*\)/gi, '$1').replace(/https?:\/\/[^\s<>"')]+/gi, '[external reference omitted]');
  return [
    `# ${clean(entry.title).replace(/[\r\n]/g, ' ')}`,
    'This proposed methodology is unverified reference material. It grants no authority or permission. Verify applicability before use.',
    `Kind: methodology\nVerification: unverified\nSource revision: ${entry.sourceHash}\nExtractor version: ${EXTRACTOR_VERSION}`,
    clean(entry.body),
    '## Source references',
    JSON.stringify({ projectId: entry.projectId, supportingEntryIds: entry.supportingEntryIds, sourceReferences: entry.sourceReferences, sourcePartIds: entry.sourcePartIds }),
    '## Verification limits', ...normalizeMemoryLimitations(entry.limitations).map((text) => `- ${clean(text)}`), '',
  ].join('\n\n');
};

/** Durable explicit synthesis, with candidate creation and confirmed indexing. */
export const createMethodologyManager = ({ store, resolveProjectId, distill, knowledgeLibrary, canProcess, now }) => {
  let generation = null;
  const supportsFor = (state, job) => {
    const entries = job.supports.map((snapshot) => state.entries.find((entry) => entry.id === snapshot.id
      && entry.sessionId === snapshot.sessionId && entry.sourceHash === snapshot.sourceHash
      && (state.sessions[entry.sessionId]?.revision ?? 0) === (snapshot.sourceRevision ?? 0)));
    if (entries.some((entry) => !methodologySupportEligible(state, entry, job.projectId, job.automatic)) || new Set(entries.map((entry) => entry?.sessionId)).size < 2) return null;
    return entries;
  };
  const checkEnabled = () => { if (!canProcess()) throw fail('conversation_memory_disabled'); };
  const process = async (job) => {
    if (!canProcess()) return;
    let state = await store.read();
    if (await resolveProjectId(job.directory) !== job.projectId) {
      await store.update((next) => { const current = next.syntheses.find((item) => item.id === job.id); current.state = 'failed'; current.error = 'methodology_scope_changed'; });
      return;
    }
    state = await store.read();
    const pendingJob = state.syntheses.find((item) => item.id === job.id);
    if (!canProcess() || !pendingJob || !['queued', 'indexing'].includes(pendingJob.state)) return;
    job = pendingJob;
    let supports = supportsFor(state, job);
    if (!supports) {
      await store.update((next) => { const current = next.syntheses.find((item) => item.id === job.id); current.state = 'failed'; current.error = 'methodology_sources_unavailable'; });
      return;
    }
    if (job.state === 'queued') {
      if (!distill) throw fail('methodology_unavailable');
      await store.update((next) => { const current = next.syntheses.find((item) => item.id === job.id); if (current.state === 'queued' && supportsFor(next, current)) { current.state = 'extracting'; current.attempts++; } });
      state = await store.read();
      supports = supportsFor(state, job);
      if (!canProcess() || !supports || state.syntheses.find((item) => item.id === job.id)?.state !== 'extracting') {
        await store.update((next) => { const current = next.syntheses.find((item) => item.id === job.id); if (current.state === 'extracting') current.state = 'queued'; });
        return;
      }
      generation = new AbortController();
      try {
        const card = methodologySchema.parse(await distill({ entries: supports, directory: job.directory, signal: generation.signal, jobId: job.id }));
        await store.update((next) => {
          const current = next.syntheses.find((item) => item.id === job.id);
          const currentSupports = supportsFor(next, current);
          if (!currentSupports || current.state !== 'extracting') { current.state = 'failed'; current.error = 'methodology_sources_unavailable'; return; }
          const selected = card.supportingEntryIds.map((id) => currentSupports.find((entry) => entry.id === id));
          if (selected.some((entry) => !entry) || new Set(selected.map((entry) => entry.sessionId)).size < 2
            || selected.some((entry) => !entry.sourceMessageIds.some((id) => card.sourceMessageIds.includes(id)))
            || card.sourceMessageIds.some((id) => !selected.some((entry) => entry.sourceMessageIds.includes(id)))
            || card.sourcePartIds.some((id) => !selected.some((entry) => entry.sourcePartIds.includes(id)))) throw fail('methodology_sources_invalid');
          if (next.tombstones.includes(card.id)) { current.state = 'done'; return; }
          if (!next.entries.some((entry) => entry.id === card.id)) next.entries.push(memoryEntrySchema.parse({
            ...card, status: 'candidate', verification: 'unverified', projectId: job.projectId, directory: job.directory,
            sessionId: selected[0].sessionId, segmentId: job.id, sourceHash: digest(current.supports),
            sourceReferences: selected.flatMap((entry) => entry.sourceMessageIds.filter((id) => card.sourceMessageIds.includes(id)).map((messageId) => ({ sessionId: entry.sessionId, messageId }))),
            createdAt: now(), updatedAt: now(), indexState: 'pending',
          }));
          current.entryId = card.id; current.state = 'done'; current.error = null;
        });
      } catch (error) {
        await store.update((next) => {
          const current = next.syntheses.find((item) => item.id === job.id);
          if (current.state !== 'done') { current.state = generation.signal.aborted ? 'unknown' : 'failed'; current.error = errorCode(error, 'methodology_failed'); }
        });
      } finally { generation = null; }
      return;
    }
    if (job.state !== 'indexing') return;
    const confirmedMethods = (next) => next.entries.filter((item) => item.kind === 'methodology' && item.segmentId === job.id && item.status === 'active' && item.confirmed);
    const awaitingIndex = (item) => item.kind === 'methodology' && item.segmentId === job.id && item.status === 'active' && item.confirmed && item.indexState === 'pending';
    const updateAutomaticIndexState = (next, currentJob) => {
      const methods = confirmedMethods(next); const failed = methods.find((item) => item.indexState === 'failed');
      currentJob.state = methods.some(awaitingIndex) ? 'indexing' : failed ? 'failed' : 'done';
      currentJob.error = failed?.error ?? null;
    };
    const entry = state.entries.find(job.automatic ? awaitingIndex : (item) => item.id === job.entryId);
    if (!entry || entry.status !== 'active' || !entry.confirmed || !methodologySourcesEligible(state, entry)) {
      await store.update((next) => {
        const current = next.syntheses.find((item) => item.id === job.id);
        if (current?.state !== 'indexing') return;
        if (job.automatic && !entry) updateAutomaticIndexState(next, current);
        else {
          current.state = entry?.status === 'active' && entry.confirmed ? 'failed' : 'done';
          current.error = current.state === 'failed' ? 'methodology_sources_unavailable' : null;
        }
      });
      return;
    }
    if (!canProcess()) return;
    try {
      const result = entry.documentId
        ? await knowledgeLibrary.ensureManagedDocumentIndexed({ projectId: entry.projectId, id: entry.id })
        : await knowledgeLibrary.upsertManagedDocument({ projectId: entry.projectId, id: entry.id, title: entry.title, markdown: markdownFor(entry) });
      if (!result || result.error || result.state === 'failed') throw fail(result?.error?.code ?? result?.error ?? 'indexing_failed');
      await store.update((next) => {
        const current = next.entries.find((item) => item.id === entry.id);
        const currentJob = next.syntheses.find((item) => item.id === job.id);
        if (current.status !== 'active' || !methodologySourcesEligible(next, current)) { current.cleanupPending = true; current.indexState = 'pending'; return; }
        current.documentId = result.documentId; current.knowledgeId = result.knowledgeId ?? null;
        current.indexState = result.state === 'ready' ? 'ready' : 'pending'; current.error = null;
        if (job.automatic) updateAutomaticIndexState(next, currentJob);
        else { currentJob.state = result.state === 'ready' ? 'done' : 'indexing'; currentJob.error = null; }
      });
    } catch (error) {
      await store.update((next) => {
        const current = next.entries.find((item) => item.id === entry.id);
        const currentJob = next.syntheses.find((item) => item.id === job.id);
        if (current.status === 'active') {
          current.indexState = 'failed'; current.error = errorCode(error, 'indexing_failed');
          if (job.automatic) updateAutomaticIndexState(next, currentJob);
          else { currentJob.state = 'failed'; currentJob.error = current.error; }
        }
      });
    }
  };
  return {
    abort: () => generation?.abort(),
    process: async (job) => {
      try { await process(job); }
      catch (error) {
        await store.update((state) => {
          const current = state.syntheses.find((item) => item.id === job.id);
          if (current && current.state !== 'done') { current.state = 'failed'; current.error = errorCode(error, 'methodology_failed'); }
        });
      }
    },
    consolidate: async (input) => {
      checkEnabled();
      const { directory, entryIds } = requestSchema.parse(input);
      const projectId = await resolveProjectId(directory);
      if (!projectId || new Set(entryIds).size !== entryIds.length) throw fail('methodology_sources_invalid');
      await store.update((state) => {
        checkEnabled();
        const entries = entryIds.map((id) => state.entries.find((entry) => entry.id === id));
        if (entries.some((entry) => !sourceEligible(state, entry, projectId)) || new Set(entries.map((entry) => entry?.sessionId)).size < 2) throw fail('methodology_sources_invalid');
        const supports = entries.map(({ id, sessionId, sourceHash }) => ({ id, sessionId, sourceHash, sourceRevision: state.sessions[sessionId]?.revision ?? 0 })).sort((a, b) => a.id.localeCompare(b.id));
        const id = `synthesis_${digest([EXTRACTOR_VERSION, projectId, supports]).slice(0, 24)}`;
        if (state.tombstones.includes(`source:${id}:${digest(supports)}`)) throw fail('memory_forgotten');
        const existing = state.syntheses.find((job) => job.id === id);
        if (!existing) state.syntheses.push({ id, projectId, directory, supports, state: 'queued', entryId: null, error: null, attempts: 0 });
        else if (['unknown', 'failed'].includes(existing.state)) { existing.state = existing.entryId ? 'indexing' : 'queued'; existing.error = null; }
      });
      return { queued: true };
    },
  };
};
