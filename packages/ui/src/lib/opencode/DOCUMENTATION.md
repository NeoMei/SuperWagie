# OpenCode message ownership

## Ownership

The client wrapper owns official wire calls and domain projection.
`message-ownership.ts` resolves parent-owned tool results for a displayed child
transcript. Session stores retain ownership of the visible child records.
`tools.ts` owns tool-input accessors. Its shell summary classifier supplies
action categories for the shared command header; rendering owns translation
and execution state.

## Invariants

- Ordinary message reads, pins and existence checks remain session-strict.
- Shell summaries inspect a bounded command string without executing it or
  reading output. Inferred labels contain only action categories or validated
  executable/script names. Environment values, URLs and inline code stay out.
  Explicit legacy descriptions remain bounded labels.
- Command summaries describe an action, never its success. Foreground and
  background completion authority stays with the native tool controllers.
- `applySendSelection` is shared by sends and form continuations. Model and
  agent writes retain their captured runtime instance, including an A-to-B-to-A
  endpoint round trip, and stop before the next write after an instance change.
- Tool-content completion walks ancestors only after a normalized 404, stops
  on non-404 failure, cycles, 32 session reads or a runtime-instance change.
- Returned content is projected under the displayed session's identity.
- Completion cannot resurrect a removed message, replace newer tool parts or
  commit after store replacement or loader-generation invalidation.
- Tool completion reads through the session's owning directory and can fill an
  explicitly supplied displayed-store directory. Its default remains the owning
  directory. Request sharing includes both directories, and runtime, displayed
  store, loader generation and original part identity still guard the merge.
- Resource availability reads `skill.use`, `mcp.use` and `plugin.use`, plus
  legacy `integration.use` rules with their exact kind prefix. Bare integration
  patterns remain account/provider policy and cannot deny unrelated resources.
- Explicit creation skill activation uses OpenCode's session skill endpoint
  with `resume: false`. Its skill record precedes the first user prompt, so
  replacing that prompt retains the skill.
- Policy documents are reversed and statements retain their order. The last
  matching resource statement decides availability.
- Destructive worktree retention reads current agent activity, pending permissions,
  forms, native inboxes and descendant background jobs through the SDK. These
  responses are parsed before idle authority is granted. Missing job support,
  malformed data, timeouts and read failures cannot establish idleness.
- Session placement reads accept a caller signal so a queued-move confirmation
  deadline also bounds the in-flight response body.
- `session.step.first-token`, `experimental.mcp.event` and
  `experimental.job.updated` explicitly produce no sync events. Session,
  shell and MCP events retain authority over their corresponding live state.

- Durably sequenced execution boundaries, retry schedules and step starts
  can change live status only while current in their OpenCode event sequence.
  Space sequences are scoped separately from the host.

- Foreground Auto prompts and commands with attachments complete routing
  preflight before admitting synthetic context, including memory and skill
  instructions. A failed preflight returns staged context to the owning
  composer draft. The SDK sends the context records in their original order,
  and a missing-skill retry uses the prepared attachment result for the same
  prompt ID.
- Prompt sends and commands within a session dispatch in order. For a prompt,
  only a runtime-proxy `503` carrying
  `x-openchamber-error: opencode-unreachable` permits a transport resend. The
  bounded resend uses the same message ID, prepared attachments and Auto ticket,
  and does not send context again. An interrupt or a runtime change stops
  resends. Ambiguous transport failures go to the existing receipt check.
- When a prompt explicitly names skills, directory-scoped model defaults wait
  for location plugins before the skill catalog is read. Built-in creation
  skills that were activated on the session remain separate.

## Decisions

### Why shell summaries classify a limited command prefix

OpenCode shell input usually contains only the command, without a description.
A small quote-aware classifier can name common actions and script basenames
without a model call. Leading environment assignments and a simple `cd &&`
prefix do not name the action. Compound or unfamiliar syntax keeps a general
label instead of inferring a business result from arguments or output.

### Why ancestor reads are limited to tool completion

A child transcript can display a parent-owned result. Broadening every read
would make a pin or existence check succeed for a message outside its session.

### Why resource policies retain kind prefixes in the UI

Existing skill and MCP consumers identify resources by kind and ID. Projection
adds that kind to modern rules and preserves recognized legacy prefixes, so the
same consumers follow OpenCode 2.2 policy without widening bare integration rules.

### Why form continuations share the selection boundary

A form answer resumes its original session. Applying model and agent through
the same guarded SDK boundary preserves that session's selection without
creating a second prompt or bypassing server admission.

### Why first-token and experimental MCP frames stay outside sync

OpenCode 2.3.0 adds a provider first-token timing marker and subscription-owned
MCP payloads. The app has no first-token metric or MCP subscription consumer.
Neither frame establishes session activity, message content, permissions or
catalog changes, so projecting either into those existing states would invent
authority. Their explicit ignore cases keep the wire union exhaustive.

### Structured reply input and compaction attribution

Structured reply answers use `resumeWithSyntheticInput`, the official session
synthetic endpoint with a stable caller-minted ID, answer metadata and
`resume: true`. A staged revert must be committed before admitting that input.
The completed compaction's recorded model passes through projection unchanged;
running or failed compactions never borrow the session's current model.
