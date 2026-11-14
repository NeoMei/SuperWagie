import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createConversationMemoryStore } from '../conversation-memory/store.js';
import { createHyMemoryTidy } from './tidy.js';
import { createConversationMemoryRuntime } from '../conversation-memory/runtime.js';
import { createSharedAgentMemoryPersistence } from './manual.js';
import { registerConversationMemoryRoutes } from '../conversation-memory/routes.js';

const directories = [];
const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});
const setup = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-tidy-')); directories.push(directory);
  const store = createConversationMemoryStore({ dataDir: directory });
  const fixture = { id: 'a', title: ' A ', body: ' A useful saved project fact. ', type: 'fact', scope: 'project', createdAt: 1, updatedAt: 1 };
  await store.update((state) => {
    state.engine.records.push(...['a', 'b'].map((id) => ({ collection: 'manual', id, projectId: 'p', value: { ...fixture, id } })));
    state.engine.records.push({ collection: 'manual', id: 'a', projectId: 'other', value: { ...fixture, body: ' other project ' } });
  });
  let project = 'p'; let verifiedIds = new Set(['c']);
  const tidy = createHyMemoryTidy({ store, requireScope: async () => project, now: () => 10,
    verifySources: async ({ entries }) => new Set(entries.filter((entry) => verifiedIds.has(entry.id)).map((entry) => entry.id)) });
  return { tidy, directory, store, setProject: (id) => { project = id; }, setVerified: (ids) => { verifiedIds = new Set(ids); } };
};
const addInference = (store) => store.update((state) => {
  state.sessions.s = { directory: '/work', checkpoint: null, revision: 1, deleted: false, historyAllowed: true, reconciling: false, segmentIds: ['seg'] };
  state.entries.push({ id: 'c', title: ' Inference ', body: ' Same sourced observation. ', kind: 'experience', verification: 'unverified',
    status: 'candidate', indexState: 'ready', projectId: 'p', directory: '/work', sessionId: 's', segmentId: 'seg', sourceHash: 'hash',
    sourceMessageIds: ['message'], sourceReferences: [{ sessionId: 's', messageId: 'message' }], limitations: ['Verify'],
    createdAt: 1, updatedAt: 1, supportingEntryIds: [] });
});
const manual = (state, id, projectId = 'p') => state.engine.records.find((row) => row.collection === 'manual' && row.id === id && row.projectId === projectId).value;

test('applies only selected entries and undo preserves a later manual edit independently', async () => {
  const { tidy, directory, store } = await setup();
  const preview = await tidy.preview({ directory });
  expect(preview.items).toHaveLength(2);
  const applied = await tidy.apply({ directory, previewId: preview.previewId, selectedIds: ['manual:a', 'manual:b'] });
  expect(applied.results.map((item) => item.state)).toEqual(['applied', 'applied']);
  await store.update((state) => { manual(state, 'b').body = 'Later manual edit'; });
  const undone = await tidy.undo({ directory, revisionIds: applied.results.map((item) => item.revisionId) });
  expect(undone.results.map((item) => item.state)).toEqual(['undone', 'conflict']);
  const state = await store.read();
  expect(manual(state, 'a').body).toBe(' A useful saved project fact. ');
  expect(manual(state, 'b').body).toBe('Later manual edit');
  expect(manual(state, 'a', 'other').body).toBe(' other project ');
  expect(manual(state, 'a').type).toBe('fact');
  expect(state.engine.dirtyProjects).toEqual([]);
  expect(state.jobs).toEqual([]);
  expect((await tidy.undo({ directory, revisionIds: [applied.results[0].revisionId] })).results[0].state).toBe('undone');
});

test('selection validates authoritative preview values and entry versions', async () => {
  const { tidy, directory, store } = await setup();
  const preview = await tidy.preview({ directory });
  await expect(tidy.apply({ directory, previewId: preview.previewId, selectedIds: ['manual:unknown'] })).rejects.toMatchObject({ code: 'invalid_request' });
  await store.update((state) => { manual(state, 'a').title = 'Changed'; });
  const result = await tidy.apply({ directory, previewId: preview.previewId, selectedIds: ['manual:a', 'manual:b'] });
  expect(result.results.map((item) => item.state)).toEqual(['conflict', 'applied']);
  expect(manual(await store.read(), 'a').title).toBe('Changed');
});

