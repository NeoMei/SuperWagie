# Chat turns and Activity

## Ownership

Turn projection groups display messages and produces rows for the virtualized
transcript. The message store retains the OpenCode records and live status.

## Invariants

- The Activity preference uses \`collapsed\`, \`text\` (Show notes) and
  \`summary\` (Expanded). Both folded modes draw one Activity header. Show
  notes also keeps visible intermediate assistant text above the final answer,
  or below the header while there is no answer. Opening the fold restores those
  notes to their original steps. Accepted pages retain their existing placement.
- A kept note uses its source message and part for selection and viewport
  restoration. Its stream phase follows the source step, with an ended part
  already ready to draw.
- The retry overlay uses live status and the last idle timestamp. A recorded
  error requires OpenCode's retry marker on that current assistant step before
  the overlay can suppress it. Idle removes the overlay. A successful step
  completion clears the old retry marker and error in the message store.

- Activity phases follow source part order across assistant messages. Up to five lookups join the next edit or the preceding edit or run. A trailing lookup phase stays separate while the turn is live.
- A leading thought joins the next phase. Later thoughts stay with the open phase. Plain-text reasoning stays inline, and hidden thoughts cannot own a visible row. Standalone thoughts, questions, pages, background commands and failures retain their own rows.
- Row slicing, size estimates and the folded preview count each phase once. Message links keep their source identity. Reasoning search opens the row that renders the thought, even when its source also owns a separate answer row.

## Decisions

Show notes uses the existing page projection so the fold, row identities and
live activity window are shared across both folded modes. Ordinary notes and
form summaries kept with them do not become boundaries for the live window.
