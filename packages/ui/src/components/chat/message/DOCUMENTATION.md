# Message interaction overlays

## Ownership

`TextSelectionMenu` owns actions on a new selection. `ChatQuoteHighlightLayer`
owns retained quote marks, their anchors, and dismissal. `ChatQuoteMarkPopover`
owns the saved comment preview and editor. Message-part renderers and sandboxed
pages have their own contracts in `parts/DOCUMENTATION.md`.

## Invariants

- Quote previews and editors keep their complete card and controls within the
  viewport with a 12 px horizontal margin. Empty comments, unbroken text,
  repeated editing and a viewport resize follow the same rule.
- The highlight layer receives the actual popover element through its ref, so
  pointer corridors and outside presses use the displayed bounds.
- Positioning observes the rendered card width and window size only while the
  popover is mounted. It starts with a layout measurement before paint and
  removes the observer and listener on cleanup.
- Quote anchors and comment writes stay owned by their caller. A layout change
  does not change quote identity, persistence or save semantics.

| Runtime | Quote comment layout |
| --- | --- |
| Web | Clamped against the current browser viewport. |
| Electron desktop | Same shared layout inside the packaged renderer. |
| VS Code | Same shared layout inside the webview viewport. |
| Hosted mobile | Same shared layout with the narrower browser viewport. |
| Capacitor mobile | Same shared layout inside the native webview. |

## Decisions

### Why the card width participates in placement

Clamping only the quote's center lets half the card extend off screen near
an edge. Preview and editor widths differ, so placement uses the measured
fractional width and updates when the card or viewport changes. A content-sized
outer box prevents the available space on one side of the anchor from changing
the measured width while the card is repositioned.
