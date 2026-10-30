"""Keep candidate query embeddings separate from durable document embeddings."""


class QueryEmbedService:
    def __init__(self, embed_service):
        self.embed_service = embed_service

    def __getattr__(self, name):
        return getattr(self.embed_service, name)

    async def embed_batch(self, texts, **kwargs):
        return await self.embed_service.embed_batch(texts, **dict(kwargs, input_role='query'))

    async def embed(self, text, **kwargs):
        self.last_embedding = await self.embed_service.embed(text, **dict(kwargs, input_role='query'))
        return self.last_embedding

    async def embed_queued(self, text, **kwargs):
        return await self.embed(text, **kwargs)

    async def embed_queued_with_meta(self, text, **kwargs):
        vector = await self.embed(text, **kwargs)
        return vector, {'space_id': self.embed_service.space_id}

    async def embed_with_meta(self, text, **kwargs):
        vector = await self.embed(text, **kwargs)
        return vector, {'space_id': self.embed_service.space_id}


class ChatReconciler:
    def __init__(self, reconciler):
        self.reconciler = reconciler

    def __getattr__(self, name):
        return getattr(self.reconciler, name)

    async def reconcile(self, **kwargs):
        # Hy reuses supplied content embeddings for candidate search and returns
        # them to the writer. Each side needs its own embedding input role.
        kwargs = dict(kwargs, embed_service=QueryEmbedService(kwargs['embed_service']))
        kwargs.pop('new_memory_embeddings', None)
        result = await self.reconciler.reconcile(**kwargs)
        result.new_memory_embeddings = {}
        return result
