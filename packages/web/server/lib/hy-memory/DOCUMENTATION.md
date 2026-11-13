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
- On Windows, the worker loads its native numeric modules on the main thread
  before starting the stdin reader. Capability readiness follows these imports;
  a missing dependency fails before any request or staged mutation.
- A graceful worker close requires the parent to close stdin after the close
  request. The worker waits up to 1 second for that reader to finish before
  interpreter finalization. Node retains ownership of forced process cleanup.
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
  source-backed card is required. The older generic
  `hy_chat_extraction_failed` code is eligible only when that durable result
  exists, so old tasks recover without paying for another generation. Source,
  policy, credential and malformed result errors remain visible for explicit
  repair. Unknown generation never enters automatic recovery.
- Legacy document cleanup uses the original document owner after the new
  typed projection is ready. Its marker survives failures. Candidate and
  withdrawn old documents can be removed without embedding generated text.
- Card search partitions canonical node allowlists at the backend's 256-ID
  bound. Each channel merges partition scores before selecting its final top K;
  lexical matches retain priority over semantic additions. Failed partitions
  produce explicit degraded availability while complete partition results remain.

## Decisions

### Why Windows loads numeric modules before reading stdin

The first NumPy/SciPy native import can block while another thread reads piped
stdin, as recorded in [NumPy #24290](https://github.com/numpy/numpy/issues/24290).
Loading the required clustering and pairwise modules before the reader starts
avoids this conflict while preserving Hy's algorithms and thread configuration.

### Why graceful close waits for the stdin reader

The close response can reach the parent before its following stdin EOF reaches
the reader. A bounded join lets that reader release its buffered input lock
before Python finalizes its streams. It does not replace the parent's process
termination deadline when stdin remains open.

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

### Why generic extraction failures require a durable result

An older engine used `hy_chat_extraction_failed` for several distinct failures.
Its completed receipts and stored cards can be committed without another model
call. Jobs without either result stay failed, so the user decides when to
import the session history again. Automatically regenerating all of them would
repeat paid calls and could mask credential or format failures.

### Why transport maintenance plans from raw ledger rows

The offline `transport-rebind.js` planner reuses the ledger decoder, space
eligibility, source authority and manual-index predicates. It verifies framed
ledger and node digests against the native snapshot. Canonical card bodies and
payload identities must match; manual copies require current hashes, ready
markers, scope and threat checks. Source-authorized inactive core rows retain
their activity flag. Global manual memory requires no project binding.

The planner patches only the original model-space and eligible manual-index
engine rows. Unknown raw fields and absent optional dimensions survive. Full
ledger encoding would insert schema defaults and strip unknown fields. The
manifest supplies source keys, digests and authority IDs; the native transaction
reads content, payload and vector bytes itself. No runtime maintenance guard is
bypassed and ordinary `ensure` and manual synchronization remain unchanged.

## Explicit memory review

### Ownership

`tidy.js` owns project-scoped review proposals, selected entry updates, durable
per-entry undo revisions and the separate AGENTS.md export decision. It reads
manual rows and retained conversation cards from the existing shared ledger.
Conversation memory continues to own live source validation, deletion and
recall eligibility. The worker owns generated organization and indexes.

### Invariants

- Opening review is explicit. Proposals trim surrounding whitespace and collapse
  exact repeated prose paragraphs of at least 40 characters. Code, tables,
  lists and quotations are excluded from paragraph consolidation. Unchanged
  entries remain selectable for rule export.
- Global manual memory is outside this project review. Up to 200 project
  entries enter a preview. Unverified or unavailable sources are reported
  separately; they do not authorize a successful empty replacement.
- Every item includes its ID, kind, original type, verification, retained source
  message references, original content, proposed content and reason codes.
  Review cannot promote a candidate or turn an inference into a manual record.
- Preview IDs are process-local, expire after 15 minutes and retain at most 32
  review snapshots and 32 file previews. A restart requires another preview.
  The client cannot supply replacement text to apply.
- Apply compares each entry's complete version and captured project/source
  version inside the serialized ledger update. Undo compares the applied
  version independently for each revision. A conflict preserves the current
  entry and does not block another selected entry.
- Revision rows use `hy-tidy-revision`. Source invalidation, forget and manual
  deletion prune their retained prose. Withdrawal also removes revisions in its
  affected source closure. Receipt bodies never authorize recall.
- Review source checks reuse current session location, checkpoint and anchor
  validation with history reconciliation disabled. Preview, apply, undo and
  export neither call a model/embedding service nor enqueue a generation job.
  Existing indexing and capture remain separate runtime owners.
- Rule export accepts at most 30 selected memories and only targets AGENTS.md
  in the displayed working directory. It includes original kind, verification
  and source attribution in the displayed appendix. It never targets a skill.
- Export preview writes no file. Confirmation is a separate authenticated
  request, rechecks project, entries and sources, verifies target identity and
  content, stages the candidate beside the target and rechecks before rename.
  The final alias must still resolve to the previewed canonical root and exact
  target. A separate read of that fixed publication target must match the saved
  root, path and version; a retargeted alias cannot validate another file.
  Cancellation writes nothing. A changed file needs a fresh diff and another
  confirmation. Symlink, hardlink, non-file and oversized targets are refused.
- The final rename publishes a complete candidate. Version checks cover changes
  observed before that rename; a noncooperating external process can still race
  the last filesystem check. This route has no filesystem-wide CAS primitive.
- Isolated-space directories are refused before resolving host project memory.
  The UI disables the same pilot in spaces. No container or host file transfer
  permission is added.
- Web and Electron use the authenticated OpenChamber routes. Hosted mobile and
  Capacitor use the same connected server and source checks through the shared
  project-context panel. VS Code disables the entry, and its explicit local
  route handler answers `501` with `runtime_unsupported` before proxy fallback.
- Runtime/project changes abort and clear the review UI. The HTTP adapter also
  checks the runtime instance after each response, including endpoint round
  trips. A server write already accepted before cancellation may complete on
  that original server; its revision remains readable there.
- All review work remains inside the current server and its OpenCode source
  reader. Enterprise mode can manage retained records through these local
  operations; no new egress, provider entry, listener or share grant is added.

### Why review uses local normalization

The pilot can produce inspectable changes without another paid model call.
Semantic rewrites, cross-entry merging/deletion, global memory, unattended
cleanup and skill export require separate decisions and are excluded.

### Why undo compares individual revisions

A whole-store backup would overwrite later manual edits. Each revision retains
only one entry's before/after proposal and requires that entry's applied version
and source authority to remain current.
