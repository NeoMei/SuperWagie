"""Bounded host reads and a request-local mutation overlay for pinned Hy algorithms."""
import copy
import hashlib
import math
import json
from dataclasses import fields
from datetime import datetime

from hy_memory.models.memory import MemoryNode, MemoryLayer, MemoryStatus
from hy_memory.data.vector_store_base import VectorStoreBase
from hy_memory.coding.types import CodingMemory, WorkingFact
from hy_memory.coding.store import _vec_node_id
from hy_memory.pipelines.base import ChatMessage

MAX_BATCH = 100
MAX_LOADED = 512


def digest(value):
    import json
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


def values(items):
    return [getattr(x, 'value', x) for x in items] if items else None


def cosine(a, b):
    if not a or len(a) != len(b):
        return 0.0
    denom = math.sqrt(sum(x*x for x in a) * sum(x*x for x in b))
    return sum(x*y for x, y in zip(a, b)) / denom if denom else 0.0


def record_object(cls, data):
    raw = {f.name: data[f.name] for f in fields(cls) if f.name in data}
    for name in ('created_at', 'updated_at', 'memory_at'):
        if isinstance(raw.get(name), (int, float)):
            raw[name] = datetime.fromtimestamp(raw[name])
        elif isinstance(raw.get(name), str):
            raw[name] = datetime.fromisoformat(raw[name])
    return cls(**raw)


