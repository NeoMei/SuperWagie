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

## Decisions

Show notes uses the existing page projection so the fold, row identities and
live activity window are shared across both folded modes. Ordinary notes and
form summaries kept with them do not become boundaries for the live window.
