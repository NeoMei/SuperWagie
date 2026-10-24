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
- The live clock and optional weather share the heading's date/task summary
  row. The row can use the full page width and wrap without splitting the
  clock; unavailable weather leaves no separator or placeholder. The calendar
  retains its title, view switch and dates, and grows with its content.
- Task editor columns and date/time fields follow their available width,
  including when tasks share the main column with sticky notes. Long filter
  groups scroll horizontally without shrinking their option labels.
- Save as task runs in background action mode so the message reaches the
  task-writing handler. Opening the Today panel does not deliver that action.

## Decisions

### Why language redraw preserves form state

The page already redraws its DOM from local task state. A locale-only redraw
captures and restores in-progress form edits instead of repeating bootstrap or
remounting the iframe, which would discard drafts and issue unnecessary reads.

### Why task paths remain Chinese

Existing work directories and `任务.md` are persisted filesystem contracts.
Translating their names would hide existing work, so only visible category and
navigation copy changes language.

### Why the clock and weather share the heading summary

The calendar sidebar can be only 240 pixels wide. The heading summary gives
the clock and weather the page's available width while keeping them beside
the date and task totals. The quote keeps its own column above that summary.