test('preserves inferred type and source identity and rejects a revoked source at apply and undo', async () => {
  const { tidy, directory, store, setVerified } = await setup(); await addInference(store);
  const preview = await tidy.preview({ directory });
  const proposal = preview.items.find((item) => item.id === 'c');
  expect(proposal.kind).toBe('inference'); expect(proposal.sourceSessionIds).toEqual(['s']);
  const applied = await tidy.apply({ directory, previewId: preview.previewId, selectedIds: ['inference:c'] });
  const entry = (await store.read()).entries[0];
  expect(entry.kind).toBe('experience'); expect(entry.verification).toBe('unverified'); expect(entry.status).toBe('candidate');
  expect(entry.sourceHash).toBe('hash'); expect(entry.body).toBe('Same sourced observation.');
  setVerified([]);
  expect((await tidy.undo({ directory, revisionIds: [applied.results[0].revisionId] })).results[0].state).toBe('source_changed');
  expect((await tidy.revisions({ directory })).revisions).toEqual([]);
  expect((await tidy.revisions({ directory })).unavailable).toBe(1);
  expect((await tidy.preview({ directory })).unavailable).toBe(1);
  expect((await tidy.apply({ directory, previewId: preview.previewId, selectedIds: ['inference:c'] })).results[0].state).toBe('source_changed');
});

test('source revision and project switching reject saved proposals', async () => {
  const { tidy, directory, store, setProject } = await setup(); await addInference(store);
  const preview = await tidy.preview({ directory });
  await store.update((state) => { state.sessions.s.revision++; });
  expect((await tidy.apply({ directory, previewId: preview.previewId, selectedIds: ['inference:c'] })).results[0].state).toBe('source_changed');
  setProject('other');
  await expect(tidy.apply({ directory, previewId: preview.previewId, selectedIds: ['manual:a'] })).rejects.toMatchObject({ code: 'hy_tidy_preview_expired' });
});

test('consolidates only exact repeated prose, keeping code and source types intact', async () => {
  const { tidy, directory, store } = await setup();
  const paragraph = 'The exact same sourced observation repeated without any additional context.';
  await store.update((state) => {
    manual(state, 'a').body = `${paragraph}\n\n${paragraph}`;
    manual(state, 'b').body = `\`\`\`\n${paragraph}\n\n${paragraph}\n\`\`\``;
  });
  const preview = await tidy.preview({ directory });
  expect(preview.items[0].after.body).toBe(paragraph);
  expect(preview.items[0].reasons).toContain('repeated_paragraph');
  expect(preview.items[1].after.body).toBe(manual(await store.read(), 'b').body);
});

test('rule export previews actual content, needs separate confirmation and detects external edits', async () => {
  const { tidy, directory, store } = await setup();
  const target = path.join(directory, 'AGENTS.md'); await fs.writeFile(target, '# Existing\n');
  const before = await fs.readFile(target, 'utf8');
  const preview = await tidy.exportPreview({ directory, items: [{ id: 'a', kind: 'manual' }] });
  expect(preview.before).toBe(before); expect(preview.after).toContain('# Existing'); expect(preview.target).toBe(await fs.realpath(target));
  expect(await fs.readFile(target, 'utf8')).toBe(before);
  await expect(tidy.exportConfirm({ directory, exportId: preview.exportId, confirmed: false })).rejects.toMatchObject({ code: 'hy_tidy_confirmation_required' });
  await fs.writeFile(target, '# External edit\n');
  await expect(tidy.exportConfirm({ directory, exportId: preview.exportId, confirmed: true })).rejects.toMatchObject({ code: 'hy_tidy_export_conflict' });
  expect(await fs.readFile(target, 'utf8')).toBe('# External edit\n');
  const next = await tidy.exportPreview({ directory, items: [{ id: 'a', kind: 'manual' }] });
  await tidy.exportConfirm({ directory, exportId: next.exportId, confirmed: true });
  expect(await fs.readFile(target, 'utf8')).toBe(next.after);
  expect(manual(await store.read(), 'a').body).toBe(' A useful saved project fact. ');
});

