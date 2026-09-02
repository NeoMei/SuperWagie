# G3-REVIEW-002 isolation checklist

- [ ] `codex-never-installed`: Review shell, fixture discovery, cached-page browsing, annotations, and version confirmation start without Codex paths or services.
- [ ] `codex-installed-not-running`: no Codex process launch, IPC connection, resource read, or configuration dependency occurs.
- [ ] `codex-running`: concurrent Codex activity does not alter ports, cache keys, renderer selection, annotations, or task state.
- [ ] `codex-config-mutated`: Codex configuration changes do not change SuperWagie behavior or environment signatures.
- [x] `wps-missing`: the actual DOCX fast Adapter keeps the checked-in DOCX readable and non-eligible while PPTX enters `dependency_missing` (`20260831T091949Z-53143`).
- [x] `wps-timeout`: the fixed owned worker reaches its deadline, is reaped, publishes no cache entry, and preserves the accepted Revision (`20260831T091950Z-53161`).
- [x] `wps-crash`: the fixed owned worker's actual `WPS_RENDER_PROTOCOL_INVALID` result is surfaced, the child is reaped, no cache entry is published, and acceptance is preserved (`20260831T091951Z-53179`).
- [x] `webview-restart`: `ReviewStateStore` restores persisted annotation/accepted-Revision bytes and `rehydrateReviewShell` restores page 2/accepted state without calling `startTruthRender` (`20260831T091951Z-53197`).
- [x] `cache-corrupt`: `PreviewCache` rejects only the corrupt entry, preserves a clean neighbor, rerenders the checked-in PDF, and preserves acceptance (`20260831T091951Z-53222`).
- [x] `source-revision-changed`: the production reanchor contract leaves the frozen old annotation binding unchanged, rereads it after reanchor, and emits an explicit deterministic relocation (`20260831T091952Z-53140`).

The six checked items are fixture-local recovery-contract evidence, not real
renderer/application/font or platform evidence. Those fields remain mandatory
for the four isolation/real-WPS scenarios and the final Gate decision.
