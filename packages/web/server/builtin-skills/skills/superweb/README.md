# SuperWeb

SuperWeb is a standalone Agent Skill with a small CLI and state machine for
building websites and work interfaces through three explicit decision gates:

```
direction  ->  sample  ->  acceptance
```

It is not a page generator. The agent writes the page; the CLI owns stage
state, decisions, browser acceptance, and delivery. Default output is a static
`index.html` that opens by double-click, with no build step and no framework.

## Why gates

A one-shot prompt commits to a visual direction before the user has seen it,
then makes every later change on the whole page. SuperWeb separates the work
into decisions that are cheap to change:

1. **Direction** — three genuinely different design directions plus a content
   structure that says what each section proves.
2. **Sample** — first viewport plus one representative section (or app shell
   plus one screen), using the final tokens and real copy.
3. **Acceptance** — full page, three viewport screenshots and checks in local
   Chrome, then an explicit accept or rework decision.

Every decision carries the current `stageRevision` and a unique `decisionId`.
Stale revisions and reused decision IDs are rejected, so an old confirmation
can never be applied to a new design.

## Requirements

- Node.js 22 or newer
- Google Chrome (or Chromium) installed locally for `inspect`
- macOS, Linux, or Windows

`playwright-core` is used only to drive the locally installed Chrome. No
browser is downloaded.

## Install

```bash
git clone <this-repo> SuperWeb
cd SuperWeb
npm install

# Run from the repository:
./bin/superweb.mjs --help

# Or expose the command globally:
npm link
superweb --help
```

To install as an agent skill, place this directory in your agent's skills
directory (for OpenCode, for example `~/.config/opencode/skills/superweb`) and
keep its `node_modules` installed. The skill is independent of any host UI;
there is no OpenChamber integration in v1.

## Quick start

```bash
# start + auto-extract three directions (when the brief is substantial)
superweb start --dir ./my-site --name "书店" \
  --brief "为一间独立书店做一个介绍页，包含本周活动、营业时间和到店路线。"

# When 需求.md already exists (for example from the OpenChamber wizard):
superweb start --dir ./my-site --name "书店" --adopt-brief

# show 设计方向.md to the user, wait for the choice
superweb decide --dir ./my-site --gate direction --choice editorial-swiss

# write 预览/v0.html: first viewport + one section
superweb decide --dir ./my-site --gate sample --choice accept

# write 预览/index.html: the full page
superweb inspect --dir ./my-site
# show 验收/*.png and 验收/report.json, wait for acceptance

# acceptance also builds 交付/ automatically
superweb decide --dir ./my-site --gate acceptance --choice accept
```

Only three user confirmations: direction, sample, acceptance. `decide`
defaults `--revision` to the current state and generates a `--decision-id`
automatically. Pass them explicitly if you need an auditable, idempotent
decision ID. Use `superweb continue --dir ./my-site --json` to resume.

## Routes

| Route | Covers | Blueprint |
| --- | --- | --- |
| `page` | landing pages, product pages, portfolios, event pages, one-pagers | `references/page-blueprint.md` |
| `app` | admin panels, dashboards, settings, lists, editors | `references/app-blueprint.md` |

The route is detected from the brief and can be overridden with
`--route page|app`. Both routes share the direction library, state machine,
browser checks, and delivery layout.

## CLI

```
superweb start      --dir <dir> [--name <name>] [--route page|app]
                    [--brief <text> | --brief-file <path> | --adopt-brief]
superweb directions --dir <dir> [--seed <seed>]
superweb decide     --dir <dir> --gate direction|sample|acceptance
                    --choice <id|accept|rework>
                    [--revision <n>] [--decision-id <id>]
                    [--target full|sample] [--acknowledge-issues]
superweb inspect    --dir <dir> [--chrome <path>] [--timeout <ms>]
superweb deliver    --dir <dir>
superweb continue   --dir <dir> [--json]
superweb status     --dir <dir> [--json]
```

`--dir` defaults to the current directory. `--json` prints one JSON object.
`status` and `continue` never modify state.

`start` extracts directions automatically when the supplied brief has enough
content. `decide` uses the current `stageRevision` and a generated decision ID
when they are omitted; explicit values are still validated. Accepting the
acceptance gate also runs delivery.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | acceptance checks failed or delivery was refused |
| 2 | usage error |
| 3 | state/decision rejected (stale revision, wrong stage, corrupt state) |
| 4 | local Chrome unavailable |

## State

`superweb.json` is the single source of truth:

```ts
type SuperwebState = {
  version: 1;
  taskId: string;
  route: 'page' | 'app';
  stage: 'brief' | 'direction' | 'sample' | 'full' | 'acceptance' | 'delivered';
  stageRevision: number;
  briefPath: string;
  selectedDirectionId: string | null;
  decisions: Array<{
    id: string;
    gate: 'direction' | 'sample' | 'acceptance';
    revision: number;
    choice: string;
    at: string;
    acknowledgedIssues?: boolean;
  }>;
  artifacts: {
    brief?: string;
    directions?: string;
    copy?: string;
    sample?: string;
    preview?: string;
    delivery?: string;
  };
  acceptance: {
    passed: boolean;
    reportPath?: string;
    screenshots?: string[];
    browserAvailable?: boolean;
    issueCount?: number;
    checkedAt?: string;
  };
};
```