test('rule export refuses a directory alias retargeted after staging and preserves both destinations', async () => {
  const { directory, store } = await setup();
  const a = path.join(directory, 'a'); const b = path.join(directory, 'b'); const alias = path.join(directory, 'current');
  await fs.mkdir(a); await fs.mkdir(b); await fs.symlink(a, alias, 'dir');
  await fs.writeFile(path.join(a, 'AGENTS.md'), '# Original\n');
  let confirming = false; let reads = 0;
  const wrapped = { update: store.update, read: async () => {
    if (confirming && ++reads === 3) {
      await fs.rename(path.join(a, 'AGENTS.md'), path.join(b, 'AGENTS.md'));
      await fs.writeFile(path.join(a, 'AGENTS.md'), '# External update before final check\n');
      await fs.unlink(alias); await fs.symlink(b, alias, 'dir');
    }
    return store.read();
  } };
  const tidy = createHyMemoryTidy({ store: wrapped, requireScope: async () => 'p', verifySources: async () => new Set() });
  const preview = await tidy.exportPreview({ directory: alias, items: [{ id: 'a', kind: 'manual' }] });
  confirming = true;
  await expect(tidy.exportConfirm({ directory: alias, exportId: preview.exportId, confirmed: true })).rejects.toMatchObject({ code: 'hy_tidy_export_conflict' });
  expect(await fs.readFile(path.join(a, 'AGENTS.md'), 'utf8')).toBe('# External update before final check\n');
  expect(await fs.readFile(path.join(b, 'AGENTS.md'), 'utf8')).toBe('# Original\n');
  expect(await fs.readdir(a)).toEqual(['AGENTS.md']);
});

test('file export refuses stale source content and symlink targets', async () => {
  const { tidy, directory, store } = await setup();
  const preview = await tidy.exportPreview({ directory, items: [{ id: 'a', kind: 'manual' }] });
  await store.update((state) => { manual(state, 'a').body = 'Edited after preview'; });
  await expect(tidy.exportConfirm({ directory, exportId: preview.exportId, confirmed: true })).rejects.toMatchObject({ code: 'hy_tidy_source_changed' });
  const other = path.join(directory, 'other.md'); await fs.writeFile(other, 'Original');
  await fs.symlink(other, path.join(directory, 'AGENTS.md'));
  await expect(tidy.exportPreview({ directory, items: [{ id: 'a', kind: 'manual' }] })).rejects.toMatchObject({ code: 'hy_tidy_export_target' });
  expect(await fs.readFile(other, 'utf8')).toBe('Original');
});

test('refuses isolated directories before resolving host scope, including normalized paths', async () => {
  const { tidy } = await setup();
  for (const directory of ['/spaces/a/project', '/work/../spaces/a/project']) {
    await expect(tidy.preview({ directory })).rejects.toMatchObject({ code: 'hy_tidy_isolated_unsupported' });
  }
});

test('explicit HTTP routes reject client project overrides and arbitrary export paths', async () => {
  const { tidy, directory } = await setup();
  const app = express(); registerConversationMemoryRoutes(app, { runtime: { tidy } });
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/conversation-memory/tidy`;
  const post = (route, body) => fetch(`${url}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post('preview', { directory, projectId: 'other' })).status).toBe(400);
  expect((await post('export/preview', { directory, items: [{ id: 'a', kind: 'manual' }], target: '/tmp/skill.md' })).status).toBe(400);
  const preview = await (await post('preview', { directory })).json();
  const applied = await (await post('apply', { directory, previewId: preview.previewId, selectedIds: ['manual:a'] })).json();
  expect(applied.results).toHaveLength(1); expect(applied.results[0].state).toBe('applied');
});


test('source invalidation removes revision prose and blocks recall without restoring old values', async () => {
  const { directory, store } = await setup(); await addInference(store);
  const runtime = createConversationMemoryRuntime({ dataDir: directory, store, resolveProjectId: async () => 'p', knowledgeLibrary: { removeManagedDocument: async () => ({ removed: true }) } });
  const preview = await runtime.tidy.preview({ directory });
  const result = await runtime.tidy.apply({ directory, previewId: preview.previewId, selectedIds: ['inference:c'] });
  expect(result.results[0].state).toBe('applied');
  expect((await store.read()).engine.records.some((row) => row.collection === 'hy-tidy-revision')).toBe(true);
  await runtime.invalidateSession('s', true);
  expect((await store.read()).engine.records.some((row) => row.collection === 'hy-tidy-revision')).toBe(false);
  expect(await runtime.recall({ directory, query: 'sourced observation' })).toBe('');
  await runtime.stop();
});

test('manual deletion erases its revision body through the shared persistence owner', async () => {
  const { tidy, directory, store } = await setup();
  const preview = await tidy.preview({ directory });
  await tidy.apply({ directory, previewId: preview.previewId, selectedIds: ['manual:a'] });
  const resolved = { scope: 'project', projectId: 'p', filePath: path.join(directory, 'manual.json') };
  await store.update((state) => { state.engine.records.push({ collection: 'manual-scope', projectId: 'p', id: 'legacy-v1', value: { version: 1, scope: 'project' } }); });
  const persistence = createSharedAgentMemoryPersistence({ store: () => store });
  await persistence.update(resolved, async () => ({ version: 1, entries: [] }), (current) => ({ entries: current.entries.filter((entry) => entry.id !== 'a') }));
  expect((await store.read()).engine.records.some((row) => row.collection === 'hy-tidy-revision')).toBe(false);
});

