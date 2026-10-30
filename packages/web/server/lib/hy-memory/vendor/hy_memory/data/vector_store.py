"""The host injects its shared, staged vector store."""
def create_vector_store(config):
    raise RuntimeError('SuperWagie requires an injected host vector store')
VectorStore = create_vector_store
