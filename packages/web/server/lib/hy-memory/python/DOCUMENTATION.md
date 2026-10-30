# Hy worker

## Ownership

The worker executes the pinned Hy 2.0.8 chat and productivity algorithms. It owns extraction, scoped candidate reconciliation, fact revision links, experience and fact crosslinks, code patch decoration, bounded S2 review and cross-domain abstraction. Node owns approved source reads, consent, model selection, durable scheduling, card eligibility, source validation and final commits. The shared embedded backend owns vectors and durable state.

## Invariants

- `stdout` contains JSON protocol lines only. The worker never logs prompts, responses, credentials or source bodies. Errors return stable codes and a generic message.
- Protocol input and output explicitly use strict UTF-8. Windows ANSI pipe defaults cannot change JSON encoding; non-ASCII messages and source text round-trip unchanged.
- Python never receives provider credentials, reads `.env`, opens a listener, downloads a model or invokes Git. Model and embedding calls use reverse requests to the authorized Node job.
- Every request creates its own mutation overlay. Reads see earlier staged writes. Host store requests are reads. Durable changes appear only in the final operations array after every required host operation succeeds.
- Principal and project filters apply before host top K. Ordinary write candidates also require the real source session. Explicit maintenance may read the trusted project across sessions. Trace keys include principal, project and real session.
- New fact replacements embed and stage the successor before predecessor retirement. A failed insert discards the request result. Fact and experience links use stable node IDs and typed relations.
- Coding replacements persist Hy's native superseded status and bidirectional version fields alongside `FACT_SUPERSEDES`. Reader adapters hydrate earlier shadow facts from their existing superseded record and successor link within the host-approved candidate pool. Hydration stages no writes and never admits a withdrawn source or a retired card into final eligibility.
- Generated confidence cannot change verification. Cards start unverified. Experiences and methods remain candidates. Every card and derived node carries exact captured source identities. Node validates them against current source and entry revisions before commit.
- Chat keyword candidates use the retained Hy BM25 scorer over a complete bounded shared-store pool. Principal, project and source-session filters apply before lexical ranking. Oversized or incomplete pools fail the request.
- Coding and schema vector rows retain their exact `embedding_text`, including task-only experience keys, subject-prefixed facts and schema retrieval text. Model-space migrations preserve that representation.
- Candidate search uses query embeddings. Stored facts, experiences, schemas and behavioral abstractions use document embeddings. Chat reconciliation cannot reuse query vectors for durable documents.
- Model output must be complete. Unknown source citations fail the job. Hy's recovery paths cannot turn a failed host operation, malformed embedding, adapter validation or strict cross-domain stage into an empty successful commit.
- Store pages contain at most 100 rows. A request loads at most 512 nodes and performs at most 300 store reads. Oversized delete closure fails before any durable deletion.
- S2 uses Hy's clustering, 24-fact batch builder, schema tools and review counters. A successful batch returns staged review counters and a continuation when another cluster remains. A retry reuses committed source support IDs and counters.
- Every consolidation invokes Hy's cross-domain sweeper, including runs with no eligible new S2 batch. It uses separate content and behavior representations, the upstream collision thresholds and Union-Find, typed cross-abstraction links, existing-core merging and inherited evidence. A bounded graph scan pages completely or fails; it cannot report a partial scan as complete.
- Recall executes the pinned `HybridReadPipeline.read` implementation over read-only host adapters. It retains Hy query expansion, independent BM25 and semantic candidates, schema forward/reverse evidence RRF, graph support, evolution-chain latest selection and diversity/MMR. The independent behavior channel joins through Hy rank fusion and returns active schema owners. Raw support and role rows never become recalled cards.
- Node supplies `recallEligibleNodeIds` for final source-authorized cards and `recallCandidateNodeIds` for bounded candidate anchors, aliases and prior revisions. Empty eligibility returns no memory. Unknown or unconfirmed graph neighbors cannot enter an eligible card's merged context. Internal S2 support IDs map back to canonical evidence IDs for reverse schema retrieval.
- Reader requests use query-role embeddings and cannot stage writes. Optional local cross-encoder, episode generation, L7 lazy mutation and access tracking remain disabled. No Torch, NLP model download, standalone storage factory, new listener or provider secret is introduced. The reader reports its actual channel counts and policy in the response.
- Changed schemas whose evidence extends beyond the active S2 batch return as `deferredCards` with exact source references and recursively resolved canonical support IDs. Node owns expanded support snapshots, candidate materialization and later confirmation; graph persistence alone cannot authorize automatic advice.
- Behavior representations use stable owner/role IDs and the same shared embedding space as content. Their shadow status excludes them before active semantic top K. They retain real source references and an owning `SCHEMA_BEHAVIOR` edge.
- Engineering method schemas and personal behavior schemas have separate kinds. Both require independent source evidence. A schema cannot grant general validation to its supporting observations.
- Code history retains original diff hunks and real source session/message/part identities. Every patch record links only the staged nodes whose exact session/message/part source references match its captured patch. Hy's thread grouping and renderer run in a scratch in-memory SQLite database over a bounded host-approved selection.
- Appending trace messages retains the union of prior and current captured source references and owning node IDs. New records derived with trace context retain that context's source references too. Forget or reset of any retained source invalidates the shared trace before a later model request.
- Individual forget removes its node, dependent schemas, fact and schema revision chains, behavior representation rows, dependent cross-domain cores and search-key rows. It repairs surviving fact/experience sibling links. Shared traces and patch records remain until their last owning node is removed. Full source withdrawal passes every node owned by that source.

## Decisions

### Why algorithms stage changes through host adapters

Hy's standalone stores commit metadata and vectors separately. The request overlay allows Hy's algorithms to read their own changes while Node commits the complete result against current source revisions atomically.

### Why S2 stores explicit supports under stable IDs

Support IDs include the original entry ID and source hash. Review continuation reuses these records while preserving every real source session. Reconstructing fresh supports on each retry would repeat paid synthesis.

### Why code history uses scratch SQLite

Hy's original thread and round code groups diffs and renders version history. Running it over selected records preserves that behavior without a second persistent database or repository scans.

### Why behavior representations use their own IDs

Hy compares content similarity with behavioral similarity independently. A role node keeps both vectors in the shared engine without overwriting schema content. Its shadow status excludes internal abstractions from active recall, and its owner edge gives forget a complete deletion path.

### Why graph scans fail at the request budget

Collision clustering depends on the full selected graph. Returning only its first page changes the result. Complete paging retains the upstream bounded algorithm; a larger graph requires a deliberate continuation design before that limit can grow.

### Why chat reconciliation discards its query embedding cache

Hy's standalone writer reuses reconciler embeddings for durable storage. A shared engine may have different query and document encodings. The adapter runs candidate search with query vectors and lets the writer encode stored documents separately.
