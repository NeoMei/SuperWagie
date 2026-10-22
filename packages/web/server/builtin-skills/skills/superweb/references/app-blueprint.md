# App route blueprint

Use for admin panels, dashboards, settings, lists, editors, and any interface
where the user works rather than browses.

## Structure

The `directions` command prints the current structure; `src/directions.ts`
(`APP_BLUEPRINT`) is the source of truth. The default screens are:

| Screen | Required | It must prove |
| --- | --- | --- |
| Application shell | yes | Where the user is, where they can go, who they are |
| Overview | yes | The most important current state |
| Primary workspace | yes | How the main task is completed |
| Actions and feedback | optional | What happens after an action |
| State coverage | yes | Empty, loading, error, disabled are designed |

## Rules

- This is a work interface, not a marketing page: no hero, no benefit cards,
  no "Get started" section.
- Shell: persistent navigation with real module names, current location, and
  account entry. On mobile, collapse navigation without hiding the current
  location.
- Numerals align. Use tabular figures for tables and metrics. Right-align
  numeric columns and show units.
- Tables: sortable/filterable only if the data supports it; otherwise show a
  clear static table. Include row actions and empty/error states.
- Forms: visible labels, inline errors, disabled state for invalid actions,
  explicit success/failure feedback.
- Loading: skeleton or progress, not a spinner over the whole app. Empty:
  explain why it is empty and what to do next. Error: say what failed and how
  to retry.
- Do not invent metrics. If there is no data source, show "尚无数据" and a
  clearly marked sample-data note; never present fabricated numbers as real.
- Density: 32–40px row heights for tables, 4px spacing grid, hairline borders.
  Quiet panels beat heavy shadows.

## Sample gate

For `app`, the sample is the shell plus one representative screen — usually the
primary workspace, not a blank dashboard. It must include the navigation,
current location, real field names, and one complete state (populated or a
well-designed empty state).

## Acceptance

The generic checks still apply: no horizontal overflow, no broken assets, no
console errors, a visible primary action, and keyboard focus. Also verify:

- The primary task can be reached in one or two obvious steps from the current
  screen.
- Numbers line up and have units.
- Disabled actions explain why.
- Empty and error states are reachable in the page (tabs, query params, or
  static examples) and do not look like broken layouts.
