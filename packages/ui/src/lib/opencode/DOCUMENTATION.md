# OpenCode message ownership

## Ownership

The client wrapper owns official wire calls and domain projection.
`message-ownership.ts` resolves parent-owned tool results for a displayed child
transcript. Session stores retain ownership of the visible child records.

## Invariants

- Ordinary message reads, pins and existence checks remain session-strict.
- `applySendSelection` is shared by sends and form continuations. Model and
  agent writes retain their captured runtime instance, including an A-to-B-to-A
  endpoint round trip, and stop before the next write after an instance change.
- Tool-content completion walks ancestors only after a normalized 404, stops
  on non-404 failure, cycles, 32 session reads or a runtime-instance change.
- Returned content is projected under the displayed session's identity.
- Completion cannot resurrect a removed message, replace newer tool parts or
  commit after store replacement or loader-generation invalidation.
- Resource availability reads `skill.use`, `mcp.use` and `plugin.use`, plus
  legacy `integration.use` rules with their exact kind prefix. Bare integration
  patterns remain account/provider policy and cannot deny unrelated resources.
- Policy documents are reversed and statements retain their order. The last
  matching resource statement decides availability.
- Destructive worktree retention reads current agent activity, pending permissions,
  forms, native inboxes and descendant background jobs through the SDK. These
  responses are parsed before idle authority is granted. Missing job support,
  malformed data, timeouts and read failures cannot establish idleness.
- Session placement reads accept a caller signal so a queued-move confirmation
  deadline also bounds the in-flight response body.
- `session.step.first-token` and `experimental.mcp.event` explicitly produce no
  sync events. Existing content/execution and MCP status/catalog events retain
  their authority.

## Decisions

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