class Overlay:
    def __init__(self, host, context, embed):
        self.host, self.context, self.embed = host, context, embed
        self.nodes = {}
        self.original = {}
        self.changed = set()
        self.deleted = set()
        self.records = {}
        self.record_changes = {}
        self.edges = {}
        self.edge_changes = {}
        self.embed.space_id = context.get('spaceId')
        self.more = False
        self.read_count = 0
        self.failures = embed.failures

    def fail(self, code):
        error = ValueError(code)
        self.failures.append(error)
        raise error

    async def read(self, operation, **params):
        self.read_count += 1
        if self.read_count > 300:
            self.fail('hy_store_read_budget_exceeded')
        return await self.host('host.store', dict(params, operation=operation,
                            namespace=self.context['namespace'], jobId=self.context['jobId']))

    def bind_space(self, space, dimensions=None):
        if self.embed.space_id and self.embed.space_id != space:
            self.fail('hy_embedding_space_changed')
        self.embed.space_id = space
        if dimensions:
            self.embed.dimensions = dimensions

    def scope(self, filters=None):
        result = dict(filters or {})
        # A caller cannot broaden the trusted project or principal.
        result.update(user_id=self.context['userId'], agent_id=self.context['agentId'],
                      workspace_id=self.context['projectId'])
        return result

    def accepts(self, node, filters=None):
        payload = node.get('payload', {})
        for key, expected in self.scope(filters).items():
            if expected is None:
                continue
            actual = payload.get(key)
            if key == 'node_ids':
                actual = node['id']
            if isinstance(expected, list):
                if actual not in expected:
                    return False
            elif actual != expected:
                return False
        return True

    def remember(self, rows):
        for row in rows:
            identity = row.get('id', row.get('node_id'))
            if not identity or identity in self.deleted or identity in self.changed:
                continue
            payload = copy.deepcopy(row.get('payload') or row.get('node') or {})
            if isinstance(payload, MemoryNode):
                payload = payload.to_dict()
            wrapped = {'id': identity, 'content': row.get('content', payload.get('content', '')),
                       'payload': payload, 'vector': row.get('vector', row.get('embedding', [])),
                       'active': row.get('active', payload.get('status') == 'active')}
            if not self.accepts(wrapped):
                continue
            if len(self.nodes) >= MAX_LOADED and identity not in self.nodes:
                self.fail('hy_store_material_budget_exceeded')
            self.nodes[identity] = wrapped
            self.original[identity] = copy.deepcopy(wrapped)

    async def get(self, identity):
        if identity in self.deleted:
            return None
        if identity not in self.nodes:
            response = await self.read('nodes/get', ids=[identity], space_id=self.embed.space_id or self.context.get('spaceId'), include_vectors=True)
            if response.get('space_id'):
                self.bind_space(response['space_id'], response.get('dimensions'))
            self.remember(response.get('nodes', []))
        return self.nodes.get(identity)

    async def select(self, filters=None, limit=100, offset=0):
        limit = min(limit or MAX_BATCH, MAX_BATCH)
        response = await self.read('nodes/list', filters=self.scope(filters), limit=limit, offset=offset,
                                   space_id=self.embed.space_id or self.context.get('spaceId'), include_vectors=True)
        self.remember(response.get('nodes', []))
        self.more = self.more or response.get('total', 0) > offset + limit
        # Overlay changes replace or remove durable rows within this page.
        ids = [r.get('id', r.get('node_id')) for r in response.get('nodes', [])]
        ids.extend(i for i in self.changed if i not in ids)
        return [self.nodes[i] for i in ids if i in self.nodes and i not in self.deleted and self.accepts(self.nodes[i], filters)][:limit]

    async def select_all(self, filters=None, limit=MAX_LOADED):
        maximum = min(limit or MAX_LOADED, MAX_LOADED)
        offset, selected = 0, {}
        while True:
            response = await self.read('nodes/list', filters=self.scope(filters), limit=MAX_BATCH,
                                               offset=offset, space_id=self.embed.space_id, include_vectors=True)
            if response.get('space_id'):
                self.bind_space(response['space_id'], response.get('dimensions'))
            rows = response.get('nodes', [])
            if response.get('total', 0) > maximum:
                self.fail('hy_graph_material_budget_exceeded')
            self.remember(rows)
            for row in rows:
                identity = row.get('id', row.get('node_id'))
                if identity in self.nodes and identity not in self.deleted and self.accepts(self.nodes[identity], filters):
                    selected[identity] = self.nodes[identity]
            offset += len(rows)
            if offset >= response.get('total', offset):
                break
            if len(rows) < MAX_BATCH:
                self.fail('hy_graph_page_incomplete')
        for identity in self.changed:
            row = self.nodes[identity]
            if self.accepts(row, filters):
                selected[identity] = row
            else:
                selected.pop(identity, None)
        selected = {identity: row for identity, row in selected.items() if identity not in self.deleted}
        if len(selected) > maximum:
            self.fail('hy_graph_material_budget_exceeded')
        return list(selected.values())

    async def search(self, vector, filters=None, limit=10, min_score=0.0):
        response = await self.read('nodes/search', vector=vector, filters=self.scope(filters), limit=min(limit + len(self.changed) + len(self.deleted), MAX_BATCH),
                                   min_score=min_score, space_id=self.embed.space_id or self.context.get('spaceId'))
        self.remember(response.get('nodes', []))
        scores = {r.get('id', r.get('node_id')): r.get('score', 0) for r in response.get('nodes', [])}
        for identity in self.changed:
            scores[identity] = cosine(vector, self.nodes[identity]['vector'])
        ranked = sorted(((i, score) for i, score in scores.items() if i in self.nodes and i not in self.deleted and score >= min_score and self.accepts(self.nodes[i], filters)), key=lambda pair: (-pair[1], pair[0]))
        return [(self.nodes[i], score) for i, score in ranked[:limit]]

    async def put(self, node):
        if node.node_id not in self.nodes and len(self.nodes) >= MAX_LOADED:
            self.fail('hy_store_material_budget_exceeded')
        if not node.embedding:
            node.embedding = await self.embed.embed(node.content)
        payload = node.to_dict()
        payload['workspace_id'] = self.context['projectId']
        custom = dict(payload.get('custom') or {})
        # Updates keep accumulated source provenance and real session identities.
        prior = await self.get(node.node_id)
        refs = list((prior or {}).get('payload', {}).get('custom', {}).get('source_refs', []))
        for ref in list(custom.get('source_refs', [])) + (self.context.get('sourceRefs', []) if self.context.get('attachSourceRefs', True) else []):
            if ref not in refs:
                refs.append(ref)
        custom.update(source_refs=refs, source_revision=self.context.get('sourceRevision'), hy_job_id=self.context['jobId'])
        payload['custom'] = custom
        wrapped = {'id': node.node_id, 'content': node.content, 'vector': list(node.embedding),
                   'payload': payload, 'active': node.status == MemoryStatus.ACTIVE}
        if not self.accepts(wrapped):
            self.fail('hy_scope_violation')
        self.nodes[node.node_id] = wrapped
        self.changed.add(node.node_id)
        self.deleted.discard(node.node_id)
        return node.node_id

    async def remove(self, identity):
        previous = await self.get(identity)
        if previous is None:
            return False
        self.deleted.add(identity)
        self.changed.discard(identity)
        return True

    async def record_get(self, kind, identity):
        key = (kind, identity)
        if key not in self.records:
            response = await self.read('records/get', collection=kind, ids=[identity])
            self.records[key] = None
            for row in response.get('records', []):
                self.records[(kind, row['id'])] = row.get('value', {})
        return copy.deepcopy(self.records.get(key))

    def record_put(self, kind, identity, value):
        key = (kind, identity)
        self.records[key] = copy.deepcopy(value)
        self.record_changes[key] = value

    async def relations(self, ids):
        response = await self.read('relations/list', node_ids=list(ids), limit=MAX_BATCH)
        if response.get('total', 0) > MAX_BATCH:
            self.fail('hy_relation_budget_exceeded')
        for row in response.get('relations', []):
            if row['id'] not in self.edge_changes:
                self.edges[row['id']] = row
        return [e for e in self.edges.values() if e and (e['source_id'] in ids or e['target_id'] in ids)]

    def edge(self, source, target, relation, properties=None):
        identity = 'rel_' + digest([source, target, relation])[:32]
        row = dict(id=identity, source_id=source, target_id=target, relation_type=relation, properties=properties or {})
        self.edges[identity] = row
        self.edge_changes[identity] = row
        return True

    def operations(self):
        result = []
        if self.changed:
            result.append({'operation': 'nodes/upsert', 'space_id': self.embed.space_id or self.context.get('spaceId'),
                           'nodes': [self.nodes[i] for i in sorted(self.changed)]})
        if self.deleted:
            result.append({'operation': 'nodes/delete', 'ids': sorted(self.deleted), 'space_id': self.embed.space_id or self.context.get('spaceId')})
        for (kind, identity), value in self.record_changes.items():
            result.append({'operation': 'records/delete' if value is None else 'records/upsert', 'collection': kind, 'id': identity, 'value': value})
        for identity, value in self.edge_changes.items():
            result.append({'operation': 'relations/delete' if value is None else 'relations/upsert', 'id': identity, 'value': value})
        return result


