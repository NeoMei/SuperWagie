# Message interaction overlays

## Ownership

`TextSelectionMenu` owns actions on a new selection. `ChatQuoteHighlightLayer`
owns retained quote marks, their anchors, and dismissal. `ChatQuoteMarkPopover`
owns the saved comment preview and editor. Message-part renderers and sandboxed
pages have their own contracts in `parts/DOCUMENTATION.md`.

The full conversation's `MessageList` owns temporary message selection. Shift
selects exportable records between the anchor and the target from the loaded
transcript, including rows outside the viewport. The selection is cleared when
the conversation is hidden or its session or directory changes. If a selected
record is retired before export, the user must reload it or start a new selection.

Multi-message export shares the on-screen prompt and answer text projection.
Markdown goes to the clipboard with role headings, and the existing message
renderer draws the same text into one PNG. PNGs use the existing file flow in
Web and Electron, the save dialog in VS Code, and the share sheet in Capacitor.
Tool and reasoning parts and standalone attachments remain in the conversation.

## Invariants

- A repository or tracker URL in user text becomes an inline chip only when it names a linked context item already carried by that message. The display normalizer keeps that association without changing stored parts; only matched items leave the attachment row. Links in code retain their attachment, and chip clicks use the existing tracker routing and permission boundaries.
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
- Grouped command details retain their original message through
  `data-chat-source-message-id` on each source's `data-chat-quote-root`.
  Selection ownership uses that source before the surrounding message row.
  A selection across sources from different messages has no message menu.
- Quote lookup includes sources drawn inside another message. Nested roots
  contribute text once, and a message's text stream excludes foreign source
  subtrees. Grouping changes preserve the existing quote anchor schema.

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

### Why grouped details retain source ownership

A shared disclosure can draw several messages inside the first message's row.
Using that row as the source assigns later selections to the wrong message and
breaks saved quotes when grouping changes. Explicit source roots preserve the
original message and text stream without adding a persisted anchor format.
