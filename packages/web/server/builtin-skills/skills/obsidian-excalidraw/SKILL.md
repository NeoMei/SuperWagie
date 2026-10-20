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
- `edge.arrow`: `end` (default, head at target) | `start` | `both` | `none`. Optional `edge.arrowhead` sets the head type (`arrow` default; see `references/excalidraw-schema.md` §9 for the full list: `triangle`, `bar`, `dot`, `crowfoot_*`, …).

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

### 3. Generate (always — do NOT hand-write element JSON)

```bash
python3 references/generate.py spec.json --out scene.excalidraw \
  --obsidian "<vault path>/Name.excalidraw.md"
```

Detect the vault: if any ancestor of the destination contains `.obsidian/`, it's an Obsidian vault — always emit `.excalidraw.md` via `--obsidian`. The generator guarantees valid output: explicit bound labels, **bidirectional arrow bindings** (linked), correct geometry, **no `elbowed` field**.

### 4. Visually verify (MANDATORY before delivery)

```bash
cd references && uv sync && uv run playwright install chromium   # one-time only
uv run python render.py ../scene.excalidraw -o /tmp/preview.png
```

Then inspect the PNG (vision tool / MCP). Check for: truncated labels, overlapping nodes, arrows crossing unrelated shapes, cramped spacing. If found, adjust the spec (split a layer, shorten a label, switch TB↔LR) and regenerate. Do not deliver a diagram you haven't seen.

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

1. Arrow: `startBinding`/`endBinding` = `{elementId, focus:0, gap:1}`
2. **Both endpoint shapes** list the arrow in `boundElements`
3. **Never add `elbowed`** (not even `false`) — it silently breaks linkage
4. Arrow `points` must actually reach the bound edges

## Do NOT

- Don't hand-write Excalidraw elements — use the generator.
- Don't round-trip the file through yctimlin/excalidraw.com import-export — those drop bindings and recompress. Write once via `generate.py --obsidian`.
- Don't put labels on background "zone" rectangles (Excalidraw centers them and they clash). Use `notes` for annotations.
