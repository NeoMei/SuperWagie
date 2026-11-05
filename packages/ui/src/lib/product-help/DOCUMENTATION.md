# Product help

## Ownership

The assistant owns a runtime-scoped, in-memory conversation and reviewed product help browsing. Its question-mark entry in the right context rail remains available on the workbench; the workbench page has no duplicate entry. The server owns product scope, help sources, semantic lookup and action allowlists. Ordinary OpenCode sessions and project content are outside this feature.

Guidance is described in [guidance.md](guidance.md). Settings owns field values, validation and saves. While a guide opens modal Settings, the window embeds the same assistant store beside Settings so focus trapping cannot hide the instructions.

## Invariants

- Network responses are parsed before they enter UI state. Only registered target identifiers can start guidance. The shipped registry covers Settings controls, application pages, context panels and About; help content cannot supply navigation code. Executable actions use a separate strict operation enum.
- Question history never includes ordinary session history or project files. There is no persistent transcript on disk.
- Follow-up requests include at most 6 history entries of 4,000 characters each. The visible transcript retains complete answers.
- Closing and reopening a panel preserves its conversation. Clear, cancel and endpoint switches invalidate outstanding answers; late results cannot overwrite a new conversation.
- A failed request preserves its question and earlier answers. Failed article loading is visible and retryable, never an empty authoritative list. A failed same-language refresh keeps the last valid articles, catalog version and successful-load time.
- English and Simplified Chinese article requests are independently guarded against stale completion. Locale changes keep the conversation and discard the previous language's article snapshot. Runtime changes discard the catalog and retire outstanding article reads, including a switch back to a previous runtime.
- The store retains the server's catalog version with each article snapshot and caches it for five minutes after a successful load. Concurrent panel reads share the pending request; a successful empty catalog replaces the previous articles. Content can change without an application release.
- Generation is user initiated. Visible panels check the catalog when opened, when the document returns to the foreground and every five minutes while focused and visible. Hidden panels and background documents stop their refresh timers. Main and embedded panels share the same cache and request guard.
- Answers retain their original text, actions and optional catalog version. A source expands to an article only when the answer and current article snapshot have the same version; otherwise its original title remains visible. Answers from older servers without a version also retain title-only sources.
- Web and Electron expose the assistant. VS Code hides the server-only surface and returns 501 for its routes. Hosted mobile and Capacitor can use the server API, but their separate shells do not expose this desktop panel.

## Decisions

### Why a dedicated conversation store

Panel remounts and modal Settings share the transcript without creating a tool-enabled agent session. This also prevents product questions from reaching ordinary project history.

### Why server-owned help sources and registered actions

Models select reviewed articles, while the server supplies their text and navigation identifiers. Model output cannot introduce executable actions, arbitrary URLs or invented interface selectors.

### Why Settings temporarily embeds the same assistant

Settings and About make the main assistant inert. Embedding shared instructions inside each modal keeps guide controls accessible. A context panel that replaces the assistant also embeds the guide; a bottom-docked assistant stays visible on main pages. These views share one guide and retain the exact clicked instructions across catalog refreshes.

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