def as_node(wrapped):
    if not wrapped:
        return None
    node = MemoryNode.from_dict(wrapped['payload'])
    node.embedding = wrapped.get('vector') or []
    return node


class VectorAdapter(VectorStoreBase):
    def __init__(self, config, overlay):
        super().__init__(config)
        self.overlay = overlay
        self._client = True
    async def initialize(self):
        pass
    async def close(self):
        pass
    async def upsert(self, node):
        return await self.overlay.put(node)
    async def upsert_batch(self, nodes):
        return [await self.upsert(n) for n in nodes]
    async def update_embedding(self, node_id, embedding):
        node = await self.get_by_id(node_id)
        if not node:
            return False
        node.embedding = embedding
        await self.upsert(node)
        return True
    async def update_payload(self, node_id, updates):
        node = await self.get_by_id(node_id)
        if not node:
            return False
        data = node.to_dict(); data.update(updates)
        revised = MemoryNode.from_dict(data); revised.embedding = node.embedding
        await self.upsert(revised)
        return True
    async def get_by_id(self, node_id):
        return as_node(await self.overlay.get(node_id))
    async def get_by_ids(self, node_ids):
        return [n for n in [await self.get_by_id(i) for i in node_ids] if n]
    async def search(self, query_embedding, limit=10, score_threshold=0, layers=None, status_filter=None, include_sources=None, **kwargs):
        filters = {'layer': values(layers), 'status': values(status_filter) or ['active']}
        if include_sources:
            filters['source'] = include_sources
        if not self.overlay.context.get('readAcrossSessions') and not self.overlay.context.get('crossSessionMaintenance'):
            filters['session_id'] = self.overlay.context['sessionId']
        rows = await self.overlay.search(query_embedding, filters, limit, score_threshold)
        return [{'node_id': row['id'], 'node': as_node(row), 'score': score} for row, score in rows]
    async def list_by_user(self, user_id=None, agent_id=None, status_filter=None, layers=None, limit=100, offset=0, **kwargs):
        filters = {'status': values(status_filter) or ['active'], 'layer': values(layers)}
        if self.overlay.context.get('approvedNodeIds') and not layers == [MemoryLayer.L6_SCHEMA]:
            filters['node_ids'] = self.overlay.context['approvedNodeIds']
        if self.overlay.context.get('s2Offset') and layers != [MemoryLayer.L6_SCHEMA]:
            offset = int(self.overlay.context['s2Offset'])
        rows = await self.overlay.select(filters, min(limit or 100, 100), offset)
        return [as_node(r) for r in rows]
    async def delete(self, node_id):
        return await self.overlay.remove(node_id)
    async def delete_by_isolation_key(self, isolation_key):
        self.overlay.fail('hy_unbounded_delete_refused')
    async def delete_by_metadata(self, **kwargs):
        self.overlay.fail('hy_unbounded_delete_refused')
    async def get_stats(self):
        return {'staged': len(self.overlay.changed)}
    async def count(self, isolation_key):
        return len(await self.list_by_user())
    async def keyword_search(self, query, top_k=10, layers=None, status_filter=None, include_sources=None,
                             exclude_sources=None, only_latest=True, limit=None, **kwargs):
        from hy_memory.pipelines._retrieval.bm25 import tokenize, compute_bm25_scores
        filters = {'layer': values(layers), 'status': values(status_filter) or ['active']}
        if include_sources:
            filters['source'] = include_sources
        if not self.overlay.context.get('readAcrossSessions') and not self.overlay.context.get('crossSessionMaintenance'):
            filters['session_id'] = self.overlay.context['sessionId']
        rows = await self.overlay.select_all(filters)
        candidates = [as_node(row) for row in rows if row['payload'].get('source') not in (exclude_sources or [])
                      and (not only_latest or row['payload'].get('is_latest', True))]
        scores = compute_bm25_scores(tokenize(query), [node.content for node in candidates])
        ranked = sorted(zip(candidates, scores), key=lambda pair: (-pair[1], pair[0].node_id))
        return [dict(node_id=node.node_id, node=node, score=score) for node, score in ranked if score > 0][:min(limit or top_k, MAX_BATCH)]


