import copy
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import HyEngine
from adapters import as_node, record_object
from hy_memory.agent.llm_provider import LLMProvider
from hy_memory.coding.extractor import CodingMemoryExtractor
from hy_memory.coding.fact_reconciler import WorkingFactReconciler
from hy_memory.coding.reconciler import CodingMemoryReconciler
from hy_memory.coding.types import WorkingFact
from hy_memory.coding.writer import CodingWriter
from hy_memory.pipelines.base import ChatMessage
from query_embedding import QueryEmbedService
from test_engine import Host, context, segment


class TimestampTests(unittest.IsolatedAsyncioTestCase):
    async def test_early_epoch_organize_roundtrips_in_chat_and_working(self):
        for working in (False, True):
            with self.subTest(working=working):
                source = segment()
                source['createdAt'] = 100
                if working:
                    responses = ['{"experiences":[{"task":"Export","solution":"Use WPS"}],"facts":[{"subject":"PPT","statement":"Export completed"}]}',
                                 '{"ops":[{"action":"ADD","draft_idx":0}]}']
                else:
                    source['messages'] = source['messages'][:1]
                    source['messageIds'] = ['m1']
                    responses = ['{"memory":[{"content":"The user prefers editable PPTX exports","owner":"user"}],"basic_info":{}}']
                host = Host(responses)
                result = await HyEngine(host).organize({'segment':source,'context':context()})
                nodes = [node for op in result['operations'] if op['operation']=='nodes/upsert' for node in op['nodes']]
                self.assertTrue(nodes)
                if working:
                    records = [node['payload']['custom']['record'] for node in nodes]
                    self.assertEqual([record['memory_at'] for record in records],[0,0])
                else:
                    self.assertTrue(any(node['payload']['memory_at']==0 for node in nodes))
                for node in nodes:
                    self.assertEqual(as_node(node).to_dict()['memory_at'],node['payload']['memory_at'])

    async def test_epoch_reads_and_updates_use_utc_without_changing_processing_dates(self):
        record = record_object(WorkingFact,dict(fact_id='epoch',user_id='u1',agent_id='a1',memory_at=0.1,
                                               created_at='2026-10-30T12:34:56'))
        self.assertEqual(record.memory_at.tzinfo,timezone.utc)
        self.assertEqual(record.memory_at.timestamp(),0.1)
        self.assertIsNone(record.created_at.tzinfo)
        host = Host()
        async def operation(ctx,config,overlay,vector,coding,graph,embed):
            await coding.insert_fact(record)
            payload = copy.deepcopy(overlay.nodes['epoch']['payload'])
            payload['memory_at'] = 0.1
            overlay.nodes['epoch']['payload'] = payload
            node = await vector.get_by_id('epoch')
            self.assertEqual(node.memory_at.tzinfo,timezone.utc)
            self.assertEqual(node.memory_at.timestamp(),0.1)
            await vector.update_payload('epoch',{'confidence':0.8})
            revised = await vector.get_by_id('epoch')
            self.assertEqual(revised.memory_at.tzinfo,timezone.utc)
            self.assertEqual(revised.memory_at.timestamp(),0.0)
            return {}
        await HyEngine(host).run({'context':context()},operation)

    async def test_local_serialization_failure_swallowed_by_hy_rejects_staged_result(self):
        class BrokenInstant(datetime):
            def timestamp(self):
                raise OSError('synthetic local timestamp failure')
        for kind in ('experience','fact'):
            with self.subTest(kind=kind):
                responses = ['{"experiences":[{"task":"Export","solution":"Use WPS"}],"facts":[]}',
                             '{"ops":[{"action":"ADD","draft_idx":0}]}'] if kind=='experience' else [
                             '{"experiences":[],"facts":[{"subject":"PPT","statement":"Export completed"}]}','{"ops":[]}']
                host = Host(responses)
                async def operation(ctx,config,overlay,vector,coding,graph,embed):
                    await coding.insert_fact(WorkingFact(fact_id='staged-before-failure',user_id=ctx['userId'],
                        agent_id=ctx['agentId'],session_id=ctx['sessionId'],statement='Independent staged fact',
                        memory_at=datetime(2026,10,30,tzinfo=timezone.utc)))
                    llm = LLMProvider(config)
                    query_embed = QueryEmbedService(embed)
                    writer = CodingWriter(coding,CodingMemoryExtractor(llm),CodingMemoryReconciler(coding,query_embed,llm),
                                          llm,embed,WorkingFactReconciler(coding,query_embed,llm))
                    result = await writer.write([ChatMessage(role=m['role'],content=m['text']) for m in segment()['messages']],
                        user_id=ctx['userId'],agent_id=ctx['agentId'],session_id=ctx['sessionId'],workspace_id=ctx['projectId'],
                        source='superwagie',memory_at=BrokenInstant(1970,1,1,tzinfo=timezone.utc))
                    self.assertTrue(result['success'])
                    self.assertEqual(result['experience_ids'],[])
                    self.assertEqual(result['fact_ids'],[])
                    self.assertIn('staged-before-failure',overlay.changed)
                    return result
                with self.assertRaisesRegex(ValueError,'hy_record_serialization_failed'):
                    await HyEngine(host).run({'context':context()},operation)
                self.assertEqual(host.nodes,{})
                self.assertTrue(all(not params['operation'].endswith(('upsert','delete'))
                    for method,params in host.calls if method=='host.store'))


if __name__ == '__main__':
    unittest.main()
