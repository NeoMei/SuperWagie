# Workflow UI state

## Ownership

Run and saved-workflow reads, per-session caches and panel selection belong here.
The server owns execution, admission and durable workflow records.

## Invariants

- `isWorkflowEnabled` requires server availability and persisted user opt-in.
- Disabled workflow hooks expose no held runs or saved workflows and start no
  reads. Production store loaders and reconnect reloads respect the same gate.
- The rail, open-panel wrapper, chat cards, work-status sections and direct guest
  entry share that gate. Existing tabs do not bypass it.
- Supported web, desktop and connected mobile consume the shared gate. VS Code
  and external OpenCode retain the server's explicit unsupported contract.

## Decisions

### Why support and enabled state are separate

Server support makes the setting available. The user controls whether workflow
reads and controls activate. Availability alone would create background requests
and show entrypoints even with the persisted off default.
