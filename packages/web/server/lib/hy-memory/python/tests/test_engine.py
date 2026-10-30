import asyncio
import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import HyEngine


class Host:
    def __init__(self, responses=()):
        self.responses = list(responses)
        self.calls = []
        self.nodes = {}
    async def __call__(self, method, params):
        self.calls.append((method, params))
        if method == 'host.generate':
            return {'content': self.responses.pop(0)}
        if method == 'host.embed':
            return {'vectors': [[1.0, 0.0] for _ in params['texts']], 'space_id': 'test-v1', 'dimensions': 2}
        if method == 'host.store':
            op = params['operation']
            if op == 'nodes/get':
                return {'nodes': [self.nodes[x] for x in params['ids'] if x in self.nodes]}
            if op == 'nodes/search':
                return {'nodes': [dict(n, score=1.0) for n in self.nodes.values()]}
            return {'nodes': [], 'records': [], 'relations': [], 'total': 0}
        raise AssertionError(method)


def context():
    return dict(jobId='job1', namespace='ns1', userId='u1', agentId='a1', projectId='p1', sessionId='s1', sourceRevision=3)


def segment():
    return dict(id='seg1', sessionId='s1', projectId='p1', directory='/p1', title='PPT lesson', createdAt=1_000,
                sourceHash='a' * 64, messageIds=['m1', 'm2'], outcome='succeeded', messages=[
                    dict(id='m1', role='user', text='Use the WPS export to keep editable PPT text.'),
                    dict(id='m2', partId='t1', role='tool', tool='bash', status='completed', text='2 tests passed')])


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_working_extraction_reconcile_fact_crosslink(self):
        host = Host(['{"experiences":[{"task":"Editable PPT export","search_keys":["WPS"],"solution":"Export through WPS","boundary_envs":"PPTX","confidence":0.9}],"facts":[{"statement":"WPS export preserved editable text","subject":"PPT export","details":"2 tests passed"}]}', '{"ops":[{"action":"ADD","draft_idx":0}]}'])
        result = await HyEngine(host).organize({'segment': segment(), 'context': context()})
        self.assertTrue(result['facts'])
        self.assertTrue(result['experiences'])
        self.assertEqual(result['experiences'][0]['source_fact_ids'], [result['facts'][0]['fact_id']])
        self.assertEqual(result['facts'][0]['derived_experience_ids'], [result['experiences'][0]['experience_id']])
        self.assertTrue(result['operations'])
        self.assertTrue(all(c['verification'] == 'unverified' for c in result['cards']))
        self.assertFalse(any(p['operation'].endswith(('upsert', 'delete')) for m, p in host.calls if m == 'host.store'))

    async def test_scope_mismatch_fails_before_model(self):
        host = Host()
        bad = segment(); bad['projectId'] = 'other'
        with self.assertRaises(ValueError):
            await HyEngine(host).organize({'segment': bad, 'context': context()})
        self.assertEqual(host.calls, [])

    async def test_embedding_failure_discards_all_staged_changes(self):
        host = Host(['{"experiences":[{"task":"Export","solution":"WPS"}],"facts":[]}', '{"ops":[{"action":"ADD","draft_idx":0}]}'])
        async def broken(method, params):
            if method == 'host.embed':
                raise RuntimeError('embedding unavailable')
            return await host(method, params)
        with self.assertRaises(RuntimeError):
            await HyEngine(broken).organize({'segment': segment(), 'context': context()})

if __name__ == '__main__':
    unittest.main()

class ChatTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_chat_extraction_stages_source_bound_facts(self):
        host = Host(['{"memory":[{"content":"The user prefers editable PPTX exports","tags":["PPTX"],"owner":"user"}],"basic_info":{}}'])
        source = segment(); source['messages'] = [source['messages'][0]]; source['messageIds'] = ['m1']
        result = await HyEngine(host).organize({'segment': source, 'context': context()})
        self.assertEqual(result['scene'], 'chat')
        self.assertTrue(result['facts'])
        self.assertEqual(result['cards'][0]['sourceMessageIds'], ['m1'])

