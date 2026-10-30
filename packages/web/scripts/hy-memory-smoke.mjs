#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createSharedMemoryStore } from '../server/lib/hy-memory/store.js';
import { createHyMemoryOrganizer, memoryNamespace } from '../server/lib/hy-memory/organizer.js';
import { createMemoryProjection } from '../server/lib/hy-memory/projection.js';
import { createHySpaceMaintenance } from '../server/lib/hy-memory/spaces.js';
import { createConversationMemoryRuntime } from '../server/lib/conversation-memory/runtime.js';
import { createLibraryActions } from '../server/lib/openchamber-control/library.js';
import { nativeSmokeMain, smokeFailure } from './hy-memory-smoke-support.mjs';

const privateMarker = 'fixture-private-slide-change';
const projectId = 'hy-smoke-project';
const directory = '/synthetic/hy-smoke-project';
const sessionId = 'hy-smoke-session';
const sourceSegment = () => {
  const patch = `diff --git a/slides.md b/slides.md\n--- a/slides.md\n+++ b/slides.md\n@@ -1 +1 @@\n-long slide paragraph\n+${privateMarker}\n`;
  return { id: 'hy-smoke-segment', sessionId, projectId, directory, title: 'Synthetic slide fixture', createdAt: 100, sourceHash: 'a'.repeat(64),
    messageIds: ['hy-smoke-user', 'hy-smoke-tool'], outcome: 'succeeded',
    messages: [{ id: 'hy-smoke-user', role: 'user', text: `长文本页反复重画无效，改为拆页。${privateMarker}` },
      { id: 'hy-smoke-tool', role: 'tool', partId: 'hy-smoke-part', tool: 'export', status: 'completed', text: `Export completed.\n${patch}` }],
    patches: [{ messageId: 'hy-smoke-tool', partId: 'hy-smoke-part', patch }] };
};

