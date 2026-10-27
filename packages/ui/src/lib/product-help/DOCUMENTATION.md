# Product help

## Ownership

The assistant owns a runtime-scoped, in-memory conversation and reviewed product help browsing. Its question-mark entry in the right context rail remains available on the workbench; the workbench page has no duplicate entry. The server owns product scope, help sources, semantic lookup and action allowlists. Ordinary OpenCode sessions and project content are outside this feature.

Guidance is described in [guidance.md](guidance.md). Settings owns field values, validation and saves. While a guide opens modal Settings, the window embeds the same assistant store beside Settings so focus trapping cannot hide the instructions.

## Invariants

- Network responses are parsed before they enter UI state. Only registered target identifiers can start guidance. Executable actions use a separate strict operation enum.
- Question history never includes ordinary session history or project files. There is no persistent transcript on disk.
- Follow-up requests include at most 6 history entries of 4,000 characters each. The visible transcript retains complete answers.
- Closing and reopening a panel preserves its conversation. Clear, cancel and endpoint switches invalidate outstanding answers; late results cannot overwrite a new conversation.
- A failed request preserves its question and earlier answers. Failed article loading is visible and retryable, never an empty authoritative list.
- English and Simplified Chinese article requests are independently guarded against stale completion. Locale changes keep the conversation.
- Generation is user initiated. Hidden panels perform no polling. The help catalog is requested only when a visible panel needs it.
- Web and Electron expose the assistant. VS Code hides the server-only surface and returns 501 for its routes. Hosted mobile and Capacitor can use the server API, but their separate shells do not expose this desktop panel.

## Decisions

### Why a dedicated conversation store

Panel remounts and modal Settings share the transcript without creating a tool-enabled agent session. This also prevents product questions from reaching ordinary project history.

### Why server-owned help sources and registered actions

Models select reviewed articles, while the server supplies their text and navigation identifiers. Model output cannot introduce executable actions, arbitrary URLs or invented interface selectors.

### Why Settings temporarily embeds the same assistant

The existing Settings dialog makes the main right panel inert. Embedding the shared panel keeps guidance controls accessible without changing unrelated modal behavior.

### Why execution uses registered operations

Answers offer explicit language and appearance operations under Do it for me.
Clicking a named operation authorizes that exact settings change. Merely asking
a question, opening an article or receiving model output never executes it.
The conversation store verifies that the action belongs to the displayed answer
and permits one operation at a time across both panel mounts.

The operation runner uses existing settings persistence, verifies the saved
selection by readback, then applies it to the current interface. Failed saves or
unconfirmed reads remain retryable. Clear and runtime changes invalidate late
completion. An already submitted write may have reached its original backend;
clearing its status does not roll that write back. No action can supply scripts,
selectors, arbitrary setting keys or credentials. Web and Electron support these
operations; VS Code and mobile return an explicit unsupported result.
