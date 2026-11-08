import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { decodeMemoryLedgerRecords } from './store.js';
import { hySourceAuthority, memoryNamespace } from './organizer.js';
import { hySpaceCopyEligible } from './spaces.js';
import { eligibleManualMemory, manualIndexMarkers } from './manual-index.js';

const fail = () => { throw new Error('hy_transport_plan_rejected'); };
const identity = z.object({ configurationId: z.string().min(1), spaceId: z.string().min(1), dimensions: z.literal(1024) });
const rowSchema = z.object({ collection: z.string().min(1), id: z.string().min(1), valueRaw: z.string() });
const nodeSchema = z.object({ namespace: z.string(), spaceId: z.string(), id: z.string(), content: z.string(), payloadRaw: z.string(),
  active: z.boolean(), dimensions: z.literal(1024), vectorFloat32LE: z.string(), digest: z.string().optional() });
const inputSchema = z.object({ tenantId: z.number().int().positive(), kbId: z.string().min(1), oldIdentity: identity, targetIdentity: identity,
  rawLedger: z.object({ namespace: z.literal('superwagie:memory'), revision: z.number().int().nonnegative(), records: z.array(rowSchema) }), scopedNodes: z.array(nodeSchema) });
const sha = (value) => createHash('sha256').update(value).digest('hex');
const frameHash = (parts) => {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length); hash.update(bytes);
  }
  return hash.digest('hex');
};
const compare = (keys) => (a, b) => { for (const key of keys) { const order = Buffer.compare(Buffer.from(a[key]), Buffer.from(b[key])); if (order) return order; } return 0; };
const key = (row) => JSON.stringify([row.collection, row.id]);
const engineId = (row) => `hy:${sha(JSON.stringify([row.projectId, row.collection, row.id]))}`;

