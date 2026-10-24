# Workbench language

## Ownership

The workbench owns its iframe-local English and Simplified Chinese copy. The
host selects the language through SDK ready context; native menus and host
navigation labels belong to the host. `panel/i18n.ts` supplies text and date
locales to the page, rail and background action.

## Invariants

- Repeated ready events update language and theme without bootstrapping again
  or reading task files. Session and directory changes retain their existing
  refresh paths; a repeated unchanged session event does not trigger a read.
- Ready and directory events share one directory transition. A real directory
  change reloads the project catalogue before selecting its project ID. A newer
  transition supersedes pending catalogue and file results from the older one.
- A language redraw retains composer text, sticky-note drafts, unsaved task
  fields, segmented choices, selection, focus and scroll position. It does not
  write tasks, notes, schedules or sessions.
- Task titles, notes, session titles, project names and physical file paths are
  user content. Their bytes, task metadata and existing IDs do not change
  with the interface language. Newly created session attachment labels use the
  selected language. Known category labels and the display-only root
  folder caption are translated separately from their paths.
- The date selects a quote index. Both language lists have the same ordering,
  so switching languages changes the wording without choosing another quote.
- Weather translation applies only to known service labels. An unavailable
  weather result remains absent and an unknown condition is preserved.
- Calendar status sits below its title and view switch. The card grows with
  its content; the clock and month label stay intact at narrow sidebar widths.
- Task editor columns and date/time fields follow their available width,
  including when tasks share the main column with sticky notes. Long filter
  groups scroll horizontally without shrinking their option labels.

## Decisions

### Why language redraw preserves form state

The page already redraws its DOM from local task state. A locale-only redraw
captures and restores in-progress form edits instead of repeating bootstrap or
remounting the iframe, which would discard drafts and issue unnecessary reads.

### Why task paths remain Chinese

Existing work directories and `任务.md` are persisted filesystem contracts.
Translating their names would hide existing work, so only visible category and
navigation copy changes language.

### Why calendar status has its own row

The sidebar can be only 240 pixels wide. English clock, weather and date labels
cannot share that width with the title and view switch, so status gets a
separate row and the card uses a minimum height instead of a fixed height.
