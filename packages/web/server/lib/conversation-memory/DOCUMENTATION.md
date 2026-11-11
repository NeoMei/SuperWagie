# Conversation memory

## Ownership

The reader owns bounded OpenCode source decoding and checkpoints. The pinned Hy
worker owns production extraction, reconciliation, code history and S2 organization.
The legacy extractor remains the codec and compatibility owner for retained cards.
The runtime owns opt-in capture,
durable jobs, entry eligibility, project scope, source invalidation and cleanup.
The source adapter reads current session location and revert metadata with the
official SDK; only its session-not-found error establishes deletion.
The methodology manager owns explicit multi-session synthesis and independently
confirmed indexing of the stored proposal.
The shared store serializes CAS updates through the embedded SQLite backend.
Typed memory projections share its sqlite-vec and FTS indexes with document
knowledge. They bypass document parsing and Wiki derivation. The knowledge
library retains ownership of document registration and parsing.
OpenCode remains the conversation authority.

## Invariants

- On desktop, the first enabled document-library write enables learning when
  the shared state has no recorded decision. Startup applies that one-time
  migration when the library was already on, including an upgraded install whose
  settings file has no library key. A missing key reads as enabled. A strict
  settings read failure leaves the recorded state unchanged and produces no
  library transition. Each committed library write records the observed value.
  A real false-to-true library transition enables learning after an explicit
  pause. A pause survives restarts and repeated true writes. Disabling learning
  leaves the document library on, and disabling the library leaves learning on.
  Explicit history consent is persisted per session and is reused during that
  session's later source reconciliation. Consent never transfers to another
  session.
- Startup is shared by concurrent callers and completes before capture or recall
  becomes active. A failed initialization stays unavailable even when stored
  consent is enabled. Authenticated account-session reads retry initialization
  after restoring the knowledge backend. Repeated starts preserve current
  extraction jobs; stop retires pending startup and prevents later activation.
- Enablement becomes active only after its durable setting write succeeds.
  Failed writes preserve the previously committed runtime setting. A failed
  library coupling is reported as `library_coupling_failed`. Status derives its
  visible error from current failed jobs, entries, indexing and withdrawal
  records, then from startup, coupling and transient errors. Recovering a stored
  failure clears the visible error when the authoritative state has no remaining
  failed record.
- A processing request received during an active drain schedules one trailing
  drain. Capture, confirmation and synthesis cannot lose their wakeup while the
  previous drain exits. Its final reads and recovery scheduling retain drain
  ownership so idle and stop wait for them. Waiting indexing jobs retain the
  configured poll delay.
- Session locations are resolved authoritatively before selecting a project or
  reading messages. A moved source invalidates old project entries and jobs;
  it never relabels an existing entry into another project.
- Source revisions cancel stale capture, generation and indexing commits.
  Deleted sessions retain a durable refusal marker. Raw OpenCode v2 revert
  events invalidate entries before their debounced authoritative reread.
- Persisted opaque job segments pass the reader's strict schema before model
  invocation. A malformed job fails individually and cannot authorize a call.
- Extraction is persisted before indexing. Failed embedding retries use the
  stored result. A crashed in-flight extraction becomes unknown and needs an
  explicit retry. An idle event supplies a read trigger, never success evidence.
- Ordinary jobs retain their extractor version. Legacy retained cards can
  rebuild their index without another generation call. Other incompatible jobs
  become unknown; explicit history capture authorizes replacement and withdraws
  obsolete cards before regenerating.
- Citations must name retained textual messages. An observed experience must
  quote complete local tool-output lines; that records the observation, not
  semantic proof of the proposed procedure or a wider business outcome.
- Each external indexing operation checks current enablement, policy, source
  revision and entry eligibility. A call already in progress may finish after
  disable; its result is retained and cannot start another operation.
- Recall and agent allowlists contain only active ready entries in the trusted
  project. Recall rechecks current eligibility and runtime enablement after
  asynchronous retrieval. Source references and verification limits accompany
  recalled text; generated content grants no permission.
- Public cards, library references, recall and newly rendered Markdown replace
  only the exact retained system disclaimer `Hy-generated inference. Verify
  current sources and applicability before acting.` with neutral generated-inference
  wording. Stored cards, extractor attribution, source prose and identifiers
  remain unchanged; arbitrary occurrences of upstream names are not rewritten.
- Recall and agent document metadata revalidate the selected source sessions
  through the current query directory, covering every methodology support.
  Location, revert marker and captured anchor checks catch changes while the
  runtime was stopped or disabled. At most 40 distinct sessions are checked;
  unavailable or unchecked sources are withheld independently. Retrieval and
  validation share a 1.5-second budget. Only an authoritative missing-session
  result persists deletion. Changed sources are invalidated immediately, and
  automatic reconciliation is limited to the current query directory. Listing
  management entries and building the retrieval prefilter never scan history.
- Confirm revalidates candidate status and tombstones inside the serialized
  mutation. Confirmation while disabled queues indexing for the next enable.
- Forget writes the entry tombstone before cleanup. Source tombstones suppress
  repeated extraction and preserve existing sibling cards. Cleanup errors stay
  visible and retryable; an already absent managed document is cleaned up.
