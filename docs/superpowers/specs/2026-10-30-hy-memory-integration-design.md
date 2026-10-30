# Hy memory integration

Approved in the maintainer conversation on 2026-10-30. Hy is the selected organizer. Document and memory vectors share the embedded SQLite/sqlite-vec service. The implementation preserves existing opt-in, project scope, source revisions, candidate confirmation and forget semantics.

## Owners

Node owns consent, authoritative OpenCode source reads, project identity, model dispatch, scheduling, eligibility and tools. The pinned Python Hy core owns extraction, candidate reconciliation, fact/experience links, code history and S2 organization. The embedded Go backend owns shared SQLite transactions, vector/keyword indexes and durable memory records. CodeGraph and original files retain their existing source authority.

No new public listener, provider credentials in Python, model downloads, standalone MemHub app, Redis or second search product. Existing tool names and managed conversation routes remain compatible. Web, Electron, hosted mobile and Capacitor use the active backend. VS Code retains explicit unsupported behavior for these server-owned capabilities.

## Private backend contract

All requests use authenticated existing embedded-backend transport and a knowledge-base ID authorized by that principal. Prefix: /api/v1/knowledge-bases/:id/memory-index. Responses use existing {success,data} envelopes and stable HTTP errors. Node supplies trusted namespace and scopes; agent-provided project IDs never grant access.

POST /state/read {namespace} -> {revision,records:[{collection,id,value}]}
POST /state/commit {namespace,expected_revision,idempotency_key,mutations:[{collection,id,value?,delete?}]} -> {revision}
Collections: meta,source,entry,job,relation,receipt,usage. CAS conflict is HTTP409. Commits and idempotency receipts are atomic. Collection/id are bounded identifiers; value is bounded JSON.

POST /nodes/upsert {namespace,space_id,nodes:[{id,content,vector,payload,active}]} -> {ids}
POST /nodes/get {namespace,space_id,ids,include_vectors?} -> {nodes}
POST /nodes/list {namespace,space_id?,filters?,limit?,offset?,include_vectors?} -> {nodes,total}
POST /nodes/search {namespace,space_id,vector,filters?,limit?,min_score?} -> {nodes:[{id,content,payload,score,vector?}]}
POST /nodes/delete {namespace,space_id?,ids?,filters?} -> {deleted}
POST /nodes/payload {namespace,space_id,ids,patch} -> {updated}
POST /embed {texts,model_id?} -> {vectors,space_id,dimensions}

Payload is Hy MemoryNode's serialized data; scope filter names: user_id,agent_id,session_id,workspace_id,branch,source,layer,status,node_ids; list values mean IN. Namespace and embedding space filters apply before topK. Model identity and dimensions bind a space. Node IDs are stable across vector/keyword updates. Documents' Wiki strategy cannot block memory-node writes. Metadata, FTS and vectors change in one transaction. Embedding service resolves the KB model and never exposes credentials.

## Worker contract

Pinned source under packages/web/server/lib/hy-memory/vendor/hy_memory. Worker entry packages/web/server/lib/hy-memory/python/worker.py. JSON lines, stdout protocol only, stderr sanitized diagnostics. Request: {id,method,params}. Response: {id,result} or {id,error:{code,message}}. Reverse request: {id,method:'host.generate'|'host.embed'|'host.store',params}; Node replies with matching id. Host operations carry only job-approved scope. Startup handshake method capabilities returns engine/version/source SHA/features.

Methods: organize {segment,context}, consolidate {entries,context}, recall {query,context}, forget {ids,context}, close. Context contains job ID, namespace, user/agent/project/session identity, source revision and model preference. No provider secrets. generate uses existing small-model service with overflow=error. Host embedding uses the shared backend. Store calls use bounded batch/pagination and an in-request mutation overlay so later Hy reads see earlier writes. Final result contains cards plus structured fact/experience/schema/relations and staged operations; Node revalidates source/entry revisions before durable commit.

Hy-derived cards retain exact source message/part identities and observation limits. Model confidence never elevates verification. Personal pattern and engineering methodology semantics are explicit. Cross-session organization operates within trusted project scope while keeping real session provenance.

## Runtime

A single durable scheduler owns capture, extraction, projection, cleanup and S2. Persist generated results before indexing; retries reuse them. Policy/model blocks wait for repair; transient failures have bounded retries; interrupted paid generation remains unknown. S2 uses dirty revisions, bounded batches and durable continuation rather than full evolution after every event.

A shared retrieval operation serves explicit tools, management and send-time recall. Exact/lexical retrieval remains available during semantic failure. Preserve rank through scope/source checks, refill eligible candidates and return availability reasons. Candidate inspection never silently becomes verified recall. Forget/source withdrawal revokes eligibility before asynchronous cleanup, including Hy facts, schemas, patch history and queued jobs.

## Validation

Retained Hy algorithms execute through real adapters with deterministic fixtures; shared vector engine and state use actual SQLite tests. Cover CAS/idempotency, partial failures, source mutation during generation, project isolation, candidate gating, ranked recall, lexical degraded reads, namespace Wiki independence, S2 continuation, patch provenance, delete closure and lifecycle recovery. Build and inspect macOS ARM64 and Windows x64 worker resources. No engine-selection A/B or release publication is required by this task.
