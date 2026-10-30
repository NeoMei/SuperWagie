"""Actual Hy hybrid reader over the governed, request-local shared-store adapters."""
from hy_memory.models.memory import MemoryLayer, MemoryStatus
from hy_memory.pipelines.base import ReadRequest
from hy_memory.pipelines.reader_hybrid import HybridReadPipeline
from hy_memory.pipelines._retrieval.bm25 import tokenize, compute_bm25_scores
from adapters import VectorAdapter, GraphAdapter, as_node, cosine, values, digest, MAX_BATCH
from query_embedding import QueryEmbedService


class ReaderVectorAdapter(VectorAdapter):
    def memory_node(self,row):
        node = as_node(row)
        if not node or node.custom.get('hy_kind') != 'fact':
            return node
        # Earlier coding adapters stored version links only inside the record.
        # Hydrate host-authorized rows in memory; persisted payloads stay intact.
        record = node.custom.get('record') or {}
        if record.get('status') == 'superseded' and record.get('fact_link'):
            node.status = MemoryStatus.SUPERSEDED
            node.is_latest = False
            node.superseded_by = list(dict.fromkeys(list(node.superseded_by or []) + [record['fact_link']]))
        predecessors = [prior['id'] for prior in self.overlay.nodes.values()
                        if prior['payload'].get('custom',{}).get('hy_kind')=='fact'
                        and prior['payload']['custom'].get('record',{}).get('status')=='superseded'
                        and prior['payload']['custom']['record'].get('fact_link')==node.node_id]
        node.supersedes = list(dict.fromkeys(list(node.supersedes or []) + predecessors))
        return node

    async def get_by_id(self,node_id):
        candidates = self.overlay.context.get('recallCandidateNodeIds')
        if candidates is not None and node_id not in candidates:
            return None
        return self.memory_node(await self.overlay.get(node_id))

    async def get_by_ids(self,node_ids):
        return [node for node in [await self.get_by_id(identity) for identity in node_ids] if node]

    def filters(self, layers=None, status_filter=None, include_sources=None):
        selected = {'layer':values(layers), 'status':values(status_filter) or ['active']}
        if include_sources:
            selected['source'] = include_sources
        if 'recallCandidateNodeIds' in self.overlay.context:
            selected['node_ids'] = [identity for identity in self.overlay.context['recallCandidateNodeIds'] if not identity.startswith('hy_support_')]
        return selected

    async def search(self, query_embedding, limit=10, score_threshold=0, layers=None, status_filter=None,
                     include_sources=None, exclude_sources=None, only_latest=False, created_after=None, **kwargs):
        filters = self.filters(layers,status_filter,include_sources)
        hits = await self.overlay.search(query_embedding,filters,limit,score_threshold)
        # sqlite-vec's active search deliberately withholds superseded rows.
        # Hy uses old wording as a bounded anchor and emits its current chain head.
        if 'superseded' in filters['status']:
            older = await self.overlay.select_all(dict(filters,status=['superseded']))
            legacy = await self.overlay.select_all(dict(filters,status=['shadow']))
            older.extend(row for row in legacy if row['payload'].get('custom',{}).get('hy_kind')=='fact'
                         and row['payload']['custom'].get('record',{}).get('status')=='superseded'
                         and row['payload']['custom']['record'].get('fact_link'))
            hits.extend((row,cosine(query_embedding,row['vector'])) for row in older)
        ranked = []
        for row,score in hits:
            node = self.memory_node(row)
            if score < score_threshold or node.source in (exclude_sources or []) or only_latest and not node.is_latest:
                continue
            if created_after is not None and node.gmt_created and node.gmt_created.timestamp() < created_after:
                continue
            ranked.append({'node_id':node.node_id, 'node':node, 'score':score})
        return sorted(ranked,key=lambda hit:(-hit['score'],hit['node_id']))[:limit]

    async def list_by_user(self, layers=None, status_filter=None, limit=100, offset=0, include_sources=None,
                           exclude_sources=None, only_latest=False, **kwargs):
        selected = await self.overlay.select_all(self.filters(layers,status_filter,include_sources))
        nodes = [self.memory_node(row) for row in selected]
        return [node for node in nodes if node.source not in (exclude_sources or []) and (not only_latest or node.is_latest)][offset:offset+limit]

    async def keyword_search(self, query, top_k=10, layers=None, status_filter=None, include_sources=None,
                             exclude_sources=None, only_latest=False, limit=None, **kwargs):
        selected = await self.overlay.select_all(self.filters(layers,status_filter,include_sources))
        if status_filter and 'superseded' in values(status_filter):
            legacy = await self.overlay.select_all(dict(self.filters(layers,status_filter,include_sources),status=['shadow']))
            selected.extend(row for row in legacy if row['payload'].get('custom',{}).get('hy_kind')=='fact'
                            and row['payload']['custom'].get('record',{}).get('status')=='superseded'
                            and row['payload']['custom']['record'].get('fact_link'))
        nodes = [self.memory_node(row) for row in selected]
        nodes = [node for node in nodes if node.source not in (exclude_sources or []) and (not only_latest or node.is_latest)]
        scores = compute_bm25_scores(tokenize(query),[node.content for node in nodes])
        ranked = sorted(zip(nodes,scores),key=lambda pair:(-pair[1],pair[0].node_id))
        return [{'node_id':node.node_id,'node':node,'score':score} for node,score in ranked if score > 0][:min(limit or top_k,MAX_BATCH)]

    async def get_embeddings(self, node_ids):
        result = {}
        for identity in node_ids:
            node = await self.get_by_id(identity)
            row = self.overlay.nodes.get(identity) if node else None
            if row:
                result[identity] = row['vector']
        return result