class CodingAdapter:
    def __init__(self, config, overlay, vector, embed):
        self.config, self.overlay, self.vector, self.embed = config, overlay, vector, embed
        self.pending_supersedes = {}
        self.allows_cross_session = bool(overlay.context.get('crossSessionMaintenance'))
    async def _put(self, obj, kind):
        is_exp = kind == 'experience'
        identity = obj.experience_id if is_exp else obj.fact_id
        content = obj.task + '\n' + obj.solution if is_exp else obj.statement
        # Embed before modifying any old rows. Failed replacements retain all old rows.
        vector_text = obj.task if is_exp else (obj.subject + ': ' + obj.statement if obj.subject else obj.statement)
        keys = [k for k in obj.search_keys if k] if is_exp else []
        if len(keys) > 32:
            self.overlay.fail('hy_experience_keys_too_large')
        vectors = await self.embed.embed_batch([vector_text] + keys)
        embedding = vectors[0]
        node = MemoryNode(node_id=identity, content=content, user_id=obj.user_id, agent_id=obj.agent_id,
                          session_id=obj.session_id or '', layer=MemoryLayer.L3_SUMMARY if is_exp else MemoryLayer.L2_FACT,
                          source='superwagie', status=MemoryStatus.ACTIVE if is_exp or obj.status == 'active' else MemoryStatus.SHADOW,
                          embedding=embedding, custom={'hy_kind': kind, 'record': obj.to_dict(), 'embedding_text': vector_text})
        previous = await self.vector.get_by_id(identity)
        previous_keys = list((previous.custom if previous else {}).get('key_node_ids', []))
        node.custom['key_node_ids'] = [_vec_node_id(identity, i + 1) for i in range(len(keys))]
        await self.vector.upsert(node)
        for key, key_vector, key_id in zip(keys, vectors[1:], node.custom['key_node_ids']):
            key_node = MemoryNode(node_id=key_id, content=key, embedding=key_vector, user_id=obj.user_id, agent_id=obj.agent_id,
                          session_id=obj.session_id or '', source='superwagie', layer=MemoryLayer.L3_SUMMARY,
                          custom={'hy_kind': 'experience_key', 'experience_id': identity, 'embedding_text': key})
            await self.vector.upsert(key_node)
            self.overlay.edge(identity, key_id, 'EXPERIENCE_KEY')
        for old_key in previous_keys:
            if old_key not in node.custom['key_node_ids']:
                await self.vector.delete(old_key)
    async def insert(self, memory):
        memory.created_at = memory.created_at or datetime.now()
        memory.updated_at = datetime.now()
        await self._put(memory, 'experience')
    async def update(self, memory):
        prior = await self.get_by_id(memory.experience_id)
        if prior:
            memory.created_at = prior.created_at
            memory.source_fact_ids = list(dict.fromkeys(prior.source_fact_ids + memory.source_fact_ids))
            self.overlay.record_put('code_history', memory.experience_id + ':' + self.overlay.context['jobId'],
                                    {'experience_id': memory.experience_id, 'previous': prior.to_dict(), 'source_refs': self.overlay.context.get('sourceRefs', [])})
        await self.insert(memory)
    async def get_by_id(self, identity, user_id=None):
        node = await self.vector.get_by_id(identity)
        if not node or node.custom.get('hy_kind') != 'experience':
            return None
        return record_object(CodingMemory, node.custom['record'])
    async def get_many(self, ids, user_id=None):
        return [x for x in [await self.get_by_id(i, user_id) for i in ids] if x]
    async def delete(self, identity, user_id=None):
        node = await self.vector.get_by_id(identity)
        if node:
            for key_id in node.custom.get('key_node_ids', []):
                await self.vector.delete(key_id)
        return await self.vector.delete(identity)
    async def search_by_query_embedding(self, vector, top=5, session_id=None, **kwargs):
        filters = {'layer': ['l3_summary'], 'status': ['active']}
        if not self.overlay.context.get('crossSessionMaintenance') and session_id:
            filters['session_id'] = session_id
        best = {}
        for row, score in await self.overlay.search(vector, filters, min(top * 4, 100)):
            custom = row['payload'].get('custom', {})
            if custom.get('hy_kind') not in ('experience', 'experience_key'):
                continue
            identity = custom.get('experience_id', row['id'])
            best[identity] = max(best.get(identity, 0.0), score)
        return [{'experience_id': identity, 'score': score} for identity, score in sorted(best.items(), key=lambda pair: (-pair[1], pair[0]))[:top]]
    async def insert_fact(self, fact):
        fact.created_at = fact.created_at or datetime.now()
        await self._put(fact, 'fact')
        # Upstream retires predecessors before insert. Defer retirement until the
        # successor has embedded and staged successfully.
        for old_id in self.pending_supersedes.pop(fact.fact_id, []):
            old = await self.get_fact(old_id)
            if old:
                old.status, old.fact_link = 'superseded', fact.fact_id
                await self._put(old, 'fact')
                self.overlay.edge(fact.fact_id, old_id, 'FACT_SUPERSEDES')
    async def get_fact(self, identity, user_id=None):
        node = await self.vector.get_by_id(identity)
        if not node or node.custom.get('hy_kind') != 'fact':
            return None
        return record_object(WorkingFact, node.custom['record'])
    async def search_facts(self, vector, top=5, session_id=None, **kwargs):
        filters = {'layer': ['l2_fact'], 'status': ['active']}
        if not self.overlay.context.get('crossSessionMaintenance') and session_id:
            filters['session_id'] = session_id
        result = []
        for row, score in await self.overlay.search(vector, filters, min(top * 4, 100)):
            if row['payload'].get('custom', {}).get('hy_kind') == 'fact':
                result.append((record_object(WorkingFact, row['payload']['custom']['record']), score))
        query_text = kwargs.get('query_text')
        if query_text and result:
            from hy_memory.coding.lexical import rerank
            order = rerank(query_text, [(f.fact_id, score, f.subject + ': ' + f.statement) for f, score in result])
            if order:
                position = {identity: i for i, identity in enumerate(order)}
                result.sort(key=lambda pair: position[pair[0].fact_id])
        return result[:top]
    async def supersede_fact(self, old_id, new_id):
        if not await self.get_fact(old_id):
            return False
        self.pending_supersedes.setdefault(new_id, []).append(old_id)
        return True
    async def get_fact_ancestors(self, identity, max_depth=8, **kwargs):
        result, frontier, seen = [], [identity], {identity}
        for _ in range(min(max_depth, 9)):
            next_ids = []
            for edge in await self.overlay.relations(frontier):
                if edge['relation_type'] == 'FACT_SUPERSEDES' and edge['source_id'] in frontier and edge['target_id'] not in seen:
                    fact = await self.get_fact(edge['target_id'])
                    seen.add(edge['target_id'])
                    if fact:
                        result.append(fact); next_ids.append(fact.fact_id)
            if not next_ids:
                break
            frontier = next_ids
        return result
    async def set_experience_source_facts(self, identity, ids):
        node = await self.vector.get_by_id(identity)
        if node:
            node.custom['record']['source_fact_ids'] = ids
            for fact_id in ids:
                self.overlay.edge(identity, fact_id, 'FACT_EXPERIENCE')
            await self.vector.upsert(node)
    async def set_fact_derived_experiences(self, identity, ids):
        node = await self.vector.get_by_id(identity)
        if node:
            node.custom['record']['derived_experience_ids'] = ids
            await self.vector.upsert(node)
    def trace_id(self):
        ctx = self.overlay.context
        return digest([ctx['userId'], ctx['agentId'], ctx['projectId'], ctx['sessionId']])
    async def get_recent_trace_messages(self, max_user_turns=5, **kwargs):
        trace = await self.overlay.record_get('trace', self.trace_id())
        refs = self.overlay.context.setdefault('sourceRefs', [])
        for ref in (trace or {}).get('source_refs', []):
            if ref not in refs:
                refs.append(ref)
        return [ChatMessage.from_dict(x) for x in (trace or {}).get('messages', [])][-40:]
    async def append_trace(self, messages, **kwargs):
        saved = await self.overlay.record_get('trace', self.trace_id()) or {}
        previous = [ChatMessage.from_dict(item) for item in saved.get('messages', [])][-40:]
        data = [m.to_dict() for m in previous + messages][-40:]
        refs = list(saved.get('source_refs', []))
        for ref in self.overlay.context.get('sourceRefs', []):
            if ref not in refs:
                refs.append(ref)
        self.overlay.record_put('trace', self.trace_id(), {'messages': data,
            'project_id': self.overlay.context['projectId'], 'session_id': self.overlay.context['sessionId'],
            'source_refs': refs, 'node_ids': list(saved.get('node_ids', []))})


