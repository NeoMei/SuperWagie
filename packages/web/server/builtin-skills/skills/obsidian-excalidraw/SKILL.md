---
name: obsidian-excalidraw
description: Draw beautiful Excalidraw diagrams in an Obsidian vault from a plain description of nodes and relationships. Use when the user wants to create, sketch, or visualize a flow, architecture, sequence, or relationship diagram as an Excalidraw drawing that opens natively in Obsidian. Auto-layouts the diagram and themes it — the user describes WHAT, not WHERE.
version: 2.0.0
---

# obsidian-excalidraw

Make Excalidraw diagrams in Obsidian **easy** (describe nodes + edges, no coordinates) and **beautiful** (auto-layout + curated themes). Output is the Obsidian-native `.excalidraw.md` format with correctly-linked arrows (drag a shape, its arrows follow).

## When to use

The user wants a diagram drawn as Excalidraw in their Obsidian vault — a flow, architecture, data pipeline, sequence, dependency graph, mind map, etc. Trigger phrases: "draw/画 a diagram/flow/architecture", "Excalidraw", "visualize 关系/流程/架构".

## The workflow

### 1. Gather the structure
From the user's description, extract: a **title**, the **nodes** (each with a short label and a *role*), and the **edges** (from → to, optional style/label). Roles drive color — use them:
- `client` (entry point, user-facing) · `service` (processing) · `store` (database, persistence)
- `queue` (broker, buffer) · `external` (third-party, outside the system) · `decision` (branch, gate)

If unsure, default a node to `service`. Don't invent nodes the user didn't describe.

### 2. Write a spec (NO coordinates — the generator lays it out)
```json
{
  "title": "Checkout flow",
  "theme": "soft",            // soft | mono | vivid | dark  (optional, default soft)
  "direction": "TB",          // TB (top→bottom, default) | LR (left→right)
  "nodes": [
    {"id":"cart","label":"Cart","role":"client"},
    {"id":"chk","label":"Valid?","role":"decision"},
    {"id":"db","label":"Orders DB","role":"store"}
  ],
  "edges": [
    {"from":"cart","to":"chk"},
    {"from":"chk","to":"db","style":"dashed","label":"async"},
    {"from":"db","to":"cart","arrow":"both","style":"dotted"}
  ],
  "notes": [{"x":40,"y":40,"text":"v2","size":14}]
}
```
- `id`: short, unique. `label`: what's shown (can be multi-line with `\n`).
- **Role → shape**: `decision` renders as a **diamond** automatically; every other role is a rectangle. Override any node with `"shape": "rectangle" | "diamond" | "ellipse"`.
- **Fill**: override a node's fill with `"fill": "hachure"` (sketchy hatch, default `solid`). Use sparingly for emphasis.
- `edge.style`: `solid` (default) | `dashed` | `dotted`. `edge.label`: short relationship name (use sparingly).
- Dense graphs should label only the relationships that need explanation. The generator rejects more than `max(36, 4 × node count)` non-empty edge labels because automatic collision-free label routing becomes impractically expensive; split a dense graph into smaller diagrams when that limit is reached.
- `edge.arrow`: `end` (default, head at target) | `start` | `both` | `none`. Optional `edge.arrowhead` sets the head type (`arrow` default; supported values include `triangle`, `bar`, `dot`/`circle`, and `crowfoot_*`). Current `cardinality_one`, `cardinality_many`, and `cardinality_one_or_many` inputs are serialized to their Obsidian-compatible `crowfoot_*` aliases so the vendored preview remains accurate.
- Self-loops are rejected. Only one edge may connect a given node pair because parallel/reverse edges would overlap in the automatic layout; represent a two-way relationship with one edge using `"arrow": "both"`.

### 2b. Comparison / column diagrams (groups)
For side-by-side comparison (e.g. paradigms, options, categories), add `groups` and tag nodes with `group`. Each group becomes a **hachure-filled colored container** (Material tint of its role), with members stacked inside:
```json
{
  "title": "机器学习三大范式",
  "groups": [
    {"id":"sup","label":"监督学习","role":"client"},
    {"id":"unsup","label":"无监督学习","role":"store"},
    {"id":"rl","label":"强化学习","role":"queue"}
  ],
  "nodes": [
    {"id":"s1","label":"分类","group":"sup"},
    {"id":"u1","label":"聚类","group":"unsup"},
    {"id":"r1","label":"策略学习","group":"rl"}
  ],
  "edges": [{"from":"s1","to":"u1","label":"对比","style":"dashed"}]
}
```
Containers auto-size to their members and sit side by side; cross-group arrows connect on the facing edges. A group's `fill` (default `hachure`) and `role` drive its look. No `groups` → normal layered flowchart layout.

### 3. Generate

Use `references/generate.py` for element JSON. In a managed SuperWagie session,
use the injected Python executable with isolated imports:

