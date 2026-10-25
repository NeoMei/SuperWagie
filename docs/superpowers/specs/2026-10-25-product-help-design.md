# Product help assistant

## Approved behavior

The user approved a product-only assistant in the right context rail, with a second entry in Workbench opening the same panel. There is no header entry or separate desktop window. Conversations survive closing and reopening the panel. Answers include help sources and registered navigation actions. Unrelated requests receive a short scope explanation. Missing documentation and unavailable generation are explicit states.

`Locate` opens a registered destination and highlights its relevant region. `Guide me` presents ordered steps with persistent highlighting, back and exit controls. Completion uses observed UI state rather than elapsed time or a presumed successful click. Navigation and guidance do not write credentials, save configuration, or execute ordinary agent tasks.

The first task guides cover configuring and testing a provider connection, and changing the interface language. The owning form reports a saved connection and a verified connection test; language completion requires successful persistence and a matching readback. Failed actions remain on the current step. A connection test does not complete purpose binding. Other help topics offer precise locations or written steps until a complete task guide exists.

## Implementation boundaries

- Shared UI owns panel state, question rendering, registered guide targets and highlight cleanup.
- The authenticated server owns bounded product help requests, reviewed bilingual help articles and optional no-tool generation through the existing configured OpenCode provider.
- Only product-assistant history, product help articles and a bounded page identifier enter generation. Project files and ordinary session history are excluded.
- Sources and actions come from a fixed catalog. Model text cannot supply selectors, coordinates, arbitrary URLs or executable actions.
- No provider selection falls back to an unrelated connected provider. Help articles remain available when generation cannot run.
- In-memory state is scoped to the active runtime and resets on endpoint changes. No question history is written to project files.
- Settings uses a modal today. While guidance is active, the same assistant is available inside that modal so instructions remain accessible.

## Runtime behavior

| Runtime | Behavior |
| --- | --- |
| Web | Right context panel and Workbench entry, authenticated help API, settings guidance. |
| Electron | Same shared UI and in-process server. No native window or IPC change. |
| VS Code | Explicit unsupported response for the server-only help API; no request falls into the OpenCode proxy. Shared UI explains availability. |
| Hosted mobile | Server API works. The separate mobile shell does not expose this desktop panel. |
| Capacitor mobile | Same as hosted mobile against its configured server. |

## Acceptance

Both desktop entries open the same assistant. A first-time user without a configured model can find model setup instructions. Product questions produce sources; unrelated questions produce no task execution. A guide highlights a real target, reports unavailable targets, and removes highlighting on exit. English and Simplified Chinese have complete UI copy. Requests from a previous runtime or cleared conversation cannot replace current state.

## Assistant execution

The user requested direct assistance in completing operations. Answers now offer
named Do it for me operations for English, Simplified Chinese, light appearance,
dark appearance and system appearance. One click performs that selected operation
through existing settings persistence and confirms the saved selection by
readback. Navigation and interactive guidance remain available.

Receiving an answer never starts a mutation. Models still select reviewed
articles; operations and parameters are fixed in the shipped catalog. Credential
entry, destructive actions and unimplemented operations remain with their owning
product forms. An operation failure is visible and retryable.
