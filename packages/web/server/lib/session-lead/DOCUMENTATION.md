# Session Lead

A Lead is an active top-level session with an `openchamber.lead` metadata
marker. The existing sessions registrar exposes Lead capability, brief read,
and authenticated mark, unmark, handover and take-over actions. Marking a
session also installs its OpenCode instruction entry. Failed installation
restores the previous marker. Archiving preserves the brief.

The brief is a per-session Markdown file in the private OpenChamber data
directory. Edits are applied in order against exact, unique matches. The
whole file is atomically replaced after validation. The digest is bounded,
revisioned session metadata so the current value reaches the sidebar and
chat through the existing metadata broadcast.

A Lead can dispatch work in its own directory. Work sessions stay primary
sessions with an `openchamber.leadParentID` association. The chat lists those
sessions under Associated work. The user can associate an existing session
with a Lead in the same directory or take it back without changing its
OpenCode permissions. Native subagents and forks cannot inherit a usable
Lead role, and fork repair removes both Lead metadata keys.

Lead dispatch uses the existing server session creation and prompt paths.
A new work session needs an explicit model available for background use.
The existing dispatch-results runtime records and sends its result. A
managed paid Lead receives a synthetic record with `resume: false` and can
continue on its next authenticated prompt. The result delivery checks the
parent's current provider before it wakes the session. Digest feedback
uses one ordinary user prompt with revisioned receipts in the transcript.
This keeps the existing platform admission and lets the user send answers
in more than one batch.

## Shared registration

The session service accepts `dispatchResults` and `isLeadEnabled`. Pass the
existing dispatch-results runtime and a predicate that allows managed
OpenCode with the control tool enabled. The ordinary sessions registrar
already mounts the UI routes.

Register the following actions with the managed control tool. Call
`sessionService.lead.executeTool(action, input, directory, { contextSessionId })`
using the authenticated tool caller's ID and its resolved directory. The
tool payload must not supply the caller ID.

- `lead.brief` reads with no inputs, replaces text with `brief`, or updates
  it with `edits` as a list of `{ find, replace }` objects or JSON text.
- `lead.digest` takes `needsYou`, `now`, `news` and `suggestions`. Questions
  can use `{ question, options, recommended }`.
- `lead.dispatch` takes `prompt` and optionally `title`, `model`, `agent`,
  `variant` and `sessionId`. Supply `model` when creating a work session.
- `lead.children` lists active work in the Lead's directory.

The lifecycle owner can call `sessionService.lead.removeBrief(sessionId)`
on confirmed session deletion. Retain briefs on archive.
