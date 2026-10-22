---
name: superweb
description: Create a website or web app through three explicit decision gates (direction, sample, acceptance). Use when the user asks for a landing page, product page, portfolio, event page, one-pager, admin UI, dashboard, settings screen, or any web interface that should look designed rather than templated. Produces a static index.html by default and verifies it in local Chrome.
---

# SuperWeb

Three confirmations, nothing more: **direction → sample → acceptance**.
You write the page; the `superweb` CLI owns state, decisions, Chrome checks,
and delivery. Talk to the user in Chinese; page copy follows its audience.

The user should only ever be asked three times:

1. Which of the three directions?
2. Is the sample right?
3. Does the full page pass acceptance?

Do not ask for permission between commands, for token approval, or to confirm
each file. Run the CLI yourself and move to the next gate.

## Rules

- No page code before the direction is confirmed. No full page before the
  sample is confirmed. No delivery before the user accepts.
- Never edit `superweb.json` by hand. Never silently resolve a stale revision;
  re-read state and ask the user again.
- Static HTML/CSS/JS by default. No React, Vite, or build step unless the user
  explicitly asks.
- Local assets or visibly marked placeholders. Never invent data, logos,
  testimonials, product screenshots, or CSS-drawn fake products. Never fetch
  stock images.
- Every section must answer "what does it prove". Delete filler.
- The sample uses the final fonts, colors, spacing, and real copy.

## Flow

### Start

Ask once for the brief only if it is genuinely missing: what it is, who it is
for, required content, existing assets.

```bash
superweb start --dir <task-dir> --name "<name>" --brief "<brief>"
```

If the brief is substantial, `start` writes `需求.md` **and extracts the three
directions automatically**. If the task directory already has a `需求.md` from
the creation wizard, add `--adopt-brief` and omit `--brief`; it adopts the
existing file instead of overwriting it:

```bash
superweb start --dir <task-dir> --name "<name>" --adopt-brief
```

If the brief is too thin, it stays at `brief`: fill `需求.md` with what the user
actually said, then run `superweb directions --dir <task-dir>`.

Resume with `superweb continue --dir <task-dir> --json`.

### Gate 1 — direction

Show all three directions from `设计方向.md` (concept, composition, type,
palette, motion, suitable for) and the section structure with what each section
proves. Do not choose for the user and do not blend directions.

After an explicit choice:

```bash
superweb decide --dir <task-dir> --gate direction --choice <direction-id>
```

Revision and decision ID default to the current state; no extra flags needed.
If the user wants changes to the direction after this, that is a rework, not a
silent edit.

### Gate 2 — sample

Write `预览/v0.html`:

- `page`: first viewport + one representative section.
- `app`: application shell + one representative screen.

Use the final tokens and real copy. Show the user the file or a screenshot.
Only on explicit approval:

```bash
superweb decide --dir <task-dir> --gate sample --choice accept
```

Changes stay in `v0.html`; stay at this gate until the user approves.

### Gate 3 — acceptance

Complete `预览/index.html` with all content, responsive behavior, and applicable
hover/focus/active/disabled/loading/empty/error states. Then:

```bash
superweb inspect --dir <task-dir>
```

Present the three screenshots and every issue. Show failures; never hide them.
On explicit approval:

```bash
superweb decide --dir <task-dir> --gate acceptance --choice accept
```

Acceptance **auto-generates `交付/`**. If self-contained checks fail, the
decision is kept and the command exits 1 with the offending files; fix them and
run `superweb deliver --dir <task-dir>`.

If Chrome is missing, explain the reason and let the user decide. Continuing
requires `--acknowledge-issues`; the delivery readme will say
“未完成浏览器验收”.

### Rework

```bash
superweb decide --dir <task-dir> --gate acceptance --choice rework --target full
# or --target sample, or omit --target for full
```

Keep the direction and tokens; rebuild only the affected sections. After
delivery, the same command opens a new revision; the old `交付/` is archived as
`交付-vN` on the next delivery.

## Routes

- `page`: landing, product, portfolio, event, one-pager. Detail above the fold:
  what it is, who it is for, the action. See `references/page-blueprint.md`.
- `app`: admin, dashboard, settings, list, editor. Quiet panels, aligned
  numbers, clear tables, honest empty states. See
  `references/app-blueprint.md`.
- Route is detected from the brief; override with `--route page|app` only when
  wrong. Both routes share the direction library and acceptance.

## Anti-patterns

Purple-pink gradients, glassmorphism, generic SaaS hero + three feature cards,
emoji icons, fake logo walls, invented metrics, lorem ipsum, CSS-drawn product
shots, cards inside cards, a designed hero followed by template sections.

## Commands

| Command | Purpose |
| --- | --- |
| `superweb start` | Create task; auto-extract directions when the brief is ready |
| `superweb decide` | Record a gate decision; revision/ID optional |
| `superweb inspect` | Chrome acceptance at 1440/768/390 |
| `superweb deliver` | Retry delivery (accept auto-delivers) |
| `superweb continue` | Read stage, decisions, artifacts, next action |
| `superweb status` | Read-only compact state |
| `superweb directions` | Re-extract directions when needed |

`--json` for machine output. Exit codes: `0` success, `1` acceptance/delivery
failure, `2` usage, `3` state/decision rejected, `4` Chrome unavailable.

## References

- `references/state-machine.md` — stages, revisions, rework, delivery
- `references/page-blueprint.md` / `references/app-blueprint.md` — structures
- `references/direction-library.md` — 12 recipes
- `references/acceptance.md` — checks and report
- `references/delivery.md` — self-contained rules
