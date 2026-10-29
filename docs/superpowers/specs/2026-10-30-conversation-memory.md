# Conversation learning and retrieval

Approved in the maintainer session on 2026-10-30. Build the conversation capture, evidence-backed distillation, WeKnora indexing and retrieval described in that session. Hy-Memory is not a dependency.

## Ownership and behavior

OpenCode remains authoritative for conversations and tool records. The existing message-search index remains an independent opt-in full-text reader. A new `conversation-memory` runtime owns its own capture checkpoints, durable jobs, source references, generated Markdown and forget records. The existing knowledge library owns parsing, embedding and document retrieval. Session knowledge owns the entries presented before a prompt.

Conversation learning is initially off. Enabling it processes new settled root-session turns; a separate explicit action processes the selected session's existing history. Background processing never depends on a panel being mounted. Session idle triggers a read, not a claim that a task succeeded. Failed and interrupted work may produce historical summaries but never verified success merely because a turn ended.

One distillation call produces a work-segment summary and zero or more experience cards. Cards carry problem, conditions, steps, observed result, limitations and exact source IDs. Only source-backed observations may be described as verified. Generic methodology requires independent supporting experiences or explicit user confirmation; single-turn extraction does not publish universal rules. Generated text is reference material, not authority or inherited permission.

The model uses the existing OpenCode small-model dispatcher with the caller's provider/model context and explicit selected settings. Embedding uses the existing knowledge backend bindings and enterprise policy. Content and credentials are never logged. Credentials remain with their current owners.

## Persistence and scope

Store state and Markdown under the app data directory with owner-only permissions and atomic replacement. Persist an extracted result before indexing, so an embedding retry does not repeat generation. Stable source hashes and extractor versions prevent duplicate work. A crashed in-flight generation is visible as unknown rather than blindly repeated; indexing can be retried using the stored document.

Each entry belongs to the trusted project resolver's owner, not a model-provided project. Managed experience libraries are project-scoped. Ordinary global library queries must exclude managed experience libraries unless a matching trusted project scope is supplied. Every generated entry maps to source session/message IDs and a source revision. Session removal/revert invalidates affected entries. Forget records take effect before asynchronous cleanup and prevent regeneration from the same source. Cleanup failures remain visible and retryable.

## Runtime surfaces

| Surface | Behavior |
| --- | --- |
| Web | Uses the connected server runtime and data directory; unavailable indexing is explicit. |
| Electron | Uses its in-process web backend and bundled WeKnora. No new native process or dependency. |
| VS Code | No web backend; hide the feature and preserve existing prompt behavior. |
| Hosted mobile | Uses the connected web runtime with ordinary authenticated runtime HTTP. |
| Capacitor mobile | Same server behavior through existing runtime transport. No device-local index implied. |

The knowledge-library settings and existing knowledge panel provide activation, processing status, history processing, search, source opening, retry and forget. No separate product UI or model credential store is introduced. Existing user memory and knowledge documents remain intact.

## Retrieval

WeKnora indexes managed Markdown through the existing reference/register/reparse lifecycle. Only ready, active entries in the trusted scope can be recalled. Source ID/version and verification limits accompany results. A bounded recall runs before UI, queue, scheduler and dispatched prompts; failures do not prevent sending, and old recall entries are removed when disabled or unavailable. Agent library search can retrieve the same project-scoped experience documents. Current code remains verifiable through CodeGraph; this feature does not initialize indexes or run commands from memories.

## Verification

Exercise source paging, unfinished turns, interruptions, reverts, deletion, duplicate delivery, restart recovery, failed model output, missing evidence, embedding failure/retry, project separation, forget suppression and stale recall clearing. Verify real reference ingest and the route/UI contracts using controlled fixtures. Run the relevant existing suites, type checks, lint and builds. Real-provider semantic quality and native platform behavior must be reported separately from fixtures.