- Successful forget cleanup blanks the card's title, body and limitations and
  clears its knowledge identifiers. Captured job excerpts are erased when all
  cards using that source are forgotten and cleaned, or its session is deleted.
  Opaque source IDs, hashes and tombstones remain to prevent regeneration.
  Shared job excerpts remain while a sibling card needs source-backed retry.
  Checkpoints for unrelated unfinished turns remain intact.
- Reconnect repair reads only directories observed in live events or explicitly
  captured in the current runtime. It does not activate every persisted project
  and its local MCP servers.
- Explicit methodology consolidation accepts 2 to 10 distinct active ready experiences
  in the same project, from at least 2 sessions. A durable synthesis identity
  includes the extractor version and the supporting source revisions. Missing,
  instruction-bearing or unavailable sources cannot authorize generation.
- Automatic Hy S2 also accepts source-backed segments and candidate experiences
  from at least 2 sessions. It coalesces dirty projects, persists review and
  continuation, and leaves each new method unverified pending confirmation.
- Every synthesized method starts as an unverified candidate. Confirmation is
  separate from synthesis, and its durable indexing retries reuse the stored
  proposal. Interrupted synthesis becomes unknown and only a new explicit
  consolidation request may repeat generation.
- Forget terminates the forgotten method's own indexing job. Old persisted
  forgotten/indexing pairs are repaired to a terminal state on processing.
- A support's forget or source invalidation immediately supersedes dependent
  methods and withdraws their metadata and recall eligibility before backend
  cleanup. Methodology quotations retain the exact session/message references
  from every supporting experience. Methods never inherit observed status.

## Management and runtime surfaces

The authenticated `/api/conversation-memory` family provides status, settings,
project entries, explicit current-session history capture, indexing retry,
candidate confirmation, forget and explicit consolidation. Request schemas
reject caller-supplied project identities. The server resolves source session
locations and project ownership. Bodies are limited to 64 KiB.

The shared knowledge panel and knowledge settings use the same runtimeFetch
client. Web, Electron, hosted mobile and Capacitor use the connected server's
storage and learning state. VS Code hides these controls. The desktop server
owns the library-to-learning transition: it reads its library switch, migrates
an upgraded install at startup and follows committed library writes. A settings
save waits for the same learning state commit. Connected clients keep the
learning checkbox as an explicit off or on override. Existing message full-text
search and manual memories keep their own settings. Once learning is on, a new
conversation in any project can enter capture through the server's global event
subscription and startup backfill. Capture does not require an open management
panel; the history action imports earlier conversations for one selected session.

UI, queue, scheduler, review and agent-dispatched prompt paths pass their current
prompt into session knowledge. Its serialized `openchamber.recalled` entry is
bounded and removed on disabled or failed recall. Recall failure never blocks
the actual send. Agent library reads recheck current eligibility after backend
reads and retain verification, source revision, message/part IDs and limits in
their compact response.

Enterprise mode blocks capture, embedding and semantic memory queries because
legacy backend model records can retain external service bindings. Local
management and forget remain available. No setting or credential is copied into
a second memory service.

## Decisions

### Why initialization is separate from stored consent

The shared ledger can be unavailable until an authenticated account restores its
backend model owner. A readable enabled flag alone cannot establish that event
subscriptions and startup recovery ran. Retrying the single initialization
operation restores them without reclassifying extraction already running in
this process or granting new source consent.

### Why drain wakeups coalesce through finalization

One trailing request preserves work committed while a drain exits without
starting a second owner or replacing indexing delays with immediate polling.
Final state reads and retry scheduling finish before the synchronous handoff,
so idle and stop cannot finish while the retired drain still schedules work.

### Why capture and indexing have separate durable transitions

A backend retry must not repeat a paid distillation request. Stored cards retain
all input needed for deterministic Markdown and reference indexing.

### Why invalidation hides entries before deleting references

An asynchronous backend cleanup can fail or wait behind another request. The
runtime's eligibility and allowlist stop recall immediately while retaining the
identity required for a safe retry.

### Why shared source excerpts survive a single-card forget

Several cards can cite one captured segment. Keeping that segment until its last
card is forgotten preserves the remaining cards' indexing retry evidence. The
forgotten card's generated prose is erased after its own cleanup succeeds.

### Why methods have a separate queue

A method has several source sessions and its own confirmation. A synthetic
single-session extraction job would lose those dependencies or require repeating
generation to retry indexing. The synthesis queue persists proposals before any
indexing call and checks every supporting source again at use time.

### Why automatic new-session capture and not current-session-only

Once the user enables learning, every later message in any project and session
is in scope after enabledAt, including sessions the user has closed. The history
action imports conversations from before enablement for one selected session.
Alternative rejected: requiring a per-session "process current" click, which the
user rejected and which made the feature look broken when only that button
seemed to be the entry.

### Why the server owns the library-to-learning transition

The experiences tab depends on the shared embedding backend. Settings writes
call the learning runtime after the document switch is committed, and startup
migrates an install that already had the library on. One serialized transition
reads the committed learning state before enabling it, so concurrent settings
writes cannot start a second enable. The recorded library value distinguishes a
real false-to-true transition from a repeated true save: the former resumes
learning after a pause, and the latter preserves that pause across restarts.
Disabling learning leaves the document library on. Alternative rejected: asking
the UI to send a second learning request, which failed for remote clients and
for installs upgraded with the library already enabled.
