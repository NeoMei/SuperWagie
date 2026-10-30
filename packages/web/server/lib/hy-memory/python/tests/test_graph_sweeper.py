import copy
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import HyEngine
from test_engine import Host, context
from hy_memory.models.memory import MemoryNode, MemoryLayer, MemoryStatus


def entries():
    return [dict(id='entry'+str(i), projectId='p1', sessionId='s'+str(i), status='active', kind='experience',
                 body='same source material', sourceHash=str(i)*64, sourceMessageIds=['m'+str(i)], sourcePartIds=[]) for i in [1, 2]]


def schema(identity, index=0):
    data = MemoryNode(node_id=identity, content='Domain '+str(index), user_id='u1', agent_id='a1', session_id='s1',
                      source='superwagie', layer=MemoryLayer.L6_SCHEMA,
                      custom={'hy_kind':'schema', 'schema_type':'basic', 'source_refs':[
                          dict(sessionId='s'+str(i), messageId='m'+str(i), sourceHash=str(i)*64) for i in [1, 2]]}).to_dict()
    data['workspace_id'] = 'p1'
    vector = [0.0]*6; vector[index] = 1.0
    return dict(id=identity, content=data['content'], payload=data, vector=vector, active=True)


class GraphHost(Host):
    async def __call__(self, method, params):
        if method == 'host.generate':
            self.calls.append((method, params))
            if 'behavioral psychologist' in params['prompt']:
                return {'content':json.dumps({'abstraction_for_embedding':'Checks evidence before choosing a course of action.'})}
            if 'deep pattern analyst' in params['prompt']:
                return {'content':json.dumps({'core_pattern':'The user checks independent evidence before committing to consequential actions.', 'reasoning':'The source patterns share an evidence seeking behavior.', 'confidence':0.8})}
            return {'content':'[]'}
        if method == 'host.embed':
            self.calls.append((method, params))
            return {'vectors':[[1.0]+[0.0]*5 for _ in params['texts']], 'space_id':'test-v1', 'dimensions':6}
        if method == 'host.store' and params['operation']=='nodes/list':
            self.calls.append((method, params))
            rows=[]
            for row in self.nodes.values():
                if all((row['id'] if key=='node_ids' else row['payload'].get(key)) in value if isinstance(value,list) else row['payload'].get(key)==value for key,value in params.get('filters',{}).items() if value is not None):
                    rows.append(copy.deepcopy(row))
            return {'nodes':rows[params.get('offset',0):params.get('offset',0)+params['limit']], 'total':len(rows)}
        return await super().__call__(method,params)

    def commit(self, result):
        for op in result['operations']:
            if op['operation']=='nodes/upsert':
                self.nodes.update({row['id']:copy.deepcopy(row) for row in op['nodes']})


