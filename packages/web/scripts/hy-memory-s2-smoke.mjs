#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createSharedMemoryStore } from '../server/lib/hy-memory/store.js';
import { createHyMemoryOrganizer, memoryNamespace } from '../server/lib/hy-memory/organizer.js';
import { createMemoryProjection } from '../server/lib/hy-memory/projection.js';
import { createHySpaceMaintenance } from '../server/lib/hy-memory/spaces.js';
import { createConversationMemoryRuntime } from '../server/lib/conversation-memory/runtime.js';
import { createLibraryActions } from '../server/lib/openchamber-control/library.js';
import { nativeSmokeMain, smokeFailure } from './hy-memory-smoke-support.mjs';

const projectId = 'hy-smoke-s2-project';
const directory = '/synthetic/hy-smoke-s2-project';
const methodBody = 'Validate editable exports against independent source sessions, check required conditions and record validation limits.';
const segmentFor = (lesson) => ({
  id: `hy-smoke-segment-${lesson}`, sessionId: `hy-smoke-session-${lesson}`, projectId, directory,
  title: `Synthetic lesson ${lesson}`, createdAt: 100, sourceHash: (lesson === 'A' ? 'a' : 'b').repeat(64),
  messageIds: [`hy-smoke-user-${lesson}`, `hy-smoke-tool-${lesson}`], outcome: 'succeeded',
  messages: [{ id: `hy-smoke-user-${lesson}`, role: 'user', text: `Independent export lesson ${lesson}: inspect editable text before reuse.` },
    { id: `hy-smoke-tool-${lesson}`, role: 'tool', partId: `hy-smoke-part-${lesson}`, tool: 'export', status: 'completed', text: `Editable export inspection completed for lesson ${lesson}.` }],
});

