import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isSpaceDirectory } from '../spaces/dispatcher.js';
import { looksLikeInjection } from '../agent-memory/threat-patterns.js';
import { methodologySourcesEligible } from '../conversation-memory/methodology.js';

const contentSchema = z.object({ title: z.string(), body: z.string() });
const manualSchema = contentSchema.extend({ id: z.string(), scope: z.literal('project'), type: z.enum(['fact', 'preference', 'reference']), updatedAt: z.number(), flagged: z.boolean().optional() }).passthrough();
const itemSchema = z.object({
  id: z.string(), kind: z.enum(['manual', 'inference']), type: z.enum(['fact', 'preference', 'reference', 'segment', 'experience', 'methodology']),
  version: z.string(), sourceVersion: z.string(), sourceSessionIds: z.array(z.string()),
  sourceHash: z.string().nullable(), sourceReferences: z.array(z.object({ sessionId: z.string(), messageId: z.string() })), verification: z.enum(['observed', 'unverified']),
  before: contentSchema, after: contentSchema, reasons: z.array(z.enum(['whitespace', 'repeated_paragraph'])),
});
const revisionSchema = z.object({ item: itemSchema, appliedVersion: z.string(), undone: z.boolean() });
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentOf = ({ title, body }) => ({ title, body });
const recordFor = (state, projectId, id) => state.engine.records.find((row) => row.projectId === projectId && row.collection === 'manual' && row.id === id);
const entryFor = (state, projectId, id) => state.entries.find((entry) => entry.projectId === projectId && entry.id === id);
const sourcesFor = (state, entry) => [...new Set([entry.sessionId, ...entry.sourceReferences.map((ref) => ref.sessionId),
  ...entry.supportingEntryIds.flatMap((id) => {
    const support = entryFor(state, entry.projectId, id);
    return support ? [support.sessionId, ...support.sourceReferences.map((ref) => ref.sessionId)] : [];
  })])].sort();
const allowed = (state, entry) => ['active', 'candidate'].includes(entry.status) && !entry.cleanupPending
  && !state.tombstones.includes(entry.id) && !state.tombstones.includes(`source:${entry.segmentId}:${entry.sourceHash}`)
  && methodologySourcesEligible(state, entry) && !looksLikeInjection(entry.title, entry.body)
  && sourcesFor(state, entry).every((id) => state.sessions[id] && !state.sessions[id].deleted && !state.sessions[id].reconciling);
const sourceVersion = (state, entry) => hash([entry.projectId, entry.sourceHash, entry.sourceReferences,
  sourcesFor(state, entry).map((id) => [id, state.sessions[id]]),
  entry.supportingEntryIds.map((id) => entryFor(state, entry.projectId, id))]);
const currentItem = (state, projectId, item) => {
  if (item.kind === 'manual') {
    const row = recordFor(state, projectId, item.id);
    if (!row) return null;
    const value = manualSchema.parse(row.value);
    if (value.id !== item.id || value.flagged || looksLikeInjection(value.title, value.body)) return null;
    return { value, version: hash(row), sourceVersion: hash([projectId, 'manual', value.type]), sourceSessionIds: [], sourceHash: null, sourceReferences: [], verification: 'unverified' };
  }
  const value = entryFor(state, projectId, item.id);
  return value && allowed(state, value) ? { value, version: hash(value), sourceVersion: sourceVersion(state, value), sourceSessionIds: sourcesFor(state, value), sourceHash: value.sourceHash, sourceReferences: value.sourceReferences, verification: value.verification } : null;
};

/** Erase revision prose when its entry or retained source authority is revoked. */
export const pruneHyTidyRevisions = (state) => {
  state.engine.records = state.engine.records.filter((row) => {
    if (row.collection !== 'hy-tidy-revision') return true;
    const { item } = revisionSchema.parse(row.value);
    const current = currentItem(state, row.projectId, item);
    return current !== null && current.sourceVersion === item.sourceVersion;
  });
};

