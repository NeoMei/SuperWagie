# Chat output folding design

## Goal

Use the current OpenChamber activity presentation for SuperWagie turns. Shell commands join the same priority activity region as thinking and tool progress. A running command exposes a bounded live output preview; once it finishes, the preview disappears into the existing collapsed activity record. The command output remains available through the normal activity and tool expansion.

## Decisions

- The existing `LiveTurnActivity` header remains the single priority header and keeps its current shimmer/breathing treatment.
- Only the latest authoritative running shell is previewed. Earlier commands remain represented by the activity summary and their normal expandable rows. When no shell is running, the current reasoning stream uses the same priority slot.
- The live preview is capped at a fixed visual height and scrolls internally. It follows new output while the reader stays at the bottom; scrolling upward pauses follow until the reader returns to the bottom.
- The preview shows plain text with command output semantics. It does not syntax-highlight every update or parse output while it is streaming.
- Completed commands do not leave an expanded output panel in the transcript. The existing activity summary and expandable tool row remain the recovery path for full output.
- The preview is read-only. Stop, permissions, forms, and command lifecycle continue to use existing authoritative state.
- Shell output uses the live shell cursor when a shell ID is available and the running tool's output metadata as a fallback while OpenCode is still publishing the foreground call. When no shell is running, the current reasoning preview is bounded in the same slot and disappears when reasoning settles.
- Web, Electron, VS Code, hosted mobile, and Capacitor consume the shared UI behavior. The mobile preview uses the same capped layout and remains touch-scrollable.

## Invariants

- A shell that is not reported as running never gets a live preview.
- Shell output reads are scoped to the running shell ID and current effective directory.
- Failed output reads preserve the last preview and retry through the existing bounded polling hook.
- The preview cannot grow the chat timeline beyond its cap.
- Full output remains available when the activity or individual tool row is expanded.
- The breathing/shimmer effect remains on the activity header only.
