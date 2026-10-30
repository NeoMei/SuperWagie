# Agent memory

## Ownership

The runtime owns manual memory validation, scoped CRUD, capacity limits and
instruction-bearing text flags. Actions resolve project identity from the
current session directory. The Hy manual adapter owns shared ledger commits
and one-time import of the legacy memory files.

## Invariants

- Global and project memory remain separate scopes. IDs, types, creation times
  and optional originating session IDs survive import and explicit updates.
- The injected persistence owner applies each mutation to its current committed
  scope. A failed commit leaves the previously committed entries available.
- Legacy files remain unchanged after import. A durable marker also records a
  missing or empty scope, so deletion cannot restore old file content.
- An unconfigured shared backend leaves manual read/write on the local file.
  Scope serialization covers this path and the later migration. The sibling
  `.shared-state` file reserves shared authority before import; a pending or
  successful handoff forbids fallback during a later shared outage.
- An unreadable or malformed scope fails independently. It cannot authorize a
  replacement with empty memory or hide a healthy scope in `readAll`.
- Shared persistence replaces only an exact title or an explicitly named ID.
  Word overlap cannot silently merge separate manual memories.
- Instruction-bearing text remains flagged. Explicit correction rechecks the
  new title and body. Flags survive the legacy import.
- The runtime without injected persistence retains its legacy file storage and
  duplicate detection behavior for existing isolated consumers.

## Decisions

### Why manual mutations run inside the shared owner

Reading a scope and later replacing it can overwrite another runtime's completed
save. The persistence callback computes the mutation against the latest scope
inside the shared store's serialized commit.

### Why legacy files remain after import

The shared ledger becomes authoritative only after its atomic commit succeeds.
Retaining the source file preserves recovery evidence without allowing later
legacy edits or deleted entries to be imported again.