test('a failed shared commit leaves selected values and revisions unchanged', async () => {
  const { directory, store } = await setup();
  const failing = { read: store.read, update: (change) => store.update((state) => { change(state); throw new Error('commit failed'); }) };
  const tidy = createHyMemoryTidy({ store: failing, requireScope: async () => 'p', verifySources: async () => new Set() });
  const preview = await tidy.preview({ directory });
  await expect(tidy.apply({ directory, previewId: preview.previewId, selectedIds: ['manual:a'] })).rejects.toThrow('commit failed');
  expect(manual(await store.read(), 'a').title).toBe(' A ');
  expect((await store.read()).engine.records.some((row) => row.collection === 'hy-tidy-revision')).toBe(false);
});

test('review revalidates changed source anchors without scheduling history extraction', async () => {
  const { directory, store } = await setup(); await addInference(store);
  const checkpoint = { version: 1, sessionId: 's', projectId: 'p', directory, revertId: null, cursor: null, anchorId: null, anchorHash: null, pending: null };
  await store.update((state) => { state.enabled = true; state.enabledAt = 1; state.sessions.s.directory = directory; state.sessions.s.checkpoint = checkpoint; });
  let captures = 0;
  const runtime = createConversationMemoryRuntime({ dataDir: directory, store, debounceMs: 0, indexPollMs: 0, resolveProjectId: async () => 'p',
    readSessionSource: async () => ({ directory, revertId: null, anchorMatches: false }),
    readSegments: async () => { captures++; return { segments: [], checkpoint, complete: true, reset: false }; },
    knowledgeLibrary: { removeManagedDocument: async () => ({ removed: true }) },
  });
  try {
    await runtime.start();
    const preview = await runtime.tidy.preview({ directory });
    expect(preview.items.some((item) => item.id === 'c')).toBe(false);
    expect(preview.unavailable).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10)); await runtime.idle();
    expect(captures).toBe(0);
    expect((await store.read()).pending).toEqual([]);
  } finally { await runtime.stop(); }
});


test('a missing sibling revision cannot block another selected undo', async () => {
  const { tidy, directory, store } = await setup();
  const preview = await tidy.preview({ directory });
  const applied = await tidy.apply({ directory, previewId: preview.previewId, selectedIds: ['manual:a', 'manual:b'] });
  await store.update((state) => { state.engine.records = state.engine.records.filter((row) => row.id !== applied.results[1].revisionId); });
  const result = await tidy.undo({ directory, revisionIds: applied.results.map((item) => item.revisionId) });
  expect(result.results.map((item) => item.state)).toEqual(['undone', 'source_changed']);
  expect(manual(await store.read(), 'a').body).toBe(' A useful saved project fact. ');
});

test('a source changed during verification cannot authorize a newer proposal snapshot', async () => {
  const { directory, store } = await setup(); await addInference(store);
  const tidy = createHyMemoryTidy({ store, requireScope: async () => 'p', verifySources: async () => {
    await store.update((state) => { state.entries[0].sourceHash = 'new-source'; });
    return new Set(['c']);
  } });
  const preview = await tidy.preview({ directory });
  expect(preview.items.some((item) => item.id === 'c')).toBe(false);
  expect(preview.unavailable).toBe(1);
});

test('a memory edit during file staging prevents rule publication and removes its temporary file', async () => {
  const { directory, store } = await setup();
  let confirming = false; let reads = 0;
  const wrapped = { update: store.update, read: async () => {
    if (confirming && ++reads === 3) await store.update((state) => { manual(state, 'a').body = 'New manual edit'; });
    return store.read();
  } };
  const tidy = createHyMemoryTidy({ store: wrapped, requireScope: async () => 'p', verifySources: async () => new Set() });
  const target = path.join(directory, 'AGENTS.md'); await fs.writeFile(target, '# Existing\n');
  const preview = await tidy.exportPreview({ directory, items: [{ id: 'a', kind: 'manual' }] });
  confirming = true;
  await expect(tidy.exportConfirm({ directory, exportId: preview.exportId, confirmed: true })).rejects.toMatchObject({ code: 'hy_tidy_source_changed' });
  expect(await fs.readFile(target, 'utf8')).toBe('# Existing\n');
  expect((await fs.readdir(directory)).some((name) => name.includes('.hy-'))).toBe(false);
});