class GraphAdapter:
    """Graph nodes share the vector index; typed edges use scoped host records."""
    def __init__(self, overlay, vector):
        self.overlay, self.vector = overlay, vector
    async def get_node(self, identity):
        node = await self.vector.get_by_id(identity)
        return node if node and node.layer == MemoryLayer.L6_SCHEMA and node.custom.get('representation_role') != 'behavior' else None
    async def upsert_memory_node(self, node):
        if node.layer != MemoryLayer.L6_SCHEMA:
            self.overlay.fail('hy_graph_layer_unsupported')
        node.embedding = getattr(node, '_graph_embedding', None) or node.embedding
        # A schema's references come from its evidence, then Node validates the
        # supporting source revisions again at commit.
        node.session_id = self.overlay.context['sessionId']
        node.custom = dict(node.custom or {}, hy_kind='schema', verification='unverified', status='candidate')
        node.custom.setdefault('schema_kind', 'behavior_pattern')
        node.custom['embedding_text'] = node.custom.get('retrieval_text') or node.content
        await self.vector.upsert(node)
        return node.node_id
    async def get_all_nodes(self, layer=None, status=None, limit=100, **kwargs):
        filters = {'layer': values([layer or MemoryLayer.L6_SCHEMA]), 'status': values([status or MemoryStatus.ACTIVE])}
        rows = await self.overlay.select_all(filters, limit=limit)
        return [as_node(row) for row in rows if row['payload'].get('custom', {}).get('representation_role') != 'behavior']
    async def vector_search(self, query_embedding, layers=None, limit=10, score_threshold=0, **kwargs):
        hits = await self.vector.search(query_embedding, layers=[MemoryLayer.from_string(x) for x in layers or ['l6_schema']], limit=limit, score_threshold=score_threshold, include_sources=kwargs.get('include_sources'))
        return [dict(node_id=h['node_id'], content=h['node'].content, layer=h['node'].layer.value,
                     confidence=h['node'].confidence, score=h['score'], custom_json=h['node'].custom) for h in hits]
    async def beh_vector_search(self, query_beh_embedding, isolation_key='', limit=10):
        rows = await self.overlay.select_all({'layer':['l6_schema'], 'status':['shadow']})
        candidates = {}
        for row in rows:
            custom = row['payload'].get('custom', {})
            if custom.get('representation_role') != 'behavior':
                continue
            eligible = self.overlay.context.get('recallEligibleNodeIds')
            if eligible is not None and custom.get('owner_node_id') not in eligible:
                continue
            owner = await self.get_node(custom.get('owner_node_id'))
            if not owner or owner.status != MemoryStatus.ACTIVE or owner.custom.get('behavior_node_id') != row['id']:
                continue
            score = cosine(query_beh_embedding, row['vector'])
            if score <= 0:
                continue
            candidates[owner.node_id] = dict(node_id=owner.node_id, node=owner, content=owner.content,
                                            embedding=owner.embedding, score=score, beh_distance=1-score)
        return sorted(candidates.values(), key=lambda hit: (-hit['score'], hit['node_id']))[:limit]
    async def ensure_vdbref(self, identity, layer='unknown'):
        if not await self.vector.get_by_id(identity):
            self.overlay.fail('hy_unknown_evidence')
        return identity
    async def add_derived_from(self, source, target):
        parent, evidence = await self.get_node(source), await self.vector.get_by_id(target)
        if not parent or not evidence:
            self.overlay.fail('hy_unknown_evidence')
        refs = list(parent.custom.get('source_refs', []))
        for ref in evidence.custom.get('source_refs', []):
            if ref not in refs:
                refs.append(ref)
        parent.custom['source_refs'] = refs
        await self.vector.upsert(parent)
        return self.overlay.edge(source, target, 'DERIVED_FROM')
    async def get_evidence_vdbrefs(self, identity):
        return [{'node_id': e['target_id']} for e in await self.overlay.relations([identity]) if e['source_id'] == identity and e['relation_type'] == 'DERIVED_FROM']
    async def add_edge(self, source, target, edge_type, properties=None):
        if not await self.vector.get_by_id(source) or not await self.vector.get_by_id(target):
            self.overlay.fail('hy_unknown_relation_node')
        return self.overlay.edge(source, target, edge_type, properties)
    def behavior_id(self, identity):
        return 'hy_behavior_' + digest([identity, 'behavior'])[:32]
    async def update_embedding(self, identity, embedding=None, beh_embedding=None):
        node = await self.get_node(identity)
        if not node:
            self.overlay.fail('hy_unknown_schema')
        if embedding is not None:
            await self.vector.update_embedding(identity, embedding)
        if beh_embedding is not None:
            role_id = self.behavior_id(identity)
            behavior = MemoryNode(node_id=role_id, content=node.custom.get('beh_abstraction') or node.content,
                                  user_id=node.user_id, agent_id=node.agent_id, session_id=node.session_id,
                                  layer=MemoryLayer.L6_SCHEMA, status=MemoryStatus.SHADOW, source=node.source,
                                  embedding=beh_embedding, custom={'hy_kind':'schema_behavior',
                                      'representation_role':'behavior', 'owner_node_id':identity,
                                      'source_refs':node.custom.get('source_refs', [])})
            await self.vector.upsert(behavior)
            node.custom['behavior_node_id'] = role_id
            await self.vector.upsert(node)
            self.overlay.edge(identity, role_id, 'SCHEMA_BEHAVIOR')
        return True
    async def get_basics_with_beh(self, isolation_key=''):
        result = []
        for node in await self.get_all_nodes(limit=500):
            if not node.custom.get('_has_beh'):
                continue
            behavior = await self.vector.get_by_id(node.custom.get('behavior_node_id') or self.behavior_id(node.node_id))
            if not behavior or behavior.custom.get('owner_node_id') != node.node_id or behavior.custom.get('representation_role') != 'behavior':
                self.overlay.fail('hy_behavior_representation_missing')
            result.append({'node_id':node.node_id, 'content':node.content,
                           'embedding':node.embedding, 'beh_embedding':behavior.embedding})
        return result
    async def get_cross_abstracts_targets(self, identity):
        return [edge['target_id'] for edge in await self.overlay.relations([identity])
                if edge['source_id'] == identity and edge['relation_type'] == 'CROSS_ABSTRACTS_TO']
    async def add_cross_abstracts_to(self, source, target):
        basic, core = await self.get_node(source), await self.get_node(target)
        if not basic or not core or source == target:
            self.overlay.fail('hy_unknown_schema')
        refs = list(core.custom.get('source_refs', []))
        for ref in basic.custom.get('source_refs', []):
            if ref not in refs:
                refs.append(ref)
        core.custom['source_refs'] = refs
        await self.vector.upsert(core)
        return self.overlay.edge(source, target, 'CROSS_ABSTRACTS_TO')
    async def update_node(self, identity, updates):
        node = await self.get_node(identity)
        if not node:
            return False
        updates = dict(updates)
        if 'custom_json' in updates:
            custom = updates.pop('custom_json')
            try:
                custom = json.loads(custom) if isinstance(custom, str) else custom
            except ValueError:
                self.overlay.fail('hy_schema_custom_invalid')
            if not isinstance(custom, dict):
                self.overlay.fail('hy_schema_custom_invalid')
            updates['custom'] = dict(node.custom, **custom)
        if 'superseded_by_id' in updates:
            successor = updates.pop('superseded_by_id')
            updates['superseded_by'] = [successor] if successor else []
        updated = await self.vector.update_payload(identity, updates)
        abstraction = updates.get('custom', {}).get('beh_abstraction')
        if abstraction:
            behavior = await self.vector.get_by_id(node.custom.get('behavior_node_id') or self.behavior_id(identity))
            if behavior:
                behavior.content = abstraction
                behavior.custom['embedding_text'] = abstraction
                await self.vector.upsert(behavior)
        return updated
    async def delete_node(self, identity):
        for row in await self.overlay.relations([identity]):
            if row['relation_type'] == 'SCHEMA_BEHAVIOR' and row['source_id'] == identity:
                await self.vector.delete(row['target_id'])
            self.overlay.edges.pop(row['id'], None)
            self.overlay.edge_changes[row['id']] = None
        return await self.vector.delete(identity)
    async def add_topic_tag(self, identity, tag, isolation_key='', **kwargs):
        node = await self.get_node(identity)
        if not node:
            return False
        node.tags = list(dict.fromkeys(node.tags + [tag]))
        await self.vector.upsert(node)
        return True
    async def get_all_topics(self, isolation_key=''):
        nodes = await self.get_all_nodes()
        return [{'name': tag} for tag in sorted({t for n in nodes for t in n.tags})]
    async def find_referencing_memories(self, ids, limit=50):
        rows = await self.overlay.relations(ids)
        result = []
        for row in rows:
            if row['relation_type'] == 'DERIVED_FROM' and row['target_id'] in ids:
                node = await self.get_node(row['source_id'])
                if node:
                    result.append(dict(node_id=node.node_id, content=node.content, layer=node.layer.value,
                                       confidence=node.confidence, evidence_vdb_id=row['target_id']))
        return result[:limit]
    async def expand_from_anchors(self, anchor_ids, max_hops=2, max_nodes=50, **kwargs):
        seen, frontier, result = set(anchor_ids), set(anchor_ids), []
        for _ in range(min(max_hops, 2)):
            next_ids = set()
            for edge in await self.overlay.relations(frontier):
                for identity in [edge['source_id'], edge['target_id']]:
                    if identity in seen:
                        continue
                    seen.add(identity); next_ids.add(identity)
                    node = await self.vector.get_by_id(identity)
                    if node:
                        result.append(dict(node_id=identity, content=node.content, layer=node.layer.value, confidence=node.confidence))
                    if len(result) >= min(max_nodes, 100):
                        return result
            frontier = next_ids
            if not frontier:
                break
        return result
