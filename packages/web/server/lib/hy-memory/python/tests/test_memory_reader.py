import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import HyEngine
from adapters import cosine
from hy_memory.models.memory import MemoryNode, MemoryLayer, MemoryStatus


def row(identity, content, vector, *, layer=MemoryLayer.L2_FACT, status=MemoryStatus.ACTIVE, **kwargs):
    node = MemoryNode(node_id=identity, content=content, embedding=vector, layer=layer, status=status,
                      user_id='reader-user', agent_id='superwagie', session_id='reader-session', source='superwagie',
                      custom={'source_refs':[{'sessionId':'reader-session', 'messageId':'m', 'sourceHash':'a'*64, 'sourceRevision':1}]}, **kwargs)
    payload = node.to_dict(); payload['workspace_id'] = 'reader-project'
    return {'id':identity, 'content':content, 'vector':vector, 'payload':payload, 'active':status == MemoryStatus.ACTIVE}


class ReaderHost:
    def __init__(self, nodes, relations=()):
        self.nodes = {n['id']:copy.deepcopy(n) for n in nodes}
        self.relations = [dict(edge,id=edge.get('id',str(index))) for index,edge in enumerate(relations)]
        self.calls = []

    async def __call__(self, method, params):
        self.calls.append((method, copy.deepcopy(params)))
        if method == 'host.embed':
            return {'vectors':[[1.0,0.0] for _ in params['texts']], 'space_id':'reader-space', 'dimensions':2}
        if method == 'host.generate':
            raise AssertionError('Reader cannot generate or download a local model')
        if method != 'host.store':
            raise AssertionError(method)
        operation = params['operation']
        if operation == 'relations/list':
            requested = params.get('node_ids')
            edges = [e for e in self.relations if not requested or e['source_id'] in requested or e['target_id'] in requested]
            return {'relations':edges, 'total':len(edges)}
        if operation.startswith('records/'):
            return {'records':[], 'total':0}
        nodes = list(self.nodes.values())
        if operation == 'nodes/get':
            return {'nodes':[copy.deepcopy(self.nodes[i]) for i in params['ids'] if i in self.nodes]}
        for name, expected in params.get('filters',{}).items():
            if expected is None:
                continue
            if isinstance(expected,list):
                nodes = [n for n in nodes if (n['id'] if name == 'node_ids' else n['payload'].get(name)) in expected]
            else:
                nodes = [n for n in nodes if n['payload'].get(name) == expected]
        if operation == 'nodes/search':
            nodes = [dict(n,score=cosine(params['vector'],n['vector'])) for n in nodes if n['active']]
            nodes = sorted(nodes,key=lambda n:(-n['score'],n['id']))
        total = len(nodes); offset = params.get('offset',0)
        return {'nodes':copy.deepcopy(nodes[offset:offset+params.get('limit',100)]), 'total':total}


def request(**context):
    return {'query':'editable PPTX export', 'limit':4, 'context':dict(jobId='reader-job',namespace='reader-ns',userId='reader-user',
             agentId='superwagie',projectId='reader-project',sessionId='',spaceId='reader-space', **context)}


class MemoryReaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_hybrid_reader_runs_keyword_fusion_and_read_only_pipeline(self):
        host = ReaderHost([row('fact','editable PPTX export keeps native text',[1.0,0.0])])
        result = await HyEngine(host).recall(request())
        self.assertEqual(result['reader']['name'],'hybrid')
        self.assertGreater(result['reader']['channels']['vdb_keyword'],0)
        self.assertTrue(result['reader']['config']['mmr_applied'])
        self.assertEqual(result['nodes'][0]['id'],'fact')
        self.assertEqual(result['operations'],[])
        self.assertTrue(all(p['input_role']=='query' for m,p in host.calls if m=='host.embed'))

    async def test_actual_reader_reverse_evidence_finds_lexically_different_schema(self):
        fact = row('fact','editable PPTX export keeps native text',[1.0,0.0])
        schema = row('method','Preserve document semantics through native layout engines',[0.0,1.0],layer=MemoryLayer.L6_SCHEMA)
        host = ReaderHost([fact,schema],[dict(source_id='method',target_id='fact',relation_type='DERIVED_FROM')])
        result = await HyEngine(host).recall(request(recallEligibleNodeIds=['fact','method'],recallCandidateNodeIds=['fact','method']))
        self.assertIn('method',[node['id'] for node in result['nodes']])
        self.assertGreater(result['reader']['channels']['schema_reverse_l6'],0)

    async def test_old_wording_recalls_latest_revision_and_confirmation_gate_holds(self):
        old = row('old','editable PPTX export',[1.0,0.0],status=MemoryStatus.SUPERSEDED,is_latest=False,superseded_by=['latest'])
        latest = row('latest','Use the native text layout pipeline',[0.0,1.0],supersedes=['old'])
        candidate = row('candidate','editable PPTX export',[1.0,0.0])
        host = ReaderHost([old,latest,candidate])
        result = await HyEngine(host).recall(request(recallEligibleNodeIds=['latest'],recallCandidateNodeIds=['old','latest']))
        self.assertEqual([node['id'] for node in result['nodes']],['latest'])
        self.assertTrue(result['nodes'][0]['evolutionChain'])
        self.assertFalse(any(node['id']=='candidate' for node in result['nodes']))

    async def test_empty_eligible_set_does_not_retrieve_unconfirmed_content(self):
        host = ReaderHost([row('candidate','editable PPTX export',[1.0,0.0])])
        result = await HyEngine(host).recall(request(recallEligibleNodeIds=[],recallCandidateNodeIds=[]))
        self.assertEqual(result['nodes'],[])
        self.assertEqual(result['operations'],[])

    async def test_schema_channel_survives_a_large_normal_pool_and_final_limit(self):
        facts = [row('fact'+str(index),'editable PPTX export keeps native text '+str(index),[1.0,0.0]) for index in range(12)]
        method = row('method','Preserve structured document semantics',[0.0,1.0],layer=MemoryLayer.L6_SCHEMA)
        host = ReaderHost(facts+[method],[dict(source_id='method',target_id='fact0',relation_type='DERIVED_FROM')])
        allowed = [node['id'] for node in facts]+['method']
        result = await HyEngine(host).recall(request(recallEligibleNodeIds=allowed,recallCandidateNodeIds=allowed))
        self.assertLessEqual(len(result['nodes']),4)
        self.assertIn('method',[node['id'] for node in result['nodes']])
        self.assertGreater(result['reader']['channels']['schema_reverse_l6'],0)

