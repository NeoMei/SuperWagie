# OpenCode message ownership

## Ownership

The client wrapper owns official wire calls and domain projection.
`message-ownership.ts` resolves parent-owned tool results for a displayed child
transcript. Session stores retain ownership of the visible child records.

## Invariants

- Ordinary message reads, pins and existence checks remain session-strict.
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

## Decisions

### Why ancestor reads are limited to tool completion

A child transcript can display a parent-owned result. Broadening every read
would make a pin or existence check succeed for a message outside its session.

### Why resource policies retain kind prefixes in the UI

Existing skill and MCP consumers identify resources by kind and ID. Projection
adds that kind to modern rules and preserves recognized legacy prefixes, so the
same consumers follow OpenCode 2.2 policy without widening bare integration rules.