class GraphSweeperTests(unittest.IsolatedAsyncioTestCase):
    async def test_consolidation_executes_real_sweeper_and_stages_distinct_behavior_vectors(self):
        host=GraphHost(); host.nodes={f'basic{i}':schema(f'basic{i}',i) for i in range(5)}
        original_vectors={identity:copy.deepcopy(row['vector']) for identity,row in host.nodes.items()}
        result=await HyEngine(host).consolidate({'entries':entries(),'context':context()})
        self.assertEqual(result['review']['crossDomain']['cores_created'],1)
        upserts={row['id']:row for op in result['operations'] if op['operation']=='nodes/upsert' for row in op['nodes']}
        behaviors=[row for row in upserts.values() if row['payload']['custom'].get('representation_role')=='behavior']
        self.assertEqual(len(behaviors),5)
        self.assertTrue(all(row['payload']['status']=='shadow' and not row['active'] and row['content'] for row in behaviors))
        self.assertTrue(all(row['payload']['custom']['source_refs'] for row in behaviors))
        self.assertTrue(all(upserts[identity]['vector']==vector for identity,vector in original_vectors.items()))
        cores=[row for row in upserts.values() if row['payload']['custom'].get('schema_type')=='abstract']
        self.assertEqual(len(cores),1)
        self.assertEqual(cores[0]['payload']['custom'].get('schema_kind'),'behavior_pattern')
        self.assertEqual({r['sessionId'] for r in cores[0]['payload']['custom']['source_refs']},{'s1','s2'})
        self.assertTrue(any(card['id']==cores[0]['id'] for card in result['deferredCards']))
        relations=[op['value'] for op in result['operations'] if op['operation']=='relations/upsert']
        self.assertEqual(sum(row['relation_type']=='SCHEMA_BEHAVIOR' for row in relations),5)
        self.assertEqual(sum(row['relation_type']=='CROSS_ABSTRACTS_TO' for row in relations),5)
        self.assertFalse(any(card['id'] in {row['id'] for row in behaviors} for card in result['cards']))
        host.commit(result)
        recalled=await HyEngine(host).recall({'query':'evidence','context':context()})
        self.assertFalse(any(row['payload']['custom'].get('representation_role')=='behavior' for row in recalled['nodes']))

    async def test_sweeper_malformed_model_result_discards_request(self):
        class Malformed(GraphHost):
            async def __call__(self,method,params):
                if method=='host.generate' and 'behavioral psychologist' in params['prompt']:
                    return {'content':'{"abstraction_for_embedding":'}
                return await super().__call__(method,params)
        host=Malformed(); host.nodes={'basic':schema('basic')}
        with self.assertRaises(ValueError):
            await HyEngine(host).consolidate({'entries':entries(),'context':context()})
        self.assertNotIn('_has_beh',host.nodes['basic']['payload']['custom'])

    async def test_invalid_candidate_embedding_cannot_fall_back_to_partial_success(self):
        from test_engine import segment
        class InvalidEmbedding(Host):
            async def __call__(self,method,params):
                if method=='host.embed' and params.get('input_role')=='query':
                    return {'vectors':[[1.0]],'space_id':'test-v1','dimensions':2}
                return await super().__call__(method,params)
        host=InvalidEmbedding(['{"experiences":[{"task":"Export","solution":"Use WPS"}],"facts":[]}',
                               '{"ops":[{"action":"ADD","draft_idx":0}]}'])
        with self.assertRaisesRegex(ValueError,'hy_embedding_invalid'):
            await HyEngine(host).organize({'segment':segment(),'context':context()})

    async def test_truncated_model_output_cannot_be_empty_success(self):
        from test_engine import segment
        class Truncated(Host):
            async def __call__(self,method,params):
                if method=='host.generate':
                    return {'content':'{"experiences":[],"facts":[]}', 'finish_reason':'length'}
                return await super().__call__(method,params)
        with self.assertRaisesRegex(ValueError,'hy_model_output_truncated'):
            await HyEngine(Truncated()).organize({'segment':segment(),'context':context()})

    async def test_swallowed_graph_validation_error_cannot_commit(self):
        host=GraphHost(); host.nodes={'basic':schema('basic')}
        async def operation(ctx,config,overlay,vector,coding,graph,embed):
            try:
                await graph.add_derived_from('basic','missing')
            except ValueError:
                pass
            await graph.update_node('basic',{'content':'would be partial'})
            return {}
        with self.assertRaisesRegex(ValueError,'hy_unknown_evidence'):
            await HyEngine(host).run({'context':context()},operation)

    async def test_graph_backend_fields_preserve_revision_and_custom_updates(self):
        host=GraphHost(); host.nodes={'basic':schema('basic')}
        async def operation(ctx,config,overlay,vector,coding,graph,embed):
            await graph.update_node('basic',{'custom_json':json.dumps({'hy_kind':'schema','review_reason':'scope checked'}),
                                            'superseded_by_id':'next', 'status':'superseded'})
            return {}
        result=await HyEngine(host).run({'context':context()},operation)
        node=result['operations'][0]['nodes'][0]
        self.assertEqual(node['payload']['custom']['review_reason'],'scope checked')
        self.assertEqual(node['payload']['superseded_by'],['next'])
        self.assertEqual(node['payload']['status'],'superseded')

    async def test_keyword_candidates_are_scoped_before_bm25_ranking(self):
        host=GraphHost()
        for identity,project,session,content in [('local','p1','s1','Editable PPTX export'),
                ('other-session','p1','s2','Editable PPTX export export'),('other-project','p2','s1','Editable PPTX export export')]:
            row=schema(identity); row['content']=row['payload']['content']=content
            row['payload'].update(workspace_id=project,session_id=session,layer='l2_fact')
            host.nodes[identity]=row
        async def operation(ctx,config,overlay,vector,coding,graph,embed):
            hits=await vector.keyword_search('editable PPTX',top_k=1,layers=[MemoryLayer.L2_FACT])
            return {'ids':[hit['node_id'] for hit in hits]}
        result=await HyEngine(host).run({'context':context()},operation)
        self.assertEqual(result['ids'],['local'])
        reads=[p for method,p in host.calls if method=='host.store' and p['operation']=='nodes/list']
        self.assertEqual(reads[0]['filters']['session_id'],'s1')
        self.assertEqual(reads[0]['filters']['workspace_id'],'p1')

    async def test_graph_listing_pages_without_silent_truncation(self):
        host=GraphHost(); host.nodes={f'basic{i}':schema(f'basic{i}',i%5) for i in range(105)}
        async def operation(ctx,config,overlay,vector,coding,graph,embed):
            nodes=await graph.get_all_nodes(limit=500)
            return {'count':len(nodes)}
        result=await HyEngine(host).run({'context':context()},operation)
        self.assertEqual(result['count'],105)

    async def test_forget_closes_schema_revision_chain(self):
        class Revisions(GraphHost):
            async def __call__(self,method,params):
                if method=='host.store' and params['operation']=='relations/list':
                    row=dict(id='revision',source_id='old',target_id='next',relation_type='RELATED_TO',
                             properties={'relation_type':'schema_revision'})
                    rows=[row] if any(identity in params['node_ids'] for identity in ['old','next']) else []
                    return {'relations':rows,'total':len(rows)}
                return await super().__call__(method,params)
        host=Revisions(); host.nodes={identity:schema(identity) for identity in ['old','next']}
        result=await HyEngine(host).forget({'ids':['old'],'context':context()})
        self.assertEqual(result['deletedIds'],['next','old'])

    async def test_forget_closes_behavior_roles_and_abstract_dependencies(self):
        class Relations(GraphHost):
            async def __call__(self,method,params):
                if method=='host.store' and params['operation']=='relations/list':
                    rows=[dict(id='behavior-edge',source_id='basic',target_id='behavior',relation_type='SCHEMA_BEHAVIOR'),
                          dict(id='cross-edge',source_id='basic',target_id='core',relation_type='CROSS_ABSTRACTS_TO')]
                    rows=[r for r in rows if r['source_id'] in params['node_ids'] or r['target_id'] in params['node_ids']]
                    return {'relations':rows,'total':len(rows)}
                return await super().__call__(method,params)
        host=Relations(); host.nodes={identity:schema(identity) for identity in ['basic','behavior','core']}
        result=await HyEngine(host).forget({'ids':['basic'],'context':context()})
        self.assertEqual(result['deletedIds'],['basic','behavior','core'])