// Repeated prose paragraphs can be collapsed without changing an entry's claim.
// Repeated-paragraph removal excludes code, tables, lists and quotations.
const normalize = (before) => {
  const title = before.title.trim();
  const clean = /[`~]/.test(before.body) ? before.body : before.body.replace(/\r\n/g, '\n').trim();
  const reasons = title !== before.title || clean !== before.body ? ['whitespace'] : [];
  let body = clean;
  if (!/[`~|]|^\s*(?:[-*+>#]|\d+[.)])\s/m.test(clean)) {
    const seen = new Set();
    const paragraphs = clean.split(/\n{2,}/);
    const unique = paragraphs.filter((paragraph) => {
      if (paragraph.length < 40) return true;
      if (seen.has(paragraph)) return false;
      seen.add(paragraph); return true;
    });
    if (unique.length !== paragraphs.length) { body = unique.join('\n\n'); reasons.push('repeated_paragraph'); }
  }
  return { after: { title, body }, reasons };
};

/** Explicit local review. Only per-entry CAS writes reach the shared ledger. */
export function createHyMemoryTidy({ store, requireScope, verifySources, now = Date.now }) {
  const previews = new Map();
  const exports = new Map();
  let fileQueue = Promise.resolve();
  const scope = async (directory) => {
    if (isSpaceDirectory(directory)) throw fail('hy_tidy_isolated_unsupported', 403);
    const projectId = await requireScope(directory);
    if (!projectId || projectId === 'global') throw fail('project_unavailable');
    return projectId;
  };
  const retain = (map, value) => {
    for (const [id, saved] of map) if (saved.expires <= now()) map.delete(id);
    while (map.size >= 32) map.delete(map.keys().next().value);
    const id = randomUUID(); map.set(id, { ...value, expires: now() + 15 * 60_000 }); return id;
  };
  const take = (map, id, projectId, directory) => {
    const saved = map.get(id);
    if (!saved || saved.projectId !== projectId || saved.directory !== directory || saved.expires <= now()) throw fail('hy_tidy_preview_expired');
    return saved;
  };
  const verified = async (directory, entries) => {
    if (!entries.length) return new Set();
    const controller = new AbortController();
    let timer;
    try { return await Promise.race([verifySources({ directory, entries, signal: controller.signal }), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(fail('hy_tidy_source_unavailable', 503)); }, 1500);
    })]); }
    finally { clearTimeout(timer); controller.abort(); }
  };
  const checkSources = async (directory, projectId, items) => {
    const state = await store.read();
    const entries = items.filter((item) => item.kind === 'inference').map((item) => entryFor(state, projectId, item.id)).filter(Boolean);
    const accepted = await verified(directory, entries);
    return new Map(entries.filter((entry) => accepted.has(entry.id)).map((entry) => [entry.id, sourceVersion(state, entry)]));
  };
  const write = (state, projectId, item, content) => {
    const current = currentItem(state, projectId, item);
    if (!current) throw fail('hy_tidy_source_changed');
    const value = current.value;
    Object.assign(value, content, { updatedAt: Math.max(now(), value.updatedAt + 1) });
    if (item.kind === 'manual') recordFor(state, projectId, item.id).value = value;
    return currentItem(state, projectId, item).version;
  };
  const revisions = async ({ directory }) => {
    const projectId = await scope(directory);
    const state = await store.read();
    const rows = state.engine.records.filter((row) => row.projectId === projectId && row.collection === 'hy-tidy-revision')
      .map((row) => ({ id: row.id, ...revisionSchema.parse(row.value) })).filter((row) => !row.undone);
    const valid = await checkSources(directory, projectId, rows.map((row) => row.item));
    const latest = await store.read();
    const visible = rows.filter((row) => {
      const current = currentItem(latest, projectId, row.item);
      return current && current.sourceVersion === row.item.sourceVersion && (row.item.kind === 'manual' || valid.get(row.item.id) === row.item.sourceVersion);
    });
    return { revisions: visible.map((row) => ({ revisionId: row.id, ...row.item })), unavailable: rows.length - visible.length };
  };
  const preview = async ({ directory }) => {
    const projectId = await scope(directory);
    const state = await store.read();
    const candidates = [...state.engine.records.filter((row) => row.projectId === projectId && row.collection === 'manual')
      .map((row) => ({ id: row.id, kind: 'manual' })), ...state.entries.filter((entry) => entry.projectId === projectId && allowed(state, entry))
      .map((entry) => ({ id: entry.id, kind: 'inference' }))].slice(0, 200);
    const valid = await checkSources(directory, projectId, candidates);
    const latest = await store.read();
    const items = [];
    let unavailable = 0;
    for (const candidate of candidates) {
      const current = currentItem(latest, projectId, candidate);
      if (!current || candidate.kind === 'inference' && valid.get(candidate.id) !== current.sourceVersion) { unavailable++; continue; }
      const before = contentOf(current.value);
      const { after, reasons } = normalize(before);
      if (!after.title || !after.body) continue;
      items.push(itemSchema.parse({ ...candidate, type: candidate.kind === 'manual' ? current.value.type : current.value.kind,
        before, after, reasons, version: current.version, sourceVersion: current.sourceVersion, sourceSessionIds: current.sourceSessionIds, sourceHash: current.sourceHash, sourceReferences: current.sourceReferences, verification: current.verification }));
    }
    const previewId = retain(previews, { projectId, directory, items });
    return { previewId, items, unavailable, truncated: candidates.length === 200 };
  };
  const apply = async ({ directory, previewId, selectedIds }) => {
    const projectId = await scope(directory);
    const saved = take(previews, previewId, projectId, directory);
    const selected = new Set(selectedIds);
    if (selected.size !== selectedIds.length || selected.size === 0 || [...selected].some((id) => !saved.items.some((item) => `${item.kind}:${item.id}` === id))) throw fail('invalid_request', 400);
    const items = saved.items.filter((item) => selected.has(`${item.kind}:${item.id}`) && item.reasons.length > 0);
    if (!items.length) throw fail('invalid_request', 400);
    const valid = await checkSources(directory, projectId, items);
    if (await scope(directory) !== projectId) throw fail('hy_tidy_scope_changed');
    const results = [];
    await store.update((state) => {
      for (const item of items) {
        const current = currentItem(state, projectId, item);
        if (!current || current.sourceVersion !== item.sourceVersion || item.kind === 'inference' && valid.get(item.id) !== item.sourceVersion) { results.push({ id: item.id, kind: item.kind, state: 'source_changed' }); continue; }
        if (current.version !== item.version) { results.push({ id: item.id, kind: item.kind, state: 'conflict' }); continue; }
        const appliedVersion = write(state, projectId, item, item.after);
        const revisionId = randomUUID();
        const revision = { item, appliedVersion, undone: false, source_refs: item.sourceSessionIds.map((sessionId) => ({ sessionId })) };
        if (item.kind === 'inference') revision.entry_id = item.id;
        state.engine.records.push({ projectId, collection: 'hy-tidy-revision', id: revisionId, value: revision });
        results.push({ id: item.id, kind: item.kind, state: 'applied', revisionId });
      }
    });
    return { results };
  };
  const undo = async ({ directory, revisionIds }) => {
    const projectId = await scope(directory);
    const state = await store.read();
    const rows = revisionIds.map((id) => state.engine.records.find((row) => row.projectId === projectId && row.collection === 'hy-tidy-revision' && row.id === id));
    const valid = await checkSources(directory, projectId, rows.filter(Boolean).map((row) => revisionSchema.parse(row.value).item));
    if (await scope(directory) !== projectId) throw fail('hy_tidy_scope_changed');
    const results = [];
    await store.update((next) => {
      for (const id of revisionIds) {
        const row = next.engine.records.find((record) => record.projectId === projectId && record.collection === 'hy-tidy-revision' && record.id === id);
        if (!row) { results.push({ revisionId: id, state: 'source_changed' }); continue; }
        const revision = revisionSchema.parse(row.value);
        const current = currentItem(next, projectId, revision.item);
        if (revision.undone) { results.push({ revisionId: id, state: 'undone' }); continue; }
        if (!current || current.sourceVersion !== revision.item.sourceVersion || revision.item.kind === 'inference' && valid.get(revision.item.id) !== revision.item.sourceVersion) { results.push({ revisionId: id, state: 'source_changed' }); continue; }
        if (current.version !== revision.appliedVersion) { results.push({ revisionId: id, state: 'conflict' }); continue; }
        write(next, projectId, revision.item, revision.item.before);
        row.value = { ...row.value, undone: true };
        results.push({ revisionId: id, state: 'undone' });
      }
    });
    return { results };
  };
  const readTarget = async (directory) => {
    const root = await fs.realpath(directory);
    if (isSpaceDirectory(root)) throw fail('hy_tidy_isolated_unsupported', 403);
    const target = path.join(root, 'AGENTS.md');
    try {
      const entry = await fs.lstat(target);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 256 * 1024) throw fail('hy_tidy_export_target');
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (stat.ino !== entry.ino || stat.dev !== entry.dev || stat.size > 256 * 1024) throw fail('hy_tidy_export_conflict');
        const content = await handle.readFile('utf8');
        if (Buffer.byteLength(content) > 256 * 1024) throw fail('hy_tidy_export_target');
        return { target, root, content, version: hash([stat.dev, stat.ino, stat.mtimeMs, content]) };
      } finally { await handle.close(); }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return { target, root, content: '', version: 'missing' };
    }
  };
  const exportPreview = async ({ directory, items }) => {
    const projectId = await scope(directory);
    const state = await store.read();
    const selected = items.map(({ id, kind }) => {
      const current = currentItem(state, projectId, { id, kind });
      if (!current) throw fail('hy_tidy_source_changed');
      return itemSchema.parse({ id, kind, type: kind === 'manual' ? current.value.type : current.value.kind, version: current.version,
        sourceVersion: current.sourceVersion, sourceSessionIds: current.sourceSessionIds, sourceHash: current.sourceHash, sourceReferences: current.sourceReferences, verification: current.verification, before: contentOf(current.value), after: contentOf(current.value), reasons: [] });
    });
    const valid = await checkSources(directory, projectId, selected);
    if (selected.some((item) => item.kind === 'inference' && valid.get(item.id) !== item.sourceVersion)) throw fail('hy_tidy_source_changed');
    const target = await readTarget(directory);
    const appendix = selected.map((item) => `## ${item.after.title}\n\n${item.after.body}\n\nMemory kind: ${item.kind}; type: ${item.type}; verification: ${item.verification}.\nSource: ${item.kind === 'manual' ? 'explicitly saved project memory' : JSON.stringify({ sourceHash: item.sourceHash, references: item.sourceReferences })}`).join('\n\n');
    const after = `${target.content}${target.content.endsWith('\n') || !target.content ? '' : '\n'}\n# Reviewed project memory\n\n${appendix}\n`;
    const exportId = retain(exports, { projectId, directory, selected, ...target, after });
    return { exportId, target: target.target, before: target.content, after };
  };
  const exportConfirm = (input) => {
    const work = fileQueue.then(async () => {
      const { directory, exportId, confirmed } = input;
      if (confirmed !== true) throw fail('hy_tidy_confirmation_required', 400);
      const projectId = await scope(directory);
      const saved = take(exports, exportId, projectId, directory);
      const valid = await checkSources(directory, projectId, saved.selected);
      const current = await store.read();
      for (const item of saved.selected) {
        const latest = currentItem(current, projectId, item);
        if (!latest || latest.version !== item.version || latest.sourceVersion !== item.sourceVersion || item.kind === 'inference' && valid.get(item.id) !== item.sourceVersion) throw fail('hy_tidy_source_changed');
      }
      if (await scope(directory) !== projectId) throw fail('hy_tidy_scope_changed');
      const target = await readTarget(directory);
      if (target.root !== saved.root || target.target !== saved.target || target.version !== saved.version) throw fail('hy_tidy_export_conflict');
      const temporary = `${target.target}.hy-${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, saved.after, { mode: 0o600, flag: 'wx' });
        const latestState = await store.read();
        for (const item of saved.selected) {
          const latest = currentItem(latestState, projectId, item);
          if (!latest || latest.version !== item.version || latest.sourceVersion !== item.sourceVersion) throw fail('hy_tidy_source_changed');
        }
        const finalAlias = await readTarget(directory);
        if (finalAlias.root !== saved.root || finalAlias.target !== saved.target || finalAlias.version !== saved.version) throw fail('hy_tidy_export_conflict');
        // Recheck the exact pathname that rename will replace. An alias read
        // cannot validate a different directory's file for this publication.
        const finalTarget = await readTarget(saved.root);
        if (finalTarget.root !== saved.root || finalTarget.target !== saved.target || finalTarget.version !== saved.version) throw fail('hy_tidy_export_conflict');
        await fs.rename(temporary, target.target);
      } finally { await fs.rm(temporary, { force: true }); }
      exports.delete(exportId);
      return { written: true, target: target.target };
    });
    fileQueue = work.catch(() => {}); return work;
  };
  return { preview, apply, undo, revisions, exportPreview, exportConfirm };
}