class S2Tests(unittest.IsolatedAsyncioTestCase):
    async def test_source_backed_candidate_experience_is_eligible_without_activation(self):
        host = Host()
        entries = [dict(id='e'+str(i), projectId='p1', sessionId='s'+str(i), status='candidate' if i == 2 else 'active',
                        kind='experience' if i == 2 else 'segment', body='source-backed reference', sourceHash=str(i)*64,
                        sourceMessageIds=['m'+str(i)], sourcePartIds=[],
                        sourceRefs=[dict(sessionId='s'+str(i), messageId='m'+str(i), sourceHash=str(i)*64, sourceRevision=3)]) for i in [1, 2]]
        result = await HyEngine(host).consolidate({'entries': entries, 'context': context()})
        self.assertTrue(result['operations'])
        self.assertEqual(entries[1]['status'], 'candidate')
        self.assertFalse(any(method == 'host.generate' for method, _ in host.calls))

    async def test_candidate_support_rejects_unknown_message_before_host_calls(self):
        host = Host()
        entries = [dict(id='e'+str(i), projectId='p1', sessionId='s'+str(i), status='candidate', kind='experience',
                        body='source-backed reference', sourceHash=str(i)*64, sourceMessageIds=['m'+str(i)], sourcePartIds=[],
                        sourceRefs=[dict(sessionId='s'+str(i), messageId='unknown', sourceHash=str(i)*64, sourceRevision=3)]) for i in [1, 2]]
        with self.assertRaisesRegex(ValueError, 'hy_consolidation_sources_invalid'):
            await HyEngine(host).consolidate({'entries': entries, 'context': context()})
        self.assertEqual(host.calls, [])

    async def test_actual_s2_cluster_schema_tool_and_review(self):
        class S2Host(Host):
            async def __call__(self, method, params):
                if method == 'host.embed':
                    self.calls.append((method, params))
                    return {'vectors': [[1.0, 0.0] if 'lesson A' in t else [0.7, 0.7] for t in params['texts']], 'space_id': 'test-v1', 'dimensions': 2}
                if method == 'host.generate':
                    self.calls.append((method, params))
                    import json, re
                    if 'behavioral psychologist' in params['prompt']:
                        return {'content':json.dumps({'abstraction_for_embedding':'Requires independent evidence before reuse.'})}
                    # Real material prompts carry the pinned source IDs.
                    ids = re.findall(r'\(id=([a-zA-Z0-9_]+)', params['prompt'])
                    ids = list(dict.fromkeys(ids))
                    return {'content': json.dumps([{'op':'create_schema','content':'Use WPS exports after confirming editable text and inspect failures.','evidence_list': ids[:2], 'schema_kind':'engineering_methodology', 'tags':['PPTX']}])}
                return await super().__call__(method, params)
        host = S2Host()
        entries = [dict(id='e'+str(i), projectId='p1', sessionId='s'+str(i), status='active', kind='experience',
                        body='lesson A' if i == 1 else 'lesson B', sourceHash=str(i)*64, sourceMessageIds=['m'+str(i)], sourcePartIds=[]) for i in [1,2]]
        result = await HyEngine(host).consolidate({'entries': entries, 'context': context()})
        self.assertTrue(result['schemas'])
        self.assertTrue(result['relations'])
        self.assertTrue(result['review']['reviewed'])
        self.assertEqual(result['cards'][0]['verification'], 'unverified')
        self.assertEqual(result['cards'][0]['kind'], 'methodology')
        from test_memory_reader import ReaderHost, row
        persisted = [copy.deepcopy(node) for op in result['operations'] if op['operation']=='nodes/upsert' for node in op['nodes']]
        method_id = result['cards'][0]['id']
        for node in persisted:
            if node['id']==method_id:
                node['vector']=[0.0,1.0]
        for entry in entries:
            node = row(entry['id'],entry['body'],[1.0,0.0])
            node['payload'].update(user_id='u1',agent_id='a1',workspace_id='p1')
            node['payload']['custom']['source_refs']=[dict(sessionId=entry['sessionId'],messageId=entry['sourceMessageIds'][0],sourceHash=entry['sourceHash'])]
            persisted.append(node)
        reader_host = ReaderHost(persisted,[op['value'] for op in result['operations'] if op['operation']=='relations/upsert'])
        ctx = dict(context(),recallEligibleNodeIds=['e1',method_id],recallCandidateNodeIds=[node['id'] for node in persisted])
        recalled = await HyEngine(reader_host).recall({'query':'lesson A','context':ctx})
        self.assertEqual(recalled['reader']['name'],'hybrid')
        self.assertGreater(recalled['reader']['channels']['schema_reverse_l6'],0)
        self.assertIn(method_id,[node['id'] for node in recalled['nodes']])

class SourceFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_unknown_generated_citation_is_rejected(self):
        host = Host(['{"experiences":[{"task":"PPTX","solution":"WPS","sourceMessageIds":["unknown-message"]}],"facts":[]}'])
        with self.assertRaisesRegex(ValueError, 'hy_unknown_source_citation'):
            await HyEngine(host).organize({'segment':segment(), 'context':context()})

    async def test_malformed_model_json_cannot_be_empty_success(self):
        host = Host(['{"experiences":['])
        with self.assertRaises(ValueError):
            await HyEngine(host).organize({'segment':segment(), 'context':context()})

class ForgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_forget_repairs_sibling_and_deletes_derived_schema_and_patch(self):
        import copy
        host = Host(['{"experiences":[{"task":"Editable PPT","solution":"Use WPS"}],"facts":[{"statement":"PPT exported","subject":"PPT"}]}', '{"ops":[{"action":"ADD","draft_idx":0}]}'])
        first = await HyEngine(host).organize({'segment':segment(), 'context':context()})
        for operation in first['operations']:
            if operation['operation'] == 'nodes/upsert':
                host.nodes.update({n['id']:copy.deepcopy(n) for n in operation['nodes']})
        experience_id = first['experiences'][0]['experience_id']; fact_id = first['facts'][0]['fact_id']
        schema = copy.deepcopy(host.nodes[fact_id]); schema['id'] = 'schema'; schema['payload']['node_id'] = 'schema'; schema['payload']['layer'] = 'l6_schema'; schema['payload']['custom'] = {'hy_kind':'schema'}
        host.nodes['schema'] = schema
        base = host.__call__
        async def scoped(method, params):
            if method == 'host.store' and params['operation'] == 'relations/list':
                ids = params['node_ids']
                return {'relations': [{'id':'r1','source_id':'schema','target_id':experience_id,'relation_type':'DERIVED_FROM'}] if experience_id in ids or 'schema' in ids else [], 'total':1}
            if method == 'host.store' and params['operation'] == 'records/list':
                return {'records':[{'collection':'code_history','id':'patch1','value':{}}], 'total':1}
            return await base(method, params)
        result = await HyEngine(scoped).forget({'ids':[experience_id], 'context':context()})
        self.assertIn('schema', result['deletedIds'])
        self.assertNotIn(fact_id, result['deletedIds'])
        updates = [n for op in result['operations'] if op['operation'] == 'nodes/upsert' for n in op['nodes']]
        self.assertEqual(updates[0]['payload']['custom']['record']['derived_experience_ids'], [])
        self.assertTrue(any(op['operation'] == 'records/delete' and op['id'] == 'patch1' for op in result['operations']))

    async def test_project_scope_precedes_candidate_topk_and_history(self):
        host = Host()
        result = await HyEngine(host).recall({'query':'PPT','context':context()})
        self.assertEqual(result['nodes'], [])
        reads = [p for method,p in host.calls if method == 'host.store']
        self.assertEqual(reads[0]['filters']['workspace_id'], 'p1')
        self.assertEqual(reads[0]['filters']['user_id'], 'u1')

class CodeHistoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_original_diff_survives_fact_summary_and_hy_renderer(self):
        from code_history import decorate_history
        host = Host(['{"experiences":[],"facts":[{"statement":"Update export function","subject":"export.py"}]}'])
        source = segment()
        source['messages'][1]['text'] = 'diff --git a/export.py b/export.py\n--- a/export.py\n+++ b/export.py\n@@ -1,2 +1,2 @@ def export():\n-return "image"\n+return "editable"\n'
        result = await HyEngine(host).organize({'segment':source,'context':context()})
        records = [op['value'] for op in result['operations'] if op['operation'] == 'records/upsert' and op['collection'] == 'code_history']
        self.assertEqual(len(records), 1)
        self.assertIn('+return "editable"', records[0]['patch'])
        rendered = decorate_history(records, 'export.py', [{'statement':'Update export function','files':['export.py']}], context())
        self.assertIn('editable', str(rendered['text']))
        self.assertEqual(records[0]['session_id'], 's1')

class ContinuationTests(unittest.IsolatedAsyncioTestCase):
    async def test_s2_bounds_paid_batch_and_resumes_review_checkpoint(self):
        import copy
        class BatchHost(Host):
            async def __call__(self, method, params):
                if method == 'host.embed':
                    vectors = []
                    for text in params['texts']:
                        i = int(text.split()[-1])
                        vector = [0.8] + [0.0] * 48
                        vector[i + 1] = 0.6
                        vectors.append(vector)
                    return {'vectors':vectors,'space_id':'batch','dimensions':49}
                if method == 'host.generate':
                    self.calls.append((method, params))
                    return {'content':'[]'}
                if method == 'host.store' and params['operation'] == 'nodes/list':
                    rows = list(self.nodes.values())
                    return {'nodes':rows,'total':len(rows)}
                return await super().__call__(method, params)
        host = BatchHost()
        entries = [dict(id=f'e{i}', projectId='p1', sessionId=f's{i}', status='active', body=f'lesson {i}',
                        sourceHash=str(i), sourceMessageIds=[f'm{i}']) for i in range(48)]
        first = await HyEngine(host).consolidate({'entries':entries,'context':context()})
        self.assertEqual(first['review']['reviewed'], 24)
        self.assertEqual(first['continuation']['reason'], 'unreviewed_clusters')
        for op in first['operations']:
            if op['operation'] == 'nodes/upsert':
                host.nodes.update({row['id']:copy.deepcopy(row) for row in op['nodes']})
        second = await HyEngine(host).consolidate({'entries':entries,'context':context()})
        self.assertEqual(second['review']['reviewed'], 24)
        self.assertIsNone(second['continuation'])
        self.assertEqual(sum(method == 'host.generate' for method,p in host.calls), 2)