if __name__=='__main__':
    unittest.main()

class RecallChannelTests(unittest.IsolatedAsyncioTestCase):
    async def test_behavior_channel_recalls_owner_without_replacing_content_hits(self):
        host=GraphHost()
        owner=schema('behavior-owner'); owner['vector']=[0.0,1.0,0.0,0.0,0.0,0.0]
        owner['payload']['custom'].update(_has_beh=True,behavior_node_id='behavior-role')
        content=schema('content-owner'); content['vector']=[0.8,0.6,0.0,0.0,0.0,0.0]
        behavior=schema('behavior-role'); behavior['vector']=[1.0,0.0,0.0,0.0,0.0,0.0]
        behavior['active']=False; behavior['payload']['status']='shadow'
        behavior['payload']['custom'].update(hy_kind='schema_behavior',representation_role='behavior',owner_node_id='behavior-owner')
        host.nodes={row['id']:row for row in [owner,content,behavior]}
        base=host.__call__
        async def scoped(method,params):
            if method=='host.store' and params['operation']=='nodes/search':
                return {'nodes':[dict(content,score=0.8)]}
            return await base(method,params)
        result=await HyEngine(scoped).recall({'query':'evidence','limit':5,'context':context()})
        self.assertEqual([node['id'] for node in result['nodes']],['behavior-owner','content-owner'])
        self.assertNotIn('behavior-role',[node['id'] for node in result['nodes']])
        self.assertEqual(result['nodes'][0]['matchedBy'],['behavior'])

    async def test_patch_owner_links_exclude_unrelated_staged_nodes(self):
        from test_engine import segment
        host=Host(); engine=HyEngine(host); source=segment()
        source['messages'][1]['text']='diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+new\n'
        async def operation(ctx,config,overlay,vector,coding,graph,embed):
            ctx['attachSourceRefs']=False
            for identity,message_id,part_id in [('patch-owner','m2','t1'),('unrelated','m1',None)]:
                ref=dict(sessionId='s1',messageId=message_id,sourceHash=source['sourceHash'])
                if part_id: ref['partId']=part_id
                await vector.upsert(MemoryNode(node_id=identity,content=identity,user_id='u1',agent_id='a1',
                    embedding=[1.0,0.0],layer=MemoryLayer.L2_FACT,custom={'source_refs':[ref]}))
            engine.code_history(source,ctx,overlay)
            return {}
        result=await engine.run({'context':context()},operation,source)
        record=next(op['value'] for op in result['operations'] if op.get('collection')=='code_history')
        self.assertEqual(record['node_ids'],['patch-owner'])

    async def test_write_and_recall_keep_exact_code_patch_owners(self):
        from test_engine import segment
        class HistoryHost(Host):
            def __init__(self):
                super().__init__(['{"experiences":[],"facts":[{"statement":"Update export.py function","subject":"export.py","files":["export.py"]}]}'])
                self.records=[]
            async def __call__(self,method,params):
                if method=='host.store' and params['operation']=='records/list':
                    rows=[row for row in self.records if row['collection'] in params['collections'] and any(identity in row['value'].get('node_ids',[]) for identity in params['node_ids'])]
                    return {'records':rows,'total':len(rows)}
                return await super().__call__(method,params)
        host=HistoryHost(); source=segment()
        source['messages'][1]['text']='diff --git a/export.py b/export.py\n--- a/export.py\n+++ b/export.py\n@@ -1 +1 @@ def export():\n-return "image"\n+return "editable"\n'
        first=await HyEngine(host).organize({'segment':source,'context':context()})
        for op in first['operations']:
            if op['operation']=='nodes/upsert':
                host.nodes.update({row['id']:copy.deepcopy(row) for row in op['nodes']})
            if op['operation']=='records/upsert':
                host.records.append({'collection':op['collection'],'id':op['id'],'value':op['value']})
        history=next(row for row in host.records if row['collection']=='code_history')
        self.assertEqual(history['value']['node_ids'],[first['facts'][0]['fact_id']])
        self.assertEqual(history['value']['message_id'],'m2')
        self.assertEqual(history['value']['part_id'],'t1')
        result=await HyEngine(host).recall({'query':'export.py','context':context()})
        self.assertEqual(len(result['history']['records']),1)
        self.assertIn('editable',result['history']['text'])

