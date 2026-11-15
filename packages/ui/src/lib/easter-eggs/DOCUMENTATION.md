# Thinking status copy

## Ownership

This module owns the upstream thinking lines used by `useAgentStatusLabel`.
It supports the product's English and Simplified Chinese locales. Status
components decide where the line appears; this module owns no timers or model
activity.

## Invariants

- The reasoning part ID chooses a stable line for about one block in four.
- A missing or loading locale falls back to its ordinary translated status;
  another locale's line is never substituted.
- The lines are predicates, so the status formatter can add the model name or
  capitalize the standalone phrase without changing their identity.

## Decisions

### Why only thinking lines are loaded

Chat status parity needs this picker. Unrelated draft headings, Git toasts and
calendar features keep their existing product behavior.
