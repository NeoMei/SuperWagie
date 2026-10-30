# Hy memory

## Ownership

The shared store owns the durable memory ledger and atomic backend commits.
Conversation capture owns source consent, excerpts, revisions and card
eligibility. The manual adapter owns explicit `memory.*` records and scope
imports. Hy owns source-bound organization and review through the worker;
generated changes pass Node's source validation before their final commit.

## Invariants

- Every file in the pinned vendor manifest must be tracked in Git. The vendor
  attributes preserve exact bytes on Windows; the local ignore rules explicitly
  retain Hy's `data` package despite the repository's runtime-data exclusion.
- Manual records use the `manual` collection in the same ledger as Hy records.
  Their original IDs remain in the record and value. `global` names the global
  project namespace; project records keep their resolved project identity.
- `manual-scope` records establish one-time legacy import, including successful
  missing and empty reads. A failed legacy read or failed import commit creates
  no import marker. Legacy JSON files remain intact.
- Before the shared backend is configured, manual CRUD continues in its local
  file. Each scope serializes those writes with later migration. A local
  `.shared-state` marker reserves shared authority before importing and records
  the successful handoff. Once reserved, a shared outage cannot restore stale
  local content. Corrupt markers and failed shared reads remain errors.
- Manual mutations mark the owning project dirty in their durable commit. They
  require no model or embedding call. Removing a manual record erases its body
  from the current ledger while retaining the scope import marker.
- Manual records carry their original type and scope. They remain unverified
  and supply no fabricated OpenCode message references. Flagged records never
  enter recall. Generated inferences cannot become manual records.
- Manual vectors use a per-scope `:manual` namespace in the same SQLite engine.
  `manual-index` markers bind source hash, embedding configuration identity,
  actual model space, dimensions and pending/ready state. Canonical records
  filter candidates before top K and after retrieval. Edits, flagging and
  deletion withhold stale vectors immediately. Projection and ready marker
  commit together. Manual indexing follows its existing feature switch.
- Captured entries retain real OpenCode sources. Manual records never enter
  `state.entries`, source jobs or session consent tables.
- Automatic S2 uses 2 to 10 source-backed segments or experiences within one
  trusted project and at least 2 sessions. A candidate experience keeps its
  candidate status. Every generated method is an unverified candidate and
  requires separate confirmation.
- Automatic cross-domain results can extend their source snapshots to current
  eligible cards in the same project. Each deferred method needs exact retained
  message/part/hash/revision evidence, at least 2 source sessions and a fresh
  source check before its expanded supports and receipt commit. One job keeps
  at most 100 source cards and 40 sessions. Explicit consolidation retains its
  selected source set. An unavailable deferred source does not discard an
  independently valid primary proposal.
- Deferred methods with temporarily unavailable sources remain in the bounded
  `synthesis.generated.deferredCards` receipt with pending/rejected diagnostics.
  A later dirty-project pass retries this retained result without another model
  generation. Unknown, withdrawn or revised evidence cannot authorize promotion.
  Candidate materialization never grants confirmation or recall eligibility.
- The full generated result and review receipt persist in `synthesis.generated`
  before card and projection commits. Unknown generation needs an explicit
  retry. Explicit consolidation uses the same Hy S2 path and
  preserves review-only receipts without inventing a method.
- Captured message, part, hash and revision provenance survives worker calls
  and commits. `engine.continuations` retains the cursor, previous job ID and
  pass. Scheduling permits 1 batch per project per tick and at most 32
  consecutive continuation passes. Dirty project marks coalesce.
- A complete result persists only while its source revisions remain authorized.
  A late result after withdrawal cannot restore an erased receipt. Final
  projection operations come from the live serialized ledger, and their state,
  node provenance and indexes share the CAS transaction. Capture projection
  identities include the source revision.
- `hy-withdrawal` journals contain opaque closure IDs and source hashes. Source
  withdrawal or forget revokes cards before deleting core nodes, card vectors,
  keys, behavior representations, dependent schemas, relations and history.
  Shared source evidence remains while a surviving sibling needs it. Failed
  deletion remains visible and retries at most 3 times per process with backoff;
  pending journals resume on startup. Source restoration cannot let an old
  journal delete a newer generation.
- The owned stdio worker has one serialized request owner. A short recall cannot
  cancel a running organizer; it reports busy and leaves card/lexical retrieval
  available. Protocol errors, invalid handshakes and cancellation retire the
  child before replacement. Late responses cannot cross process generations.
- Hy raw node reads apply the canonical source allowlist before backend top K.
  Retained vectors or traces alone cannot authorize a read. Exact source
  identities are checked again before every model or embedding request.
- Model configuration is checked through a read-only fingerprint. A changed
  model copies core, behavior and card vectors in 32-row batches with a durable
  `model-space-migration` cursor. Old vectors remain complete until the final
  atomic binding swap and old-space deletion. An ensure call performs at most
  32 batches. Cancellation, disablement or source changes prevent publication;
  a retry resumes completed copies. Unchanged configuration needs no document
  embedding call.
- Legacy `conversation-memory-v1` cards keep their source, confirmation and
  extractor attribution. A one-time migration resets their index identifiers
  and retains the old identifiers in `legacy-projection` records. Only a
  current source-backed stored card can bypass the new extractor version for
  indexing. This bypass never authorizes generation.
- Recovery retries known backend transport and indexing failures at most 3
  times with durable exponential backoff. A stored generation receipt or
  source-backed card is required. Source, policy, credential and malformed
  result errors remain visible for explicit repair. Unknown generation never
  enters automatic recovery.
- Legacy document cleanup uses the original document owner after the new
  typed projection is ready. Its marker survives failures. Candidate and
  withdrawn old documents can be removed without embedding generated text.
- Card search partitions canonical node allowlists at the backend's 256-ID
  bound. Each channel merges partition scores before selecting its final top K;
  lexical matches retain priority over semantic additions. Failed partitions
  produce explicit degraded availability while complete partition results remain.

## Decisions

### Why manual records keep a separate kind in one ledger

A manual fact, preference or pointer has different provenance from a generated
conversation card. A typed collection shares durability and retrieval while
preserving those source and verification limits.

### Why manual imports use durable scope markers

An empty scope is authoritative data. Persisting its import result prevents a
later read from resurrecting content from a retained legacy file after deletion.

### Why manual title replacement is exact

Word overlap can merge different explicit facts before Hy sees them. Exact
titles and named IDs provide deliberate replacement while the shared ledger
keeps inferred organization behind its own source rules.

### Why legacy indexing retains the old extractor version

Stored cards already contain a completed result. Reindexing them needs no model
call, and preserving their attribution avoids presenting an old heuristic
extraction as a Hy inference. A source change still withdraws their eligibility.

### Why recovery persists its retry budget

Restarts must preserve the attempt limit and next attempt time. Keeping recovery
metadata in the shared ledger prevents repeated backend outages from creating an
unbounded retry loop or repeating a paid generation call.