async function scenario({ root, backend: actualBackend, ownRuntime }, options, progress) {
  let clock = 100; let failedProjection = false;
  const generationCalls = { capture: 0, system2: 0, behavior: 0 };
  const backend = async (action, input) => {
    const schemaWrite = action === 'state/commit' && input.index_operations?.some((op) => op.operation === 'nodes/upsert'
      && op.nodes.some((node) => node.payload.custom?.schema_kind === 'engineering_methodology' && node.payload.custom?.representation_role !== 'behavior'));
    if (schemaWrite && !failedProjection) { failedProjection = true; throw smokeFailure('backend_unavailable'); }
    return actualBackend(action, input);
  };
  const store = createSharedMemoryStore({ dataDir: root, backend });
  const spaces = createHySpaceMaintenance({ store, backend });
  const ensureSpace = (input) => spaces.ensure(input);
  const segments = ['A', 'B'].map(segmentFor);
  const generate = async ({ prompt }) => {
    if (prompt.includes('behavioral psychologist')) {
      generationCalls.behavior++;
      return { text: JSON.stringify({ abstraction_for_embedding: 'Requires independent source evidence and validation before reusing an engineering procedure.' }) };
    }
    const evidence = [...new Set([...prompt.matchAll(/\(id=(hy_support_[a-zA-Z0-9_]+)/g)].map((match) => match[1]))];
    if (evidence.length) {
      generationCalls.system2++;
      if (generationCalls.system2 > 2) throw smokeFailure('smoke_s2_generation_repeated');
      if (generationCalls.system2 === 2) return { text: '[]' };
      return { text: JSON.stringify([{ op: 'create_schema', schema_kind: 'engineering_methodology', content: methodBody,
        retrieval_text: 'Engineering export inspection with independent source evidence.', evidence_list: evidence, tags: ['editable-export', 'synthetic-fixture'] }]) };
    }
    generationCalls.capture++;
    if (generationCalls.capture > 4) throw smokeFailure('smoke_capture_generation_repeated');
    if (prompt.includes('"draft_idx"')) return { text: JSON.stringify({ ops: [{ action: 'ADD', draft_idx: 0, supersedes: [] }] }) };
    const lesson = prompt.includes('lesson B') ? 'B' : 'A';
    return { text: JSON.stringify({ experiences: [{ task: `Inspect editable export lesson ${lesson}`, search_keys: [`editable export lesson ${lesson}`],
      solution: `Check editable text and export constraints for independent lesson ${lesson}.`, boundary_envs: 'Synthetic slide workflow', confidence: 0.9 }],
      fact: { subject: `Export lesson ${lesson}`, statement: `Independent lesson ${lesson} records an editable export inspection.`, details: 'Synthetic tool observation.', files: [] } }) };
  };
  const createRuntime = () => {
    const organizer = createHyMemoryOrganizer({ backend, readState: () => store.read(), command: options.python, generate, ensureSpace });
    return ownRuntime(createConversationMemoryRuntime({ dataDir: root, store, organizer, memoryBackend: backend, resolveProjectId: async () => projectId,
      readSegments: async ({ sessionId }) => { const segment = segments.find((item) => item.sessionId === sessionId); return { segments: [segment], checkpoint: { version: 1 }, reset: false, complete: true, sourceMessageIds: segment.messageIds }; },
      createClient: () => ({}), renderMarkdown: ({ card }) => card.body, knowledgeLibrary: createMemoryProjection({ backend, ensureSpace }), indexPollMs: 0, now: () => clock }));
  };
  let runtime = createRuntime();
  progress.stage = 'two_source_capture';
  await runtime.start(); await runtime.setEnabled(true);
  await runtime.capture({ sessionId: segments[0].sessionId, directory }); await runtime.idle();
  await runtime.capture({ sessionId: segments[1].sessionId, directory }); await runtime.idle();
  progress.stage = 'automatic_s2_receipt';
  let state = await store.read();
  const synthesis = state.syntheses.find((job) => job.automatic);
  if (!synthesis) throw smokeFailure('smoke_s2_job_missing');
  if (!synthesis.generated) throw smokeFailure(synthesis.error ?? 'smoke_s2_receipt_missing');
  progress.stage = 's2_generation_counts';
  assert.equal(generationCalls.capture, 4); assert.equal(generationCalls.system2, 1);
  progress.stage = 's2_projection_failure';
  assert.equal(synthesis.state, 'failed'); assert.equal(synthesis.error, 'backend_unavailable'); assert(failedProjection);
  progress.stage = 's2_native_review';
  assert(synthesis.generated.schemas.length > 0);
  progress.stage = 's2_review_count';
  assert(synthesis.generated.review.reviewed > 0);
  progress.stage = 's2_tool_call';
  assert(synthesis.generated.review.toolCalls.some((call) => call.tool === 'create_graph_node'));
  progress.stage = 's2_continuation_state';
  assert(synthesis.generated.continuation, 'Unreviewed sibling supports should retain a native continuation');
  const method = state.entries.find((entry) => entry.kind === 'methodology');
  if (!method) throw smokeFailure('smoke_s2_candidate_missing');
  progress.stage = 's2_candidate_sources';
  assert.equal(method.status, 'candidate'); assert.equal(method.verification, 'unverified'); assert.equal(method.confirmed, false);
  assert(new Set(method.sourceReferences.map((ref) => ref.sessionId)).size >= 2);
  assert(method.supportingEntryIds.length >= 2);
  const supports = state.entries.filter((entry) => method.supportingEntryIds.includes(entry.id));
  assert(state.entries.filter((entry) => entry.kind === 'experience').every((entry) => entry.status === 'candidate'));
  assert(supports.every((entry) => entry.verification === 'unverified'));
  const receipt = { review: synthesis.generated.review, continuation: synthesis.generated.continuation };
  const callsBeforeRecovery = JSON.stringify(generationCalls);
  await runtime.stop(); clock += 5000;
  progress.stage = 'restart_receipt_recovery';
  runtime = createRuntime(); await runtime.start(); await runtime.idle();
  state = await store.read();
  const recovered = state.syntheses.find((job) => job.id === synthesis.id);
  if (recovered.state !== 'done') throw smokeFailure(recovered.error ?? 'smoke_s2_recovery_incomplete');
  assert.equal(recovered.error, null);
  progress.stage = 'recovered_receipt_identity';
  assert.deepEqual(recovered.generated.review, receipt.review); assert.deepEqual(recovered.generated.continuation, receipt.continuation);
  assert.deepEqual(recovered.generated.cards, []); assert.deepEqual(recovered.generated.operations, []);
  progress.stage = 'recovered_generation_count';
  assert.equal(JSON.stringify(generationCalls), callsBeforeRecovery);
  progress.stage = 'recovered_schema_core';
  const core = await actualBackend('nodes/list', { namespace: `${memoryNamespace(projectId)}:core`, limit: 256 });
  const nativeSchema = core.nodes.find((node) => node.id === method.id);
  assert.equal(nativeSchema?.payload.custom.schema_kind, 'engineering_methodology');
  assert(core.nodes.some((node) => node.payload.custom?.representation_role === 'behavior' && node.payload.custom.owner_node_id === method.id));
  assert(state.entries.filter((entry) => entry.kind === 'experience').every((entry) => entry.status === 'candidate' && !entry.confirmed));
  assert.equal(state.entries.find((entry) => entry.id === method.id).status, 'candidate');
  progress.stage = 'automatic_continuation';
  await runtime.setEnabled(true); await runtime.idle();
  state = await store.read();
  const continuation = state.syntheses.find((job) => job.id !== synthesis.id && job.automatic);
  if (!continuation?.generated) throw smokeFailure(continuation?.error ?? 'smoke_s2_continuation_missing');
  assert.equal(continuation.state, 'done'); assert.equal(continuation.generated.continuation, null);
  assert(continuation.generated.review.reviewed > 0); assert.deepEqual(continuation.generated.review.toolCalls, []);
  assert.equal(state.entries.filter((entry) => entry.kind === 'methodology').length, 1);
  assert.equal(generationCalls.system2, 2);
  const callsAfterContinuation = JSON.stringify(generationCalls);
  progress.stage = 'candidate_confirmation_read';
  const actions = createLibraryActions({ runtime: { isReady: () => true, readLibraries: async () => [], search: async ({ query }) => ({ query, documents: [], passages: [] }) },
    resolveProjectId: async () => projectId, retrieveMemory: (input) => runtime.retrieve(input) });
  const inspection = await actions.execute('library.inspect', { entryId: method.id }, directory);
  assert.equal(inspection.memories[0]?.availability.state, 'unverified');
  const beforeConfirm = await runtime.recall({ directory, query: 'independent export inspection' }); assert(!beforeConfirm.includes(methodBody));
  await runtime.confirm({ id: method.id, directory }); await runtime.idle();
  const read = await actions.execute('library.read', { entryId: method.id }, directory);
  assert.equal(read.memory?.availability.state, 'eligible'); assert.equal(read.memory?.verification, 'unverified'); assert.equal(read.memory?.content, methodBody);
  assert.equal(JSON.stringify(generationCalls), callsAfterContinuation);
  const afterConfirm = await runtime.recall({ directory, query: 'independent export inspection' }); assert(afterConfirm.includes(methodBody));
  return { ok: true, engine: 'hy-memory', backend: 'sqlite-vec', sourceSessions: 2, generationCalls,
    checks: { automaticScheduler: true, actualSystem2SchemaTool: true, independentSources: true, candidateSupportsRemainUnverified: true,
      schemaCandidateRequiresConfirmation: true, continuationReviewExhausted: true, failedProjectionReceiptRetained: true, restartReceiptReuse: true,
      distinctBehaviorRepresentation: true, confirmedMethodReadAndRecall: true },
    boundaries: ['Synthetic sources, generation responses and embedding vectors', 'Two real System2 batches; no provider quality assessment', 'Agent action adapter invoked directly; HTTP routes not exercised'] };
}

await nativeSmokeMain(scenario, { vectorForText: (text) => text.includes('lesson B') ? [0.7, 0.7] : [1, 0] });
