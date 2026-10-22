# Direction library

Twelve short recipes. Three are extracted per task, compatible with the route,
deterministically from a seed (default: `taskId`). The same seed reproduces the
same three.

A direction is a recipe, not a template. It fixes the visual argument; the
agent derives layout and content from the brief.

| ID | Essence | Routes |
| --- | --- | --- |
| `editorial-swiss` | Strict grid, grotesk type, paper white, one signal accent, almost no motion. Information is the decoration. | page, app |
| `brutalist-raw` | Exposed structure, system/mono type, thick borders, hard offset shadows, instant state changes. | page, app |
| `quiet-luxury` | Generous whitespace, high-contrast serif display, bone/brown/champagne palette, slow fades. | page |
| `technical-instrument` | Dense control panel, mono numerals, hairline panels, graphite with teal/amber status colors. | page, app |
| `warm-humanist` | Warm paper, humanist sans, real photography, soft fades, letter-like tone. | page |
| `kinetic-poster` | Oversized type, diagonal composition, acid color blocks, scroll-triggered motion. | page |
| `terminal-green` | Command-line motif, monospace, near-black with phosphor green, log-like information. | page, app |
| `magazine-collage` | Irregular grid, mixed image ratios, external captions, newsprint inks. | page |
| `japanese-ma` | Extreme negative space, small light type, narrow column, slow fades, natural muted colors. | page |
| `industrial-spec` | Exploded diagrams, dimension callouts, parameter tables, mechanical gray and safety orange. | page, app |
| `museum-label` | Museum wall label: edge whitespace, serif title, small caps labels, one collection color, no motion. | page |
| `data-narrative` | Each section answers a question; conclusion beside chart; tabular numerals; restrained chart palette. | page, app |

## How to use one

1. Read the full recipe in `设计方向.md` (concept, composition, type, palette,
   motion, suitable for, avoid).
2. Write the tokens before markup: color roles, type scale, spacing scale,
   radius, border, shadow, motion duration/easing.
3. Use the recipe's composition for every section, not just the hero. A Swiss
   hero followed by default cards is a failure.
4. Respect the "avoid" list. It exists to prevent the direction collapsing back
   into the default AI look.
5. Keep accessibility: contrast, focus rings, reduced motion, real semantics.

## Adding or changing directions

Edit `src/directions.ts` and add a test that the library still has 12 unique,
complete entries and at least six per route. Never edit a direction after a
task has confirmed it if that would silently change the confirmed design; the
task's `设计方向.md` is the record of what the user approved.

## Source

The extraction-and-direction structure is informed by MIT-licensed
`ConardLi/garden-skills` (`web-design-engineer`) and `Leonxlnx/taste-skill`.
The recipes here are original; no third-party direction text or templates are
vendored. See the README for attribution.
