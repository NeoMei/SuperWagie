import copy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'vendor'))

from adapters import Overlay, VectorAdapter
from hy_memory.config import MemoryConfig
from hy_memory.models.memory import MemoryLayer, MemoryNode


class AdapterFilterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.context = dict(jobId='adapter-job', namespace='adapter-ns', userId='user', agentId='agent',
                            projectId='project', sessionId='session', crossSessionMaintenance=True)
        node = MemoryNode(node_id='fact', content='Editable PPTX export', embedding=[1.0, 0.0],
                          layer=MemoryLayer.L2_FACT, user_id='user', agent_id='agent', session_id='session')
        payload = node.to_dict()
        payload['workspace_id'] = 'project'
        self.node = dict(id='fact', content=node.content, payload=payload, vector=node.embedding, active=True, score=1.0)
        self.requests = []

    async def host(self, method, params):
        self.assertEqual(method, 'host.store')
        self.requests.append(copy.deepcopy(params))
        filters = params['filters']
        # The shared backend rejects JSON null filter values.
        if any(value is None for value in filters.values()):
            raise ValueError('invalid_memory_index_request')
        rows = [self.node]
        for key, value in filters.items():
            accepted = value if isinstance(value, list) else [value]
            rows = [row for row in rows if (row['id'] if key == 'node_ids' else row['payload'].get(key)) in accepted]
        return dict(nodes=copy.deepcopy(rows), total=len(rows))

    def overlay(self):
        return Overlay(self.host, self.context, SimpleNamespace(space_id=None, failures=[]))

    async def test_unrestricted_layer_queries_omit_null_filters(self):
        for operation in ('list_by_user', 'search', 'keyword_search'):
            for layers in (None, []):
                with self.subTest(operation=operation, layers=layers):
                    adapter = VectorAdapter(MemoryConfig(), self.overlay())
                    if operation == 'list_by_user':
                        result = await adapter.list_by_user(layers=layers)
                        identities = [node.node_id for node in result]
                    elif operation == 'search':
                        result = await adapter.search([1.0, 0.0], layers=layers)
                        identities = [hit['node_id'] for hit in result]
                    else:
                        result = await adapter.keyword_search('editable PPTX', layers=layers)
                        identities = [hit['node_id'] for hit in result]
                    self.assertEqual(identities, ['fact'])
                    self.assertEqual(self.requests[-1]['filters'], dict(status=['active'], user_id='user',
                                     agent_id='agent', workspace_id='project'))

    async def test_explicit_layer_restriction_remains_in_host_queries(self):
        adapter = VectorAdapter(MemoryConfig(), self.overlay())
        self.assertEqual(await adapter.list_by_user(layers=[MemoryLayer.L3_SUMMARY]), [])
        self.assertEqual(self.requests[-1]['filters']['layer'], ['l3_summary'])

    async def test_empty_allowlist_still_excludes_all_nodes(self):
        self.assertEqual(await self.overlay().select(dict(node_ids=[], layer=None)), [])
        self.assertEqual(self.requests[-1]['filters']['node_ids'], [])


if __name__ == '__main__':
    unittest.main()