class TraceSourceTests(unittest.IsolatedAsyncioTestCase):
    async def test_trace_append_preserves_all_source_refs_and_owners(self):
        from test_engine import segment
        class TraceHost(Host):
            def __init__(self):
                super().__init__(['{"experiences":[],"facts":[{"statement":"First export","subject":"first"}]}'])
                self.records={}
            async def __call__(self,method,params):
                if method=='host.store' and params['operation']=='records/get':
                    return {'records':[{'id':identity,'value':self.records[(params['collection'],identity)]}
                        for identity in params['ids'] if (params['collection'],identity) in self.records]}
                return await super().__call__(method,params)
            def commit(self,result):
                for op in result['operations']:
                    if op['operation']=='nodes/upsert':
                        self.nodes.update({row['id']:copy.deepcopy(row) for row in op['nodes']})
                    if op['operation']=='records/upsert':
                        self.records[(op['collection'],op['id'])]=copy.deepcopy(op['value'])
        host=TraceHost(); first=await HyEngine(host).organize({'segment':segment(),'context':context()}); host.commit(first)
        old_owner=first['facts'][0]['fact_id']
        source=segment(); source['id']='seg2'; source['sourceHash']='b'*64; source['messageIds']=['m3','m4']
        source['messages'][0]['id']='m3'; source['messages'][1]['id']='m4'
        host.responses=['{"experiences":[],"facts":[{"statement":"Second export","subject":"second"}]}', '{"ops":[{"draft_idx":0,"supersedes":[]}]}']
        second=await HyEngine(host).organize({'segment':source,'context':context()})
        trace=next(op['value'] for op in second['operations'] if op.get('collection')=='trace')
        self.assertEqual({ref['sourceHash'] for ref in trace['source_refs']},{'a'*64,'b'*64})
        self.assertEqual({ref['messageId'] for ref in trace['source_refs']},{'m1','m2','m3','m4'})
        self.assertIn(old_owner,trace['node_ids'])
        self.assertIn(second['facts'][0]['fact_id'],trace['node_ids'])
        self.assertEqual(len(trace['messages']),4)
        new_id=second['facts'][0]['fact_id']
        new_node=next(row for op in second['operations'] if op['operation']=='nodes/upsert' for row in op['nodes'] if row['id']==new_id)
        self.assertEqual({ref['sourceHash'] for ref in new_node['payload']['custom']['source_refs']},{'a'*64,'b'*64})

class RepresentationTextTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_coding_nodes_retain_the_text_used_for_each_vector(self):
        from test_engine import segment
        host=Host(['{"experiences":[{"task":"Rebuild importer","solution":"Use staging","search_keys":["transaction"]}],"facts":[{"subject":"Importer","statement":"Staging preserved records"}]}',
                   '{"ops":[{"action":"ADD","draft_idx":0}]}'])
        result=await HyEngine(host).organize({'segment':segment(),'context':context()})
        nodes=[row for op in result['operations'] if op['operation']=='nodes/upsert' for row in op['nodes']]
        by_kind={row['payload']['custom'].get('hy_kind'):row for row in nodes}
        self.assertEqual(by_kind['experience']['payload']['custom'].get('embedding_text'),'Rebuild importer')
        self.assertEqual(by_kind['fact']['payload']['custom'].get('embedding_text'),'Importer: Staging preserved records')
        self.assertEqual(by_kind['experience_key']['payload']['custom'].get('embedding_text'),'transaction')