async function scenario({ root, backend, switchEmbeddingConfiguration, ownRuntime }, options, progress) {
    const store = createSharedMemoryStore({ dataDir: root, backend });
    const spaces = createHySpaceMaintenance({ store, backend });
    const ensureSpace = (input) => spaces.ensure(input);
    let generationCalls = 0;
    const organizer = createHyMemoryOrganizer({ backend, readState: () => store.read(), command: options.python, ensureSpace, generate: async ({ prompt }) => {
      generationCalls++;
      if (generationCalls > 2) throw smokeFailure('smoke_unexpected_generation');
      if (prompt.includes('"draft_idx"')) return { text: JSON.stringify({ ops: [{ action: 'ADD', draft_idx: 0, supersedes: [] }] }) };
      return { text: JSON.stringify({ experiences: [{ task: '长文本页反复重画无效时改为拆页', search_keys: ['长文本 拆页'], solution: `将长文本拆为多页并检查文字可读性。${privateMarker}`, boundary_envs: 'PPT制作', confidence: 0.9 }],
        fact: { subject: 'PPT长文本', statement: `长文本页反复重画后改为拆页，工具报告完成。${privateMarker}`, details: 'Synthetic tool observation.', files: [] } }) };
    } });
    const segment = sourceSegment();
    const runtime = ownRuntime(createConversationMemoryRuntime({ dataDir: root, store, organizer, memoryBackend: backend,
      resolveProjectId: async () => projectId, readSegments: async () => ({ segments: [segment], checkpoint: { version: 1 }, reset: false, complete: true, sourceMessageIds: segment.messageIds }),
      createClient: () => ({}), renderMarkdown: ({ card }) => card.body, knowledgeLibrary: createMemoryProjection({ backend, ensureSpace }), indexPollMs: 0, now: () => 100 }));
    const actions = createLibraryActions({ runtime: { isReady: () => true, readLibraries: async () => [], search: async ({ query }) => ({ query, documents: [], passages: [] }) },
      resolveProjectId: async () => projectId, retrieveMemory: (input) => runtime.retrieve(input) });
    const listCore = () => backend('nodes/list', { namespace: `${memoryNamespace(projectId)}:core`, limit: 256 });
    progress.stage = 'capture';
    await runtime.start(); await runtime.setEnabled(true); await runtime.capture({ sessionId, directory }); await runtime.idle();
    const state = await store.read();
    const experience = state.entries.find((entry) => entry.kind === 'experience');
    const sibling = state.entries.find((entry) => entry.id !== experience?.id && entry.kind === 'segment');
    assert(experience, 'Expected an actual Hy experience'); assert(sibling, 'Expected a distinct Hy fact card');
    assert.equal(experience.status, 'candidate'); assert.equal(experience.verification, 'unverified');
    assert(state.engine.records.some((record) => record.collection === 'code_history'), 'Expected actual Hy patch history');
    const beforeCore = await listCore();
    const keys = beforeCore.nodes.filter((node) => node.payload.custom?.hy_kind === 'experience_key' && node.payload.custom?.experience_id === experience.id).map((node) => node.id);
    assert(keys.length > 0, 'Expected actual Hy key representations');
    assert(beforeCore.nodes.some((node) => node.id === experience.id)); assert(beforeCore.nodes.some((node) => node.id === sibling.id));
    progress.stage = 'agent_actions';
    const inspected = await actions.execute('library.inspect', { entryId: experience.id }, directory);
    assert.equal(inspected.memories[0]?.status, 'candidate'); assert.equal(inspected.memories[0]?.verification, 'unverified');
    const candidateRead = await actions.execute('library.read', { entryId: experience.id }, directory);
    assert.equal(candidateRead.memory?.availability.state, 'unverified');
    const beforeSearch = await actions.execute('library.search', { query: '长文本拆页' }, directory);
    assert(!beforeSearch.memories.some((entry) => entry.entryId === experience.id));
    await runtime.confirm({ id: experience.id, directory }); await runtime.idle();
    const readerState = await store.read();
    const readerResult = await organizer.recall({ directory, projectId, query: '长文本拆页',
      eligibleNodeIds: readerState.entries.filter((entry) => entry.status === 'active' && entry.indexState === 'ready').map((entry) => entry.id),
      candidateNodeIds: (await listCore()).nodes.map((node) => node.id) });
    assert.equal(readerResult.reader?.name, 'hybrid', 'The actual Hy hybrid Reader must execute');
    const searched = await actions.execute('library.search', { query: '长文本拆页' }, directory);
    assert(searched.memories.some((entry) => entry.entryId === experience.id));
    const read = await actions.execute('library.read', { entryId: experience.id }, directory);
    assert.equal(read.memory?.availability.state, 'eligible'); assert(read.memory.content.includes(privateMarker));
    const recalled = await runtime.recall({ directory, query: '长文本拆页' }); assert(recalled.includes(experience.title));
    progress.stage = 'embedding_configuration_switch';
    const oldBinding = (await store.read()).engine.records.find((record) => record.collection === 'model-space').value;
    await switchEmbeddingConfiguration();
    assert.notEqual((await backend('capabilities', {})).embedding_configuration_id, oldBinding.configurationId);
    const migratedRecall = await runtime.recall({ directory, query: '长文本拆页' }); assert(migratedRecall.includes(experience.title));
    const migratedState = await store.read();
    const newBinding = migratedState.engine.records.find((record) => record.collection === 'model-space').value;
    assert.notEqual(newBinding.spaceId, oldBinding.spaceId); assert.notEqual(newBinding.configurationId, oldBinding.configurationId);
    const migratedCore = await listCore();
    assert.deepEqual(migratedCore.nodes.map((node) => node.id).sort(), beforeCore.nodes.map((node) => node.id).sort());
    for (const kind of ['core', 'cards']) {
      const oldRows = await backend('nodes/list', { namespace: `${memoryNamespace(projectId)}:${kind}`, space_id: oldBinding.spaceId, limit: 256 });
      assert.equal(oldRows.total, 0, 'Retired model vectors must be absent');
    }
    assert.equal(generationCalls, 2);
    progress.stage = 'single_card_forget';
    const forgotten = await runtime.forget({ id: experience.id, directory }); assert.equal(forgotten.pendingCleanup, false);
    const afterCore = await listCore();
    assert(!afterCore.nodes.some((node) => node.id === experience.id || keys.includes(node.id)), 'Forgotten core and key nodes must be absent');
    assert(afterCore.nodes.some((node) => node.id === sibling.id), 'Independent sibling core node must remain');
    const partial = await store.read();
    assert.equal(partial.entries.find((entry) => entry.id === sibling.id)?.body, sibling.body);
    assert(partial.jobs[0].segment.messages?.length > 0, 'Sibling still needs its captured source');
    assert(partial.engine.records.some((record) => record.collection === 'code_history'), 'Shared source history must survive');
    const missing = await actions.execute('library.read', { entryId: experience.id }, directory); assert.equal(missing.memory, null);
    const afterRecall = await runtime.recall({ directory, query: '长文本拆页' }); assert(!afterRecall.includes(experience.title));
    progress.stage = 'session_forget';
    await runtime.invalidateSession(sessionId, true);
    const finalCore = await listCore(); assert.equal(finalCore.total, 0);
    const finalCards = await backend('nodes/list', { namespace: `${memoryNamespace(projectId)}:cards`, limit: 256 }); assert.equal(finalCards.total, 0);
    const finalState = await store.read();
    assert(!finalState.engine.records.some((record) => ['node-source', 'trace', 'code_history', 'relation'].includes(record.collection)));
    assert(finalState.entries.every((entry) => !entry.cleanupPending && entry.title === '' && entry.body === '' && entry.limitations.length === 0));
    assert(!JSON.stringify(finalState).includes(privateMarker), 'Forgotten source and generated prose must leave the current ledger');
    assert.equal(generationCalls, 2, 'Confirm, read, recall and forget must reuse captured generation');
    return { ok: true, engine: 'hy-memory', backend: 'sqlite-vec', dimensions: 2, generationCalls,
      checks: { actualHyCapture: true, actualHyReader: true, codeHistory: true, candidateRemainsUnverified: true, confirmedRecall: true, agentLibraryActions: ['inspect', 'search', 'read'],
        modelConfigurationMigration: true, oldVectorsRetired: true, coreAndKeyDeletion: true, siblingPreservation: true, sessionCoreAndHistoryDeletion: true, forgottenProseErased: true, wikiEnabled: true },
      boundaries: ['Synthetic source and generation responses', 'Agent action adapter invoked directly; HTTP routes not exercised', 'One source session; automatic S2 not exercised'] };
}

await nativeSmokeMain(scenario);
