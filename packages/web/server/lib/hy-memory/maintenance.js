import { createHash } from 'node:crypto';
import { z } from 'zod';
import { memoryEntrySchema } from '../conversation-memory/store.js';
import { methodologySchema } from '../conversation-memory/extractor.js';
import { methodologySupportEligible } from '../conversation-memory/methodology.js';
import { prepareHyResult, appendHyProjection, applyHyProjection, hyBatchId } from './results.js';
import { memoryNamespace } from './organizer.js';

const VERSION = 'hy-memory-2.0.8:sw1:s2';
const digest = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const fail = (code) => Object.assign(new Error(code), { code });
const errorCode = (error) => /^[a-z][a-z0-9_:-]{0,79}$/.test(error?.code ?? '') ? error.code : 'hy_maintenance_failed';
const cursorSchema = z.object({ cursor: z.json(), previousJobId: z.string(), pass: z.number().int().nonnegative() });
const generatedSchema = z.object({ cards: z.array(z.json()).default([]), deferredCards: z.array(z.json()).default([]),
  operations: z.array(z.json()).default([]) }).passthrough();
const deferredSchema = z.object({ sourceRefs: z.array(z.object({ sessionId: z.string(), messageId: z.string(), partId: z.string().optional(),
  sourceHash: z.string(), sourceRevision: z.number().int().nonnegative().nullish() })).min(2) }).passthrough();
const proposalRevision = (entry) => digest([entry.title, entry.body, entry.limitations, entry.sourceHash,
  [...entry.supportingEntryIds].sort(), [...entry.sourceMessageIds].sort(), [...entry.sourcePartIds].sort(),
  entry.sourceReferences.map((ref) => [ref.sessionId, ref.messageId]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))]);
const snapshots = (state, entries) => entries.map(({ id, sessionId, sourceHash }) => ({ id, sessionId, sourceHash, sourceRevision: state.sessions[sessionId]?.revision ?? 0 }));
const sourceEntries = (state, job) => {
  const entries = job.supports.map((snapshot) => state.entries.find((entry) => entry.id === snapshot.id && entry.sessionId === snapshot.sessionId
    && entry.sourceHash === snapshot.sourceHash && (state.sessions[entry.sessionId]?.revision ?? 0) === snapshot.sourceRevision));
  return entries.length >= 2 && new Set(entries.map((entry) => entry?.sessionId)).size >= 2
    && entries.every((entry) => methodologySupportEligible(state, entry, job.projectId, job.automatic)) ? entries : null;
};
const withSourceRefs = (state, entries) => entries.map((entry) => {
  const captured = state.jobs.find((job) => job.id === entry.segmentId && job.segment?.sourceHash === entry.sourceHash);
  const source = captured?.segment;
  if (!source?.messages) throw fail('methodology_sources_unavailable');
  return { ...entry, sourceRefs: source.messages.filter((message) => entry.sourceMessageIds.includes(message.id)
    && (!message.partId || entry.sourcePartIds.includes(message.partId))).map((message) => {
    const reference = { sessionId: entry.sessionId, messageId: message.id, sourceHash: source.sourceHash, sourceRevision: captured.sourceRevision };
    if (message.partId) reference.partId = message.partId;
    return reference;
  }) };
});
const firstSegment = (state, supports) => state.jobs.find((job) => job.id === supports[0].segmentId)?.segment;
const selectedSupports = (card, supports) => {
  const selected = card.supportingEntryIds.map((id) => supports.find((entry) => entry.id === id));
  if (selected.length < 2 || selected.some((entry) => !entry) || new Set(selected.map((entry) => entry.sessionId)).size < 2
    || selected.some((entry) => !card.sourceReferences.some((ref) => ref.sessionId === entry.sessionId && entry.sourceMessageIds.includes(ref.messageId)))
    || card.sourceReferences.some((ref) => !selected.some((entry) => entry.sessionId === ref.sessionId && entry.sourceMessageIds.includes(ref.messageId)))
    || card.sourcePartIds.some((id) => !selected.some((entry) => entry.sourcePartIds.includes(id)))) throw fail('methodology_sources_invalid');
  return selected;
};
const selectBatch = (state, projectId) => {
  const entries = state.entries.filter((entry) => methodologySupportEligible(state, entry, projectId, true))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  if (entries.length < 2) return [];
  const other = entries.find((entry) => entry.sessionId !== entries[0].sessionId);
  if (!other) return [];
  const selected = [entries[0], other];
  for (const entry of entries) if (selected.length < 10 && !selected.includes(entry)) selected.push(entry);
  return selected.sort((left, right) => left.id.localeCompare(right.id));
};

