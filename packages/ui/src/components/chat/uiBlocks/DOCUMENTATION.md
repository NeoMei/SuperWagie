# Structured reply blocks

## Ownership

This module owns the upstream OpenChamber 2.7.2 native OpenUI catalog, parser,
components, field answers and reply-answer persistence. Markdown owns where a
block is drawn. Official OpenCode requests stay in `lib/opencode/client.ts`;
waiting rendered pages use the existing OpenChamber render-answer route.

## Invariants

- Assistant replies and expanded subagent replies draw `openui-lang` blocks.
  Reasoning, user text, ordinary tool output, documents, copies and image exports
  keep the source. Subagent fields remain disabled because they have no reply
  destination.
- Finished interactive blocks require valid complete input. Parser errors,
  unsupported state, query or mutation declarations, and unknown components are
  visible with folded source. A noninteractive reply can retain valid parts,
  but must list everything dropped.
- Streaming nodes retain their last validated props. Fields and buttons remain
  disabled until the block is complete and has an authoritative answer target.
- Reply choices are collected by decision before one synthetic OpenCode input
  resumes the session. Stable input IDs prevent ambiguous retries from duplicating
  input; their keys include the runtime and directory. Synthetic-message metadata restores answers after remount or reload;
  it does not create an extra user bubble.
- A staged revert is committed before an answer is admitted. Failure leaves the
  block available to retry. Runtime and store replacement must prevent an old
  answer from reaching a replacement session instance. The operation captures
  the runtime instance, manager and directory-store identity before its first
  await, then checks them before admission and before confirming the result.
- Waiting pages submit only the existing `summary` and `data` contract. This
  renderer adds no decline, deferred-page, secret or third-party execution route.
- `ImageChoice` is a reply-only image grid. Each option uses an HTTPS `image`,
  shows its `caption`, and sends its `label` as the answer to the block's
  `name`. One press answers that decision through the existing reply-answer
  path; there is no separate send step. The browser fetches image URLs with
  `referrerPolicy="no-referrer"`.
- This SDK has no extension block-frame contract. Unknown extension names follow
  the normal parser diagnostics and source fallback; the renderer never mounts
  an unapproved frame or fabricates an extension catalog.
- `@openuidev/lang-core` is pinned to 1.0.2 in the private UI package and bundled
  with the renderer. It is absent from the server dependency graph. Its install
  lifecycle script is not needed to build or render.

## Decisions

### Why the native catalog follows upstream

Using the upstream parser and components preserves validation, streaming,
charts, forms and theme behavior. A second simplified renderer would silently
lose valid content and diverge from the transcript again.

### Why unsupported capabilities keep their source

A visual restore does not grant new extension execution or server protocols.
A missing capability stays visible through the parser's normal fallback rather
than an empty page, an enabled control with no receiver, or an implicit grant.