State writes are atomic. A corrupt state file is reported, never silently
reset. Unknown fields and unknown stages are rejected by the schema rather than
dropped.

Task layout:

```
需求.md
设计方向.md
文案.md                 (optional, agent-managed)
预览/
  v0.html
  index.html
  assets/
验收/
  desktop.png
  tablet.png
  mobile.png
  report.json
交付/
  index.html
  assets/
  验收/
  说明.md
superweb.json
```

## Directions

The library contains 12 short recipes. Each extraction deterministically picks
three compatible with the route from a seed (default: `taskId`), so the same
seed reproduces the same three. The recipes differ in concept, composition,
type, palette, motion, and suitable use; they intentionally avoid the default
AI look.

| ID | Name | Routes |
| --- | --- | --- |
| `editorial-swiss` | Swiss editorial | page, app |
| `brutalist-raw` | Brutalist | page, app |
| `quiet-luxury` | Quiet luxury | page |
| `technical-instrument` | Instrument panel | page, app |
| `warm-humanist` | Warm humanist | page |
| `kinetic-poster` | Kinetic poster | page |
| `terminal-green` | Terminal | page, app |
| `magazine-collage` | Magazine collage | page |
| `japanese-ma` | Ma / negative space | page |
| `industrial-spec` | Industrial spec | page, app |
| `museum-label` | Museum label | page |
| `data-narrative` | Data narrative | page, app |

See `references/direction-library.md` for the short recipes. The TypeScript
source in `src/directions.ts` is the source of truth.

## Browser acceptance

`inspect` serves `预览/` from a temporary local HTTP server and launches the
local Chrome through `playwright-core` at:

- desktop 1440 × 900
- tablet 768 × 1024
- mobile 390 × 844

At each viewport it checks:

- horizontal overflow (`scrollWidth > innerWidth`) and the offending elements
- clipped text without an ellipsis
- images that finished loading with `naturalWidth === 0`
- console errors and uncaught page errors
- a visible primary action in the first viewport
- keyboard focus moves when pressing Tab

Full-page screenshots go to `验收/desktop.png`, `tablet.png`, `mobile.png`.
`验收/report.json` is structured and includes every issue with viewport, check,
selector where available, and a human-readable message. Failures are never
hidden; the task still moves to `acceptance` so the user can review, rework, or
explicitly accept the problems.

Chrome discovery order: `--chrome`, `CHROME_PATH`, platform default paths.
When Chrome is missing, `inspect` exits `4`, writes an explainable report, and
delivery requires `--acknowledge-issues`; `说明.md` then states
“未完成浏览器验收”.

## Delivery

`deliver` requires a delivered stage and an acceptance decision; accepting the
acceptance gate runs it automatically. It checks that every asset reference is
relative, local, and exists; remote URLs, absolute paths, and missing files are
refused. The page, assets, acceptance evidence, and `说明.md` are copied into
`交付/`.

If `交付/` already exists, it is renamed to `交付-v1/`, `交付-v2/`, and so on
before the new delivery is written. Files the user already took are never
overwritten.

## Development

```bash
npm install
npm test            # Node test runner + tsx
npm run typecheck   # tsc --noEmit
npm run smoke       # CLI help
```

Tests cover the state machine and schema, seeded direction extraction, the CLI
as a black box, self-contained delivery, and browser acceptance with fixture
pages. Browser tests are skipped with a stated reason when Chrome is not
installed. See `VALIDATION.md` for the recorded v1 verification run.

## Project structure

```
SKILL.md                 Agent workflow instructions
bin/superweb.mjs         Executable entry point
src/cli.ts               CLI, argument parsing, output
src/state.ts             State machine, decisions, persistence
src/schema.ts            Zod schema and types
src/directions.ts        Direction library, blueprints, seeding, route detection
src/inspect.ts           Local server, Chrome discovery, checks, screenshots
src/delivery.ts          Self-contained check, delivery, archiving
test/                    Node test runner tests and fixtures
references/              Agent-facing reference documents
```

## Scope and non-goals

In scope: the gated workflow, static output, two routes, local Chrome
acceptance, revisioned delivery.

Out of scope for v1: OpenChamber or other client UI integration, deployment,
domains, CDNs, form backends, databases, payments, automatic stock-image
download, image generation, browser-session reading, full design-system or
Figma import, multi-user collaboration, React/Vue/Svelte scaffolding.

## Sources and licenses

SuperWeb's three-gate workflow, route split, direction extraction, and
anti-template principles were informed by two MIT-licensed projects:

- [`ConardLi/garden-skills`](https://github.com/ConardLi/garden-skills) —
  `web-design-engineer` skill (workflow structure and design-direction
  approach). MIT License.
- [`Leonxlnx/taste-skill`](https://github.com/Leonxlnx/taste-skill) — taste and
  anti-slop design principles. MIT License.

No third-party skill is copied wholesale. No scripts, templates, or documents
from those repositories are vendored here. The 12 direction recipes, the
blueprints, the CLI, the state machine, the browser checks, and all tests are
original to SuperWeb; the source projects shaped the process and the
direction structure described in the MIT-licensed material.

The MIT license texts of the source projects are available in their
repositories. SuperWeb itself is released under the MIT License; see
`LICENSE`.