/** Source-bound S2 batches share the existing durable synthesis and projection queues. */
export const createHyMaintenance = ({ store, organizer, backend, canProcess, now, verifySources }) => {
  let generation = null;
  const checkSources = async (job, signal) => {
    const state = await store.read();
    const current = state.syntheses.find((item) => item.id === job.id);
    const entries = current && sourceEntries(state, current);
    if (!entries || !canProcess() || signal?.aborted || !await verifySources({ entries, directory: current.directory, signal })) throw fail('methodology_sources_unavailable');
    return { state, entries, job: current };
  };
  const expandDeferred = async ({ generated, checked, signal }) => {
    const result = generatedSchema.parse(generated);
    if (!checked.job.automatic || !result.deferredCards.length) return { result, entries: checked.entries };
    let supports = checked.entries;
    const accepted = []; const pending = []; const reasons = new Map(); let rejected = 0;
    const note = (code) => reasons.set(code, (reasons.get(code) ?? 0) + 1);
    for (const raw of result.deferredCards.slice(0, 100)) {
      let card; let selected;
      try {
        card = prepareHyResult({ result: { cards: [raw], operations: [] }, segment: firstSegment(checked.state, checked.entries), state: checked.state }).cards[0];
        if (card.kind !== 'methodology') throw fail('methodology_sources_invalid');
        selected = card.supportingEntryIds.map((id) => checked.state.entries.find((entry) => entry.id === id));
        if (selected.some((entry) => !methodologySupportEligible(checked.state, entry, checked.job.projectId, true))) throw fail('methodology_sources_invalid');
        selectedSupports(card, selected);
        const refs = deferredSchema.parse(raw).sourceRefs;
        if (refs.some((ref) => !selected.some((entry) => entry.sessionId === ref.sessionId && entry.sourceHash === ref.sourceHash
          && (ref.sourceRevision == null || ref.sourceRevision === (checked.state.sessions[entry.sessionId]?.revision ?? 0))
          && entry.sourceMessageIds.includes(ref.messageId) && (!ref.partId || entry.sourcePartIds.includes(ref.partId))))) throw fail('methodology_sources_invalid');
      } catch (error) { rejected++; note(errorCode(error)); continue; }
      const combined = [...new Map([...supports, ...selected].map((entry) => [entry.id, entry])).values()];
      const sessions = new Set(combined.flatMap((entry) => [entry.sessionId, ...entry.sourceReferences.map((ref) => ref.sessionId)]));
      if (combined.length > 100 || sessions.size > 40) { pending.push(raw); note('hy_deferred_source_budget'); continue; }
      let available = false;
      try { available = await verifySources({ entries: combined, directory: checked.job.directory, signal }); }
      catch { /* Source unavailability preserves the proposal for a later dirty-source pass. */ }
      if (!canProcess() || signal?.aborted) throw fail('methodology_sources_unavailable');
      if (!available) { pending.push(raw); note('methodology_sources_unavailable'); continue; }
      supports = combined; accepted.push(raw);
    }
    const excess = Math.max(0, result.deferredCards.length - 100);
    if (excess) { rejected += excess; reasons.set('hy_deferred_card_budget', excess); }
    result.cards = [...result.cards, ...accepted]; result.deferredCards = pending;
    result.deferredStatus = { pending: pending.length, rejected, reasons: [...reasons].map(([code, count]) => ({ code, count })) };
    return { result, entries: supports };
  };
  const run = async (job, signal) => {
    let checked = await checkSources(job, signal);
    const current = checked.state.syntheses.find((item) => item.id === job.id);
    let generated = current?.generated;
    if (!generated) {
      const continuation = cursorSchema.safeParse(current?.continuation);
      const offset = z.object({ offset: z.number().int().nonnegative().optional() }).passthrough().safeParse(continuation.success ? continuation.data.cursor : {});
      generated = await organizer.consolidate({ entries: withSourceRefs(checked.state, checked.entries), directory: job.directory, signal,
        s2Offset: offset.success ? offset.data.offset ?? 0 : 0 });
    }
    checked = await checkSources(job, signal);
    const primary = prepareHyResult({ result: generated, segment: firstSegment(checked.state, checked.entries), state: checked.state });
    for (const card of primary.cards.filter((item) => item.kind === 'methodology')) selectedSupports(card, checked.entries);
    const expanded = await expandDeferred({ generated, checked, signal });
    const expandedSnapshots = snapshots(checked.state, expanded.entries);
    await store.update((state) => {
      const receipt = state.syntheses.find((item) => item.id === job.id);
      if (!receipt || receipt.state !== 'extracting' || !sourceEntries(state, receipt) || !canProcess() || signal?.aborted) throw fail('methodology_sources_unavailable');
      const effective = { ...receipt, supports: expandedSnapshots };
      if (!sourceEntries(state, effective)) throw fail('methodology_sources_unavailable');
      receipt.supports = expandedSnapshots; receipt.generated = expanded.result;
    });
    checked = await checkSources(job, signal);
    const prepared = prepareHyResult({ result: expanded.result, segment: firstSegment(checked.state, checked.entries), state: checked.state });
    for (const card of prepared.cards.filter((item) => item.kind === 'methodology')) selectedSupports(card, checked.entries);
    return { generated: expanded.result, prepared };
  };
  const stageProjection = (state, job, prepared) => {
    if (!sourceEntries(state, job)) throw fail('methodology_sources_unavailable');
    appendHyProjection(state, { id: hyBatchId(job.id, digest(job.supports)), projectId: job.projectId, operations: prepared.operations,
      sourceSessionIds: job.supports.map((support) => support.sessionId) });
  };
  const projectResult = async (job) => {
    const state = await store.read();
    const current = state.syntheses.find((item) => item.id === job.id);
    if (!current) throw fail('hy_job_unavailable');
    const projection = state.engine.projections.find((item) => item.id === hyBatchId(current.id, digest(current.supports)) && item.state !== 'done');
    if (!projection) return;
    await checkSources(current);
    await applyHyProjection({ store, backend, projection, validateState: (next) => {
      const latest = next.syntheses.find((item) => item.id === current.id);
      return Boolean(latest && digest(latest.supports) === digest(current.supports) && sourceEntries(next, latest));
    } });
  };
  const rememberContinuation = (state, job, generated) => {
    if (!generated.continuation) { delete state.engine.continuations[job.projectId]; return; }
    const prior = cursorSchema.safeParse(job.continuation);
    const pass = prior.success ? prior.data.pass + 1 : 1;
    state.engine.continuations[job.projectId] = { cursor: generated.continuation, previousJobId: job.id, pass };
    if (pass >= 32) { const current = state.syntheses.find((item) => item.id === job.id); current.error = 'hy_s2_continuation_limit'; return; }
    if (!state.engine.dirtyProjects.includes(job.projectId)) state.engine.dirtyProjects.push(job.projectId);
  };
  return {
    abort: () => generation?.abort(),
    hasPendingProjection: (state, job) => {
      const current = state.syntheses.find((item) => item.id === job.id) ?? job;
      return state.engine.projections.some((projection) => projection.id === hyBatchId(current.id, digest(current.supports)) && projection.state !== 'done');
    },
    schedule: async ({ excludeProjects = [] } = {}) => {
      if (!canProcess()) return;
      await store.update((state) => {
        if (!canProcess()) return;
        for (const projectId of [...new Set(state.engine.dirtyProjects)]) {
          if (excludeProjects.includes(projectId) || state.syntheses.some((job) => job.automatic && job.projectId === projectId && ['queued', 'extracting', 'indexing'].includes(job.state))) continue;
          state.engine.dirtyProjects = state.engine.dirtyProjects.filter((id) => id !== projectId);
          const deferred = state.syntheses.find((job) => job.projectId === projectId && job.automatic && job.state === 'done'
            && generatedSchema.safeParse(job.generated).success && generatedSchema.parse(job.generated).deferredCards.length > 0);
          if (deferred) { deferred.state = 'queued'; deferred.error = null; continue; }
          const entries = selectBatch(state, projectId);
          if (entries.length < 2) continue;
          const supports = snapshots(state, entries);
          const continuation = cursorSchema.safeParse(state.engine.continuations[projectId]);
          if (continuation.success && continuation.data.pass >= 32) continue;
          const id = `synthesis_hy_${digest([VERSION, projectId, supports, continuation.success ? continuation.data : null]).slice(0, 32)}`;
          if (!state.syntheses.some((job) => job.id === id) && !state.tombstones.includes(`source:${id}:${digest(supports)}`)) {
            state.syntheses.push({ id, projectId, directory: entries[0].directory, supports, automatic: true, generated: null,
              continuation: continuation.success ? continuation.data : null,
              state: 'queued', entryId: null, error: null, attempts: 0 });
          }
        }
      });
    },
    process: async (input) => {
      if (!canProcess()) return;
      const job = (await store.read()).syntheses.find((item) => item.id === input.id);
      if (!job?.automatic || !['queued', 'indexing'].includes(job.state)) return;
      try {
        if (job.state === 'queued') {
          await checkSources(job);
          await store.update((state) => {
            const current = state.syntheses.find((item) => item.id === job.id);
            if (!canProcess() || current.state !== 'queued' || !sourceEntries(state, current)) throw fail('methodology_sources_unavailable');
            current.state = 'extracting'; if (!current.generated) current.attempts++;
          });
          generation = new AbortController();
          const { generated, prepared } = await run(job, generation.signal);
          const cardDeletes = [];
          await store.update((state) => {
            const current = state.syntheses.find((item) => item.id === job.id);
            if (!canProcess() || generation.signal.aborted || current.state !== 'extracting') throw fail('hy_job_unavailable');
            const supports = sourceEntries(state, current);
            if (!supports) throw fail('methodology_sources_unavailable');
            stageProjection(state, current, prepared);
            for (const card of prepared.cards.filter((card) => card.kind === 'methodology')) {
              if (state.tombstones.includes(card.id)) continue;
              const selected = selectedSupports(card, supports);
              const existing = state.entries.find((entry) => entry.id === card.id);
              if (existing && (existing.projectId !== job.projectId || existing.kind !== 'methodology')) throw fail('hy_scope_mismatch');
              const proposal = memoryEntrySchema.parse({ ...card, status: 'candidate', verification: 'unverified', confirmed: false,
                projectId: job.projectId, directory: job.directory, sessionId: selected[0].sessionId, segmentId: job.id,
                sourceHash: digest(job.supports), createdAt: existing?.createdAt ?? now(), updatedAt: now(), indexState: 'pending', extractorVersion: VERSION });
              if (existing) {
                if (proposalRevision(existing) === proposalRevision(proposal)) continue;
                if (!store.atomicIndex) throw fail('hy_atomic_projection_required');
                state.entries.splice(state.entries.indexOf(existing), 1);
                cardDeletes.push({ operation: 'nodes/delete', namespace: `${memoryNamespace(job.projectId)}:cards`, ids: [card.id] });
              }
              state.entries.push(proposal);
              if (!current.entryId) current.entryId = card.id;
            }
            if (generated.spaceId) {
              state.engine.records = state.engine.records.filter((record) => record.projectId !== job.projectId || record.collection !== 'model-space');
              const value = { spaceId: generated.spaceId };
              if (generated.configurationId) value.configurationId = generated.configurationId;
              state.engine.records.push({ id: 'current', projectId: job.projectId, collection: 'model-space', value });
            }
            current.state = 'indexing'; current.error = null;
          }, { indexOperations: cardDeletes });
        }
        if (!canProcess()) return;
        await projectResult(job);
        await store.update((state) => {
          const current = state.syntheses.find((item) => item.id === job.id);
          if (!sourceEntries(state, current)) throw fail('methodology_sources_unavailable');
          current.state = 'done'; current.error = null; rememberContinuation(state, current, current.generated);
          const receipt = z.object({ review: z.json().optional(), continuation: z.json().optional(),
            deferredCards: z.array(z.json()).default([]), deferredStatus: z.json().optional() }).parse(current.generated);
          current.generated = { cards: [], operations: [], review: receipt.review ?? null, continuation: receipt.continuation ?? null,
            deferredCards: receipt.deferredCards, deferredStatus: receipt.deferredStatus ?? null };
        });
      } catch (error) {
        if (['hy_generation_timeout', 'hy_worker_exited', 'hy_protocol_invalid', 'hy_message_too_large', 'hy_worker_stopped', 'hy_cancelled'].includes(error?.code)) generation?.abort();
        await store.update((state) => {
          const current = state.syntheses.find((item) => item.id === job.id);
          if (current && current.state !== 'done') { current.state = generation?.signal.aborted && !current.generated ? 'unknown' : 'failed'; current.error = errorCode(error); }
        });
      } finally { generation = null; }
    },
    distill: async ({ entries, directory, signal, jobId }) => {
      const state = await store.read();
      const job = state.syntheses.find((item) => item.id === jobId && !item.automatic);
      if (!job || job.directory !== directory || entries.length !== job.supports.length || entries.some((entry) => !job.supports.some((support) => support.id === entry.id))) throw fail('methodology_sources_unavailable');
      const { prepared } = await run(job, signal);
      await store.update((next) => stageProjection(next, next.syntheses.find((item) => item.id === job.id), prepared));
      await projectResult(job);
      const card = prepared.cards.find((item) => item.kind === 'methodology');
      if (!card) throw fail('methodology_no_schema');
      return methodologySchema.parse({ id: card.id, kind: card.kind, title: card.title, body: card.body,
        status: 'candidate', verification: 'unverified', sourceMessageIds: card.sourceMessageIds,
        sourcePartIds: card.sourcePartIds, supportingEntryIds: card.supportingEntryIds, limitations: card.limitations });
    },
  };
};