class FactReplacementTests(unittest.IsolatedAsyncioTestCase):
    async def test_fact_replacement_keeps_previous_until_successor_embeds(self):
        import copy
        host = Host(['{"experiences":[],"facts":[{"statement":"Export fails","subject":"PPT"}]}'])
        first = await HyEngine(host).organize({'segment':segment(), 'context':context()})
        old = first['facts'][0]['fact_id']
        for op in first['operations']:
            if op['operation'] == 'nodes/upsert':
                host.nodes.update({n['id']:copy.deepcopy(n) for n in op['nodes']})
        host.responses = ['{"experiences":[],"facts":[{"statement":"Export repaired","subject":"PPT"}]}', '{"ops":[{"draft_idx":0,"supersedes":["'+old+'"]}]}', 'Repaired export after the first failure.']
        second = await HyEngine(host).organize({'segment':segment(), 'context':context()})
        new = next(f for f in second['facts'] if f['fact_id'] != old)
        retired = next(f for f in second['facts'] if f['fact_id'] == old)
        self.assertEqual(retired['status'], 'superseded')
        self.assertEqual(retired['fact_link'], new['fact_id'])
        self.assertTrue(any(op['operation'] == 'relations/upsert' and op['value']['relation_type'] == 'FACT_SUPERSEDES' for op in second['operations']))
        host.responses = ['{"experiences":[],"facts":[{"statement":"Export repaired","subject":"PPT"}]}', '{"ops":[{"draft_idx":0,"supersedes":["'+old+'"]}]}', 'Repaired export.']
        async def failure(method, params):
            if method == 'host.embed' and any('Export repaired' in t for t in params['texts']):
                raise RuntimeError('vector unavailable')
            return await host(method, params)
        with self.assertRaisesRegex(RuntimeError, 'vector unavailable'):
            await HyEngine(failure).organize({'segment':segment(), 'context':context()})
        self.assertEqual(host.nodes[old]['payload']['custom']['record']['status'], 'active')

    async def test_history_lookup_uses_project_and_real_session(self):
        host = Host(['{"experiences":[],"facts":[]}','{"experiences":[],"facts":[]}'])
        await HyEngine(host).organize({'segment':segment(), 'context':context()})
        other = segment(); other['projectId']='p2'
        ctx = context(); ctx['projectId']='p2'
        await HyEngine(host).organize({'segment':other, 'context':ctx})
        traces = [p for method,p in host.calls if method == 'host.store' and p['operation']=='records/get']
        self.assertNotEqual(traces[0]['ids'], traces[1]['ids'])

class PatchInputTests(unittest.IsolatedAsyncioTestCase):
    async def test_bounded_authoritative_patch_input_preserves_part(self):
        host = Host(['{"experiences":[],"facts":[{"statement":"Export changed","subject":"PPT"}]}'])
        patch = 'diff --git a/export.py b/export.py\n--- a/export.py\n+++ b/export.py\n@@ -1 +1 @@ def export():\n-return "image"\n+return "editable"\n'
        source = segment(); source['patches'] = [dict(messageId='m2', partId='t1', patch=patch)]
        result = await HyEngine(host).organize({'segment':source, 'context':context()})
        history = [op['value'] for op in result['operations'] if op['operation']=='records/upsert' and op['collection']=='code_history']
        self.assertEqual(history[0]['part_id'], 't1')
        self.assertIn('editable', history[0]['patch'])

    async def test_unrecognized_patch_part_cannot_commit(self):
        host = Host(['{"experiences":[],"facts":[]}'])
        with self.assertRaisesRegex(ValueError, 'hy_patch_sources_invalid'):
            await HyEngine(host).organize({'segment':segment(), 'context':context(), 'patches':[dict(messageId='m2',partId='wrong',patch='diff --git a/a b/a')]})
