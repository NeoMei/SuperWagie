import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { findThreatPattern } from '../agent-memory/threat-patterns.js';

const entrySchema = z.object({
  id: z.string().min(1).max(1024), title: z.string().min(1).max(60), body: z.string().min(1).max(2000),
  type: z.enum(['fact', 'preference', 'reference']),
  createdAt: z.number().finite().nonnegative(), updatedAt: z.number().finite().nonnegative(),
  flagged: z.boolean().optional(), sessionId: z.string().min(1).optional(),
});
const memorySchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) });
const recordSchema = entrySchema.extend({ scope: z.enum(['global', 'project']) });
const markerSchema = z.object({ version: z.literal(1), scope: z.enum(['global', 'project']) });
const authoritySchema = markerSchema.extend({ state: z.enum(['pending', 'shared']) });
const scopeQueues = new Map();
const serializeScope = (key, operation) => {
  const work = (scopeQueues.get(key) ?? Promise.resolve()).then(operation);
  const settled = work.then(() => {}, () => {});
  scopeQueues.set(key, settled);
  void settled.then(() => { if (scopeQueues.get(key) === settled) scopeQueues.delete(key); });
  return work;
};
const authorityPath = (resolved) => `${z.string().min(1).parse(resolved.filePath)}.shared-state`;
const readAuthority = async (resolved) => {
  try { return authoritySchema.parse(JSON.parse(await fs.readFile(authorityPath(resolved), 'utf8'))); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
};
const writeAuthority = async (resolved, target, state) => {
  const file = authorityPath(resolved); const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, scope: target.scope, state }), { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
};
const targetSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global') }),
  z.object({ scope: z.literal('project'), projectId: z.string().min(1) }),
]);
const scopeOf = (resolved) => {
  const target = targetSchema.parse(resolved);
  return { scope: target.scope, projectId: target.scope === 'global' ? 'global' : target.projectId };
};
const scopeImported = (state, target) => {
  const marker = state.engine.records.find((row) => row.collection === 'manual-scope' && row.id === 'legacy-v1' && row.projectId === target.projectId);
  if (!marker) return false;
  if (markerSchema.parse(marker.value).scope !== target.scope) throw new Error('Manual memory scope mismatch');
  return true;
};
const readEntries = (state, target) => state.engine.records
  .filter((row) => row.collection === 'manual' && row.projectId === target.projectId)
  .map((row) => {
    const { scope, ...entry } = recordSchema.parse(row.value);
    if (scope !== target.scope || entry.id !== row.id) throw new Error('Manual memory identity mismatch');
    if (findThreatPattern(`${entry.title}\n${entry.body}`)) entry.flagged = true;
    return entry;
  })
  .sort((left, right) => right.updatedAt - left.updatedAt);
const dirty = (state, projectId) => {
  if (!state.engine.dirtyProjects.includes(projectId)) state.engine.dirtyProjects.push(projectId);
};

/** Manual memory and Hy state share one commit owner. Legacy files stay intact. */
export function createSharedAgentMemoryPersistence({ store: owner, onChanged = () => {} }) {
  const ensureImported = async (resolved, readLegacy) => {
    const target = scopeOf(resolved);
    const authority = await readAuthority(resolved);
    if (authority && authority.scope !== target.scope) throw new Error('Manual memory scope mismatch');
    let current;
    try { current = await owner().read(); }
    catch (error) {
      if (!authority && ['memory_backend_unavailable', 'backend_unavailable'].includes(error?.code)) return null;
      throw error;
    }
    if (scopeImported(current, target)) {
      if (authority?.state !== 'shared') await writeAuthority(resolved, target, 'shared');
      return target;
    }
    if (authority?.state === 'shared') throw Object.assign(new Error('The authoritative shared memory scope is unavailable'), { code: 'manual_shared_scope_missing' });
    const legacy = memorySchema.parse(await readLegacy());
    if (!authority) await writeAuthority(resolved, target, 'pending');
    await owner().update((state) => {
      if (scopeImported(state, target)) return;
      for (const entry of legacy.entries) {
        if (state.engine.records.some((row) => row.collection === 'manual' && row.id === entry.id && row.projectId === target.projectId)) continue;
        state.engine.records.push({ collection: 'manual', id: entry.id, projectId: target.projectId, value: { ...entry, scope: target.scope } });
      }
      state.engine.records.push({ collection: 'manual-scope', id: 'legacy-v1', projectId: target.projectId, value: { version: 1, scope: target.scope } });
      if (legacy.entries.length) dirty(state, target.projectId);
    });
    await writeAuthority(resolved, target, 'shared');
    onChanged(target.projectId);
    return target;
  };
  return {
    read(resolved, readLegacy) {
      return serializeScope(authorityPath(resolved), async () => {
        const target = await ensureImported(resolved, readLegacy);
        if (!target) return memorySchema.parse(await readLegacy());
        return { version: 1, entries: readEntries(await owner().read(), target) };
      });
    },
    update(resolved, readLegacy, change, writeLegacy) {
      return serializeScope(authorityPath(resolved), async () => {
        const target = await ensureImported(resolved, readLegacy);
        if (!target) {
          const current = memorySchema.parse(await readLegacy());
          const result = change(current);
          if (result && result.entries !== current.entries) {
            if (!writeLegacy) throw new Error('Manual legacy persistence is unavailable');
            await writeLegacy(memorySchema.parse({ version: 1, entries: result.entries }));
          }
          return result;
        }
        let result;
        await owner().update((state) => {
          const current = { version: 1, entries: readEntries(state, target) };
          result = change(current);
          if (!result || result.entries === current.entries) return;
          const entries = memorySchema.parse({ version: 1, entries: result.entries }).entries;
          state.engine.records = state.engine.records.filter((row) => row.collection !== 'manual' || row.projectId !== target.projectId);
          for (const entry of entries) state.engine.records.push({ collection: 'manual', id: entry.id, projectId: target.projectId, value: { ...entry, scope: target.scope } });
          dirty(state, target.projectId);
        });
        onChanged(target.projectId);
        return result;
      });
    },
  };
}

/** Explicit records remain unverified and carry their original scope and type. */
export function readManualReferences({ state, projectId, query = '', includeGlobal = true }) {
  const needle = query.trim().toLocaleLowerCase();
  const scopes = [{ scope: 'project', projectId }, ...(includeGlobal ? [{ scope: 'global', projectId: 'global' }] : [])];
  const references = scopes.flatMap((target) => readEntries(state, target).filter((entry) => !entry.flagged)
    .filter((entry) => !needle || `${entry.title}\n${entry.body}`.toLocaleLowerCase().includes(needle))
    .map((entry) => ({ ...entry, ...target, kind: 'manual', source: 'manual', status: 'active', verification: 'unverified',
      sourceReferences: [], limitations: ['Saved memory may be outdated. Verify current sources before acting.'] })));
  return references.sort((left, right) => Number(right.title.toLocaleLowerCase() === needle) - Number(left.title.toLocaleLowerCase() === needle)
    || Number(left.scope === 'global') - Number(right.scope === 'global') || right.updatedAt - left.updatedAt);
}
