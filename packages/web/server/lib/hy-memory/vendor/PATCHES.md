# Pinned Hy source

Upstream package version is 2.0.8 at revision `988667cd876fb80bee6d618482f78a2fe426402c`.
The source archive supplied to this integration is the basis of the recorded hashes.

Retained algorithms include the chat writer, extractor and reconciler; coding extractor, experience reconciler, fact reconciler and crosslink writer; code chain grouping and renderer; S2 clustering, bounded batch builder, schema tools, evidence checks, immutable revisions and review counters. The cross-domain sweeper retains behavioral abstraction, independent behavior/content similarity matrices, collision thresholds, Union-Find clustering, existing-core merging, recursive abstraction and evidence inheritance. Retrieval helpers required by these algorithms remain together with their models and utility modules.

The adaptation changes these files:

- Package `__init__.py` files avoid importing the standalone SDK, runtime and storage factories.
- `config.py` uses upstream defaults without environment lookup and does not load `.env` files. Node supplies runtime model routes.
- `agent/llm_provider.py` sends authorized model requests through the host. It contains no provider client, retry policy or credential handling.
- `core/embed_service.py` sends bounded text batches to the shared embedding service and validates model space and dimensions. Query input roles survive every entrypoint. Validation failures remain fatal even when upstream recovery catches them.
- `data/vector_store.py` requires an explicitly injected host adapter.
- `coding/fact_reconciler.py` allows same-project cross-session fact maintenance only when the injected store explicitly authorizes it. Stored provenance keeps real sessions.
- `pipelines/system2_agent.py` uses 2 independent experiences as the minimum explicit consolidation cluster. Evidence checks remain mandatory and accept an explicit engineering methodology kind alongside personal behavior patterns.
- `pipelines/cross_domain_sweeper.py` accepts the injected graph adapter for behavior vectors and an explicit strict failure mode. The worker uses pinned upstream defaults without environment overrides. It fails the complete staged job on model, embedding or graph errors.
- `pipelines/system2_tools.py` requests query embeddings for S2 candidate search. Schema and behavior documents keep document embeddings.
- `host_bridge.py` supplies per-request callbacks through context variables.

Standalone `server`, `client`, `runtime`, `snapshot` and `inspector` entry points are excluded. Chroma, FAISS, Qdrant, Kuzu, Neo4j, MySQL and standalone KV provider implementations are excluded. The worker does not instantiate the retained upstream standalone SQLite coding/cache stores.

The owning adapters provide job-local staging, source references, atomic replacement preparation, typed links, bounded reads and forget closure. Behavior representations use stable owner/role IDs in the shared vector engine, separate from schema content vectors. Typed edges bind representations and cross-domain cores to their owning schemas. Shadow status excludes representation rows before ordinary active top K. Graph updates translate upstream backend fields without dropping custom metadata or schema successor links. Node remains the final durable commit authority.
