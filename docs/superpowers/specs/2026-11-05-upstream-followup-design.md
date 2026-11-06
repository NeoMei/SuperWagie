# SuperWagie upstream follow-up

The maintainer approved the November 5 assessment. Adapt selected OpenChamber changes onto SuperWagie 2.7.59 (`73d6cb97884ddf9873cf03e06db55271d4d41d54`). The upstream reference is `0137dc30eb3022af139ef5cbe26ed2d025c6c208`; stable 2.6.1 is `ce853f415704d1bfe8d076a5cfb2caabac00fffd`.

## Accepted behavior

1. Packaged desktop runtime connection settings are delivered only to the app's own top frame through the native bridge. HTML and pending runtime scripts carry no client token.
2. Session activity belongs to authoritative directories. Restoring a window refreshes session grouping; a stale move cannot undo a newer placement. New chat agent catalogs use the chat's effective directory. Waiting interactive pages remain visible with Activity open; question text, options, and answers remain readable.
3. Large desktop attachments use a bounded path-and-size text note instead of automatic full-file ingestion. HAR and notebook sanitization remains mandatory; draft and history restoration preserve attachment semantics.
4. Terminal Chinese IME preedit appears at the cursor and copying does not cancel composition.
5. Reduce demonstrated idle work: session polling, terminal lifecycle observation, hidden-window quota/caret work, redundant catalog refreshes, and CORS preflights. Preserve authoritative-versus-partial snapshot semantics and authentication. Measure SuperWagie's production build before and after; upstream numbers are not local results.
6. Extend shortcut settings to save/find, permission responses, navigation, native menus/windows/zoom. Leader sequences also work while the modifier remains held. Preserve existing shortcuts and persisted overrides.
7. Keep Omni Viewer (`omni-viewer-core`) and the current six supported Office formats. Adapt bounded reads, cancellation, and retry where the existing flow lacks them. Upgrade the existing Omni Viewer dependency from 0.19.0 to the latest published version (verified 0.22.0). Its viewer background and controls must follow SuperWagie's resolved theme on first open and live theme changes; preserve authored document and slide colors. The maintainer explicitly excludes LibreOffice integration or a LibreOffice conversion fallback.

8. Verify and update SuperWagie-shipped skills, plugins and MCP components to their latest published version or verified upstream snapshot. Preserve all SuperWagie adaptations, local-edit protection, configuration and data. Each item needs provenance and validation; external user-defined or other-host installations are outside this bundled update.

## Compatibility boundaries

Keep OpenCode 2.2.5 and Electron 44.9.3. The maintainer authorizes the Omni Viewer upgrade and its required Word peer, plus verified updates to SuperWagie-shipped skills, plugins and MCP components. Add no unrelated dependencies. Keep Hy memory, source retrieval, UniHub identity/billing/bootstrap, product help, six Benma thinking hints, update progress/error handling, Office preview, and question/FormDock customizations. Preserve EN and zh-CN copy. Make web, desktop, VS Code, and mobile differences deliberate.

Do not import the upstream quota extension, OpenUI, chat virtual-list rewrite, codeblock execution, Electron 45, Canary, sidebar redesign, or supplemental disk file search. This work changes source and validation artifacts; release versioning, publishing, and website deployment are separate actions.

## Acceptance

Each task has focused behavioral tests and an independent review. Run shared type/lint/dead-code checks, customization tests, and affected builds once on the final combined source. Native and IME checks must distinguish controlled browser events from real operating-system input; Windows execution and installed-app acceptance are reported only if actually observed. Performance claims require comparable workloads, instrument liveness, and preserved state correctness.
