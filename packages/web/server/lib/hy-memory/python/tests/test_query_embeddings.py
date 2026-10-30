import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'vendor'))

from adapters import Overlay, VectorAdapter
from query_embedding import ChatReconciler, QueryEmbedService
from hy_memory.config import MemoryConfig
from hy_memory.core.embed_service import EmbedService
from hy_memory.host_bridge import current_context, current_host
from hy_memory.models.memory import MemoryLayer, MemoryNode
from hy_memory.pipelines.base import WriteRequest
from hy_memory.pipelines.system2_tools import System2ToolExecutor
from hy_memory.pipelines.writer import MemoryWriter


class RoleHost:
    async def __call__(self, method, params):
        if method == 'host.embed':
            vector = [0.0, 1.0] if params.get('input_role') == 'query' else [1.0, 0.0]
            return {'vectors': [list(vector) for _ in params['texts']], 'space_id': 'dual-role', 'dimensions': 2}
        if method == 'host.store':
            return {'nodes': [], 'records': [], 'relations': [], 'total': 0}
        raise AssertionError(method)


class QueryEmbeddingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.context = dict(jobId='query-test', namespace='ns', userId='u', agentId='a', projectId='p', sessionId='s')
        self.host = RoleHost()
        self.host_token = current_host.set(self.host)
        self.context_token = current_context.set(self.context)

    def tearDown(self):
        current_host.reset(self.host_token)
        current_context.reset(self.context_token)

    async def test_shared_queued_embedding_preserves_requested_input_role(self):
        embed = EmbedService()
        self.assertEqual(await embed.embed_queued('search', input_role='query'), [0.0, 1.0])
        vector, metadata = await embed.embed_queued_with_meta('search', input_role='query')
        self.assertEqual(vector, [0.0, 1.0])
        self.assertEqual(metadata['space_id'], 'dual-role')

    async def test_query_adapter_keeps_all_embedding_entrypoints_in_query_role(self):
        query = QueryEmbedService(EmbedService())
        self.assertEqual(await query.embed('candidate'), [0.0, 1.0])
        self.assertEqual(await query.embed_batch(['candidate']), [[0.0, 1.0]])
        self.assertEqual(await query.embed_queued('candidate'), [0.0, 1.0])
        vector, metadata = await query.embed_queued_with_meta('candidate')
        self.assertEqual(vector, [0.0, 1.0])
        self.assertEqual(metadata['space_id'], 'dual-role')

    async def test_chat_reconcile_queries_without_reusing_query_vectors_for_storage(self):
        config = MemoryConfig()
        embed = EmbedService()
        searched = []

        async def host(method, params):
            if method == 'host.store' and params['operation'] == 'nodes/search':
                searched.append(params['vector'])
            return await self.host(method, params)

        overlay = Overlay(host, self.context, embed)
        vector = VectorAdapter(config, overlay)
        writer = MemoryWriter(config, embed_service=embed, vector_store=vector)
        await writer.initialize()
        writer.reconciler._enable_search_query = False
        writer._reconciler = ChatReconciler(writer.reconciler)
        request = WriteRequest(messages=[], user_id='u', agent_id='a', session_id='s', source='superwagie')
        ids, error, _, _ = await writer._reconcile_and_store(
            ['The user prefers editable PPTX'], [], request, vector, 'query-test',
            precomputed_embeddings={'The user prefers editable PPTX': [1.0, 0.0]},
        )
        self.assertIsNone(error)
        self.assertEqual(len(ids), 1)
        self.assertTrue(searched)
        self.assertTrue(all(value == [0.0, 1.0] for value in searched))
        self.assertEqual(overlay.nodes[ids[0]]['vector'], [1.0, 0.0])

    async def test_s2_search_uses_query_embedding_role(self):
        class SearchStore:
            async def search(self, query_embedding, **kwargs):
                if query_embedding != [0.0, 1.0]:
                    return []
                node = MemoryNode(node_id='fact', user_id='u', agent_id='a', layer=MemoryLayer.L2_FACT, content='Editable PPTX')
                return [{'node_id': 'fact', 'node': node, 'score': 1.0}]

        executor = System2ToolExecutor(SearchStore(), None, EmbedService(), 'u', 'a')
        results = await executor._tool_search_vdb({'query': 'editable slides'})
        self.assertEqual([row['node_id'] for row in results], ['fact'])


if __name__ == '__main__':
    unittest.main()
