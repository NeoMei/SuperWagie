"""Shared host embedding adapter. No local models or provider credentials."""
from contextlib import contextmanager
from ..host_bridge import current_host, current_context

@contextmanager
def embed_endpoint_override(*args, **kwargs):
    yield

class EmbedService:
    def __init__(self, config=None):
        self.config = config
        self.space_id = None
        self.dimensions = None
        self.failures = []
    def fail(self, code):
        error = ValueError(code)
        self.failures.append(error)
        raise error
    async def embed_batch(self, texts, **kwargs):
        if not texts:
            return []
        response = await current_host.get()('host.embed', {'texts': texts, 'jobId': current_context.get()['jobId'], 'input_role': kwargs.get('input_role', 'document')})
        vectors = response.get('vectors')
        dims = response.get('dimensions')
        space = response.get('space_id')
        import math
        if not isinstance(vectors, list) or len(vectors) != len(texts) or not isinstance(dims, int) or dims < 1 or not space:
            self.fail('hy_embedding_invalid')
        if any(not isinstance(v, list) or len(v) != dims or any(not isinstance(x, (int, float)) or not math.isfinite(x) for x in v) for v in vectors):
            self.fail('hy_embedding_invalid')
        if self.space_id and (self.space_id != space or (self.dimensions is not None and self.dimensions != dims)):
            self.fail('hy_embedding_space_changed')
        self.space_id, self.dimensions = space, dims
        return vectors
    async def embed(self, text, **kwargs):
        return (await self.embed_batch([text], **kwargs))[0]
    async def embed_queued(self, text, **kwargs):
        return await self.embed(text, **kwargs)
    async def embed_queued_with_meta(self, text, **kwargs):
        return await self.embed(text, **kwargs), {'space_id': self.space_id}
    async def close(self):
        pass