class ReaderGraphAdapter(GraphAdapter):
    async def find_referencing_memories(self,ids,limit=50,**kwargs):
        anchors = {}
        expected = {}
        candidates = self.overlay.context.get('recallCandidateNodeIds')
        for identity in ids:
            anchors[identity] = identity
            node = await self.vector.get_by_id(identity)
            if not node:
                continue
            for source_hash in {ref.get('sourceHash') for ref in node.custom.get('source_refs',[]) if ref.get('sourceHash')}:
                support_id = 'hy_support_' + digest([identity,source_hash])[:32]
                if candidates is None or support_id in candidates:
                    expected[support_id] = identity
        missing = [identity for identity in expected if identity not in self.overlay.nodes]
        for offset in range(0,len(missing),MAX_BATCH):
            result = await self.overlay.read('nodes/get',ids=missing[offset:offset+MAX_BATCH],
                           space_id=self.overlay.embed.space_id,include_vectors=True)
            self.overlay.remember(result.get('nodes',[]))
        for support_id,identity in expected.items():
            support = as_node(self.overlay.nodes.get(support_id))
            if support and support.custom.get('hy_support') and support.custom.get('support_entry_id') == identity:
                anchors[support_id] = identity
        result = []
        for edge in await self.overlay.relations(list(anchors)):
            if edge['relation_type'] != 'DERIVED_FROM' or edge['target_id'] not in anchors:
                continue
            node = await self.get_node(edge['source_id'])
            if not node or node.layer != MemoryLayer.L6_SCHEMA:
                continue
            result.append(dict(node_id=node.node_id,content=node.content,layer=node.layer.value,confidence=node.confidence,
                               custom_json=node.custom,memory_source=node.source,evidence_vdb_id=anchors[edge['target_id']]))
        return result[:limit]

    async def get_nodes_by_ids(self,node_ids):
        return await self.vector.get_by_ids(node_ids)

    async def get_related_edges(self,node_ids,include_sources=None,exclude_sources=None):
        result = []
        for edge in await self.overlay.relations(node_ids):
            source = await self.vector.get_by_id(edge['source_id'])
            target = await self.vector.get_by_id(edge['target_id'])
            if not source or not target:
                continue
            if include_sources and (source.source not in include_sources or target.source not in include_sources):
                continue
            if source.source in (exclude_sources or []) or target.source in (exclude_sources or []):
                continue
            properties = edge.get('properties') or {}
            relation = properties.get('relation_type') or edge['relation_type']
            result.append(dict(edge,relation_type=relation,weight=properties.get('weight',1.0),
                               source_status=source.status.value,target_status=target.status.value,
                               directed=relation.lower()=='temporal_next'))
        return result

    async def find_memories_by_entities(self,*args,**kwargs):
        # This integration has no entity-index owner; no entity rows are fabricated.
        return []


async def read_memory(query,limit,ctx,config,overlay,embed):
    eligible = ctx.get('recallEligibleNodeIds')
    if eligible == []:
        return [], {'name':'hybrid','channels':{},'config':{},'boundedEmpty':True}, None
    for key in ('recallEligibleNodeIds','recallCandidateNodeIds'):
        if key in ctx and (not isinstance(ctx[key],list) or len(ctx[key]) > 4096 or any(not isinstance(identity,str) or not identity for identity in ctx[key])):
            raise ValueError('hy_recall_ids_invalid')
    config.recall.local_rerank_enabled = False
    config.recall.episode_recall_enabled = False
    config.recall.access_tracking_enabled = False
    config.graph_store.graph_rerank_enabled = True
    vector = ReaderVectorAdapter(config,overlay)
    graph = ReaderGraphAdapter(overlay,vector)
    query_embed = QueryEmbedService(embed)
    reader = HybridReadPipeline(config,query_embed,vector,graph_store=graph,cache=None)
    await reader.initialize()
    response = await reader.read(ReadRequest(query=query,user_id=ctx['userId'],agent_id=ctx['agentId'],limit=limit,
                               schema_limit=limit,intention_limit=0,request_id=ctx['jobId'],min_score=0.3))
    if not response.success or response.error_code:
        raise ValueError('hy_reader_failed')
    if overlay.changed or overlay.deleted or overlay.record_changes or overlay.edge_changes:
        raise ValueError('hy_reader_mutation_refused')
    return response.memories, dict(name=response.extra.get('reader','hybrid'),channels=response.extra.get('channels',{}),
                                   config=response.extra.get('config',{})), getattr(query_embed,'last_embedding',None)