```bash
"$SUPERWAGIE_EXCALIDRAW_PYTHON" -I -B references/generate.py spec.json --out scene.excalidraw \
  --obsidian "<vault path>/Name.excalidraw.md"
```

PowerShell uses the call operator and its environment syntax:

```powershell
& $env:SUPERWAGIE_EXCALIDRAW_PYTHON -I -B references/generate.py spec.json --out scene.excalidraw --obsidian "<vault path>/Name.excalidraw.md"
```

An ancestor containing `.obsidian/` identifies a vault. Use `--obsidian` there.
Standalone hosts without managed bindings may use Python 3.11 or newer. The
generator uses only the standard library. Keep existing diagrams and fonts.

### 4. Verify the preview before delivery

Managed preview reuses the application's Node, Playwright and Python. It needs
an existing supported Chrome or Edge on the server. Run the local multilingual
preflight, then render and inspect the actual diagram:

```bash
"$SUPERWAGIE_EXCALIDRAW_PYTHON" -I -B references/render.py --preflight
"$SUPERWAGIE_EXCALIDRAW_PYTHON" -I -B references/render.py scene.excalidraw -o preview.png
```

On PowerShell, use `& $env:SUPERWAGIE_EXCALIDRAW_PYTHON -I -B` with the same
arguments. `--browser "<absolute browser executable>"` selects Chrome or Edge
for this invocation. `CHROME_PATH` is also supported. An invalid explicit path
fails without selecting another browser. Preview never downloads a runtime.

A missing, partial or unavailable managed binding is a failed preview. Report
its remedy and keep the diagram unaccepted. Do not clear managed bindings to
silently use global packages. Do not install packages into the Hy Python runtime
or change user-global skill/browser configuration.

Standalone setup is explicit and separate. From `references`, prepare Python
with `uv sync --locked` if the user has requested setup. An already prepared
standalone Python Playwright runtime may use its installed compatible Chromium,
or an existing Chrome/Edge selected with `--browser`:

```bash
uv run python render.py --preflight --browser "<absolute browser executable>"
uv run python render.py ../scene.excalidraw -o ../preview.png --browser "<absolute browser executable>"
```

The application supplies no fresh-install browser guarantee. Hosted and mobile
clients execute on their selected server. VS Code and external OpenCode retain
the standalone route. Remote-client desktop requires no local preview runtime.

Inspect the PNG for clipped labels, overlapping nodes, misplaced arrows and
cramped spacing. Adjust the spec and regenerate when needed. An earlier PNG
survives a failed render. Successful generation alone does not satisfy visual
acceptance.

## Layout & theming (built in — don't fight it)

- **Two layout modes**: *layered* (default — Sugiyama-lite: nodes grouped by depth, each layer centered; for wide fan-outs try `direction: "LR"`) and *columns* (when `groups` are present — side-by-side hachure containers for comparison diagrams, see §2b).
- **Shapes** follow meaning: `decision` role → diamond; everything else → rectangle (override with `node.shape`). Use `ellipse` for start/end states.
- **Themes** (`references/themes.py`): `soft` (Material "50/500" tint pairings, default — the signature Excalidraw hand-drawn look), `mono` (grayscale, print-friendly), `vivid` (saturated "200/700", presentations), `dark` (Obsidian dark mode). Each role maps to a fixed hue family (client=blue, service=teal, store=indigo, queue=amber, external=gray, decision=purple); color follows meaning.
- **Look**: hand-drawn (roughness 1) + Excalifont, matching Excalidraw's native aesthetic. Typography is a fixed scale (title 34 / section 26 / node 18 / edge 13 / note 14). Don't override per-node.

## Full grammar reference

For the complete, verified Excalidraw element schema — every element type, all
enum values (`fillStyle`, `strokeStyle`, `fontFamily`, `roundness`, arrowheads),
binding semantics, and a minimum-valid-element cheat sheet — read
**`references/excalidraw-schema.md`**. Consult it before extending the generator
or when hand-writing elements is unavoidable.

## Arrow binding rules (why diagrams link correctly)

Linkage (drag a shape → arrows follow) needs **bidirectional** references — `generate.py` does this; if you ever hand-write, replicate it exactly:
1. Arrow: `startBinding`/`endBinding` = `{elementId, fixedPoint:[xRatio,yRatio], mode:"orbit"}`
2. **Both endpoint shapes** list the arrow in `boundElements`
3. Straight arrows set `elbowed:false`; elbow arrows require their additional routing fields
4. Arrow `points` must actually reach the bound edges

## Do NOT

- Don't hand-write Excalidraw elements — use the generator.
- Don't round-trip the file through yctimlin/excalidraw.com import-export — those drop bindings and recompress. Write once via `generate.py --obsidian`.
- Don't put labels on background "zone" rectangles (Excalidraw centers them and they clash). Use `notes` for annotations.