/** Pure eligibility plan. Native identities and exact raw bytes belong to one frozen snapshot. */
export function planHyTransportRebind(rawInput) {
  const { tenantId, kbId, rawLedger, scopedNodes, oldIdentity, targetIdentity } = inputSchema.parse(rawInput);
  if (oldIdentity.spaceId === targetIdentity.spaceId || oldIdentity.configurationId === targetIdentity.configurationId) fail();
  const records = rawLedger.records.map((row) => ({ ...row, value: JSON.parse(row.valueRaw) }));
  if (new Set(records.map(key)).size !== records.length || records.filter((r) => r.collection === 'meta' && r.id === 'control').length !== 1) fail();
  const state = decodeMemoryLedgerRecords(records); if (!state) fail();
  const rawRows = new Map(records.map((row) => [key(row), row]));
  const authority = (row) => {
    const found = rawRows.get(key({ collection: 'entry', id: engineId(row) }));
    if (!found || found.value.projectId !== row.projectId || found.value.collection !== row.collection || found.value.id !== row.id) fail();
    return found;
  };
  for (const row of state.engine.records) authority(row);
  if (state.engine.records.some((r) => r.collection === 'model-space-migration')) fail();
  const expectedLedgerDigest = frameHash(['hy-transport-ledger-v1', tenantId, kbId, rawLedger.namespace, rawLedger.revision, records.length,
    ...[...records].sort(compare(['collection', 'id'])).flatMap((r) => [r.collection, r.id, r.valueRaw])]);
  const nodes = [...scopedNodes].sort(compare(['namespace', 'spaceId', 'id']));
  if (new Set(nodes.map((n) => JSON.stringify([n.namespace, n.spaceId, n.id]))).size !== nodes.length) fail();
  const digests = new Map();
  for (const node of nodes) {
    const vector = Buffer.from(node.vectorFloat32LE, 'base64');
    if (node.spaceId !== oldIdentity.spaceId || vector.length !== 4096 || vector.toString('base64') !== node.vectorFloat32LE) fail();
    for (let offset = 0; offset < vector.length; offset += 4) if (!Number.isFinite(vector.readFloatLE(offset))) fail();
    const digest = frameHash(['hy-transport-node-v1', tenantId, kbId, node.namespace, node.spaceId, node.id, node.content, node.payloadRaw, node.active ? '1' : '0', node.dimensions, vector]);
    if (node.digest && node.digest !== digest) fail(); digests.set(node, digest);
  }
  const expectedSourceNodesDigest = frameHash(['hy-transport-node-set-v1', tenantId, kbId, nodes.length, ...nodes.map((n) => Buffer.from(digests.get(n), 'hex'))]);
  const selectedNodes = []; const mutations = new Map(); const exclusions = [];
  const patch = (row) => {
    const original = authority(row); const next = JSON.parse(original.valueRaw);
    if (next.value.configurationId !== oldIdentity.configurationId || next.value.spaceId !== oldIdentity.spaceId) fail();
    next.value.configurationId = targetIdentity.configurationId; next.value.spaceId = targetIdentity.spaceId;
    const restored = structuredClone(next); restored.value.configurationId = oldIdentity.configurationId; restored.value.spaceId = oldIdentity.spaceId;
    if (!isDeepStrictEqual(restored, original.value)) fail();
    mutations.set(original.id, { collection: original.collection, id: original.id, valueRaw: JSON.stringify(next) });
  };
  const select = (node, rows) => selectedNodes.push({ namespace: node.namespace, sourceSpaceId: node.spaceId, nodeId: node.id,
    expectedNodeDigest: digests.get(node), authorityRecordIds: rows.map((r) => ({ collection: r.collection, id: r.id })), targetSpaceId: targetIdentity.spaceId });
  const bindings = state.engine.records.filter((r) => r.collection === 'model-space' && r.id === 'current'
    && r.value.configurationId === oldIdentity.configurationId && r.value.spaceId === oldIdentity.spaceId);
  for (const binding of bindings) {
    if (binding.value.dimensions !== undefined && binding.value.dimensions !== 1024) fail();
    const projectId = binding.projectId; const allowed = hySourceAuthority(state, projectId);
    patch(binding);
    for (const node of nodes.filter((n) => ['core', 'cards'].some((kind) => n.namespace === `${memoryNamespace(projectId)}:${kind}`))) {
      const kind = node.namespace.endsWith(':core') ? 'core' : 'cards'; const payload = JSON.parse(node.payloadRaw);
      let eligible = false;
      try { eligible = hySpaceCopyEligible(state, projectId, kind, { ...node, space_id: node.spaceId, payload }); } catch { eligible = false; }
      if (kind === 'core') {
        eligible &&= allowed.nodes.has(node.id);
        if (eligible) select(node, [authority(binding), authority(state.engine.records.find((r) => r.projectId === projectId && r.collection === 'node-source' && r.id === node.id))]);
      } else {
        const entry = state.entries.find((e) => e.projectId === projectId && e.id === node.id);
        eligible &&= Boolean(entry && node.content === entry.body && payload.entry_id === entry.id && payload.project_id === projectId && payload.title === entry.title && payload.representation === 'card');
        if (eligible) select(node, [authority(binding), rawRows.get(key({ collection: 'entry', id: entry.id }))]);
      }
    }
  }
  const scopes = new Set(state.engine.records.filter((r) => r.collection === 'manual-index').map((r) => r.projectId));
  for (const projectId of scopes) {
    const entries = eligibleManualMemory(state, projectId);
    for (const [id, marker] of manualIndexMarkers(state, projectId)) {
      if (marker.state !== 'ready') fail();
      if (marker.spaceId !== oldIdentity.spaceId || marker.configurationId !== oldIdentity.configurationId || marker.dimensions !== 1024) continue;
      const entry = entries.get(id); if (!entry || marker.sourceHash !== entry.sourceHash) continue;
      const node = nodes.find((n) => n.namespace === `${memoryNamespace(projectId)}:manual` && n.id === id); if (!node) continue;
      const payload = JSON.parse(node.payloadRaw);
      const expected = { entry_id: id, project_id: projectId, scope: entry.scope, manual_type: entry.type, title: entry.title,
        representation: 'manual', source_hash: entry.sourceHash, verification: 'unverified' };
      if (node.content !== `${entry.title}\n\n${entry.body}` || Object.entries(expected).some(([k, v]) => payload[k] !== v)) continue;
      const markerRow = state.engine.records.find((r) => r.projectId === projectId && r.collection === 'manual-index' && r.id === id);
      const manualRow = state.engine.records.find((r) => r.projectId === projectId && r.collection === 'manual' && r.id === id);
      select(node, [authority(markerRow), authority(manualRow)]); patch(markerRow);
    }
  }
  const selectedKeys = new Set(selectedNodes.map((n) => JSON.stringify([n.namespace, n.nodeId])));
  for (const node of nodes) if (!selectedKeys.has(JSON.stringify([node.namespace, node.id]))) exclusions.push({ namespace: node.namespace, nodeId: node.id, reason: 'source_not_current' });
  return { expectedLedgerDigest, expectedSourceNodesDigest, selectedNodes, ledgerMutations: [...mutations.values()], exclusions,
    beforeAfterCounts: { source: nodes.length, selected: selectedNodes.length, excluded: exclusions.length, inactive: nodes.filter((n) => !n.active && selectedKeys.has(JSON.stringify([n.namespace, n.id]))).length, markers: mutations.size } };
}
