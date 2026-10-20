# Excalidraw scene grammar — verified reference

Authoritative reference for the Excalidraw `.excalidraw` JSON format, extracted
from the vendored `excalidraw-vendored.mjs` bundle (element factories `St`,
`On`, `Zb`, `kB`, `Wb`, `qt`; defaults `we`, `lt`, `Ie`, `Gi`, `ot`, `kt`, `Xi`).
Use this when extending `generate.py` or when hand-writing elements is
unavoidable.

## 1. Scene envelope

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [ /* ExcalidrawElement[] */ ],
  "appState": { "viewBackgroundColor": "#ffffff", "gridSize": null },
  "files": { /* image files, keyed by id — see §7 */ }
}
```

`appState.exportWithDarkMode` flips the exported palette; the render harness
forces it false. `files` only matters for `image` elements.

## 2. Element types

| type      | closed | holds bound text | linear | notes                                  |
|-----------|:------:|:----------------:|:------:|----------------------------------------|
| rectangle |   ✓    |        ✓         |        | default box                            |
| diamond   |   ✓    |        ✓         |        | flowchart decision; bound text uses inscribed area |
| ellipse   |   ✓    |        ✓         |        | start/end, states; bound text uses inscribed area  |
| text      |        |        —         |        | `containerId` binds it into a shape    |
| arrow     |        |        ✓         |   ✓    | has arrowheads; binding links endpoints |
| line      |        |        ✓         |   ✓    | no arrowheads; otherwise same as arrow |
| freedraw  |        |        —         |   ✓    | hand-drawn path; needs `pressures`     |
| image     |   ✓    |        —         |        | needs a `files` entry + `fileId`       |
| frame / magicframe | ✓ | — |        | groups children by containment         |
| embeddable / iframe | ✓ | — |       | external link/frame                    |

`generate.py` emits rectangle / diamond / ellipse / text / arrow. The closed
shapes (rectangle, diamond, ellipse) are the ones that bind text and arrows.

## 3. Base fields (every element — factory `St`)

Every element carries all of these. Defaults come from `we`:
`strokeColor #1e1e1e`, `backgroundColor transparent`, `fillStyle solid`,
`strokeWidth 2`, `strokeStyle solid`, `roughness 1`, `opacity 100`.

```
id            string   unique, any chars (Obsidian md strips non-alnum for the ^block)
type          string   see §2
x, y          number   top-left of bounding box (scene coords)
width, height number   bounding-box size (>= 0)
angle         number   radians, clockwise, around center (default 0)
strokeColor   string   "#hex" or "transparent"
backgroundColor string "#hex" or "transparent"
fillStyle     enum     see §4
strokeWidth   enum     1 (thin) | 2 (bold) | 4 (extra bold)
strokeStyle   enum     "solid" | "dashed" | "dotted"
roughness     enum     0 (architect) | 1 (artist) | 2 (cartoonist)
opacity       number   0..100
groupIds      string[] group nesting, outer→inner (default [])
frameId       string|null  parent frame id (default null)
index         string|null  fractional-index z-order (default null)
roundness     {type}|null  see §5
seed          number   deterministic roughness seed (any int)
version       number   mutation counter (start 1)
versionNonce  number   change token (any int)
isDeleted     boolean  default false
boundElements {id,type}[]  arrows/labels bound to this element (default null)
updated       number   epoch ms
link          string|null  hyperlink
locked        boolean  default false
customData    object|undefined  plugin payload
```

`seed` drives the hand-drawn jitter — keep it stable per element so geometry
doesn't reshuffle on reload. The generator uses a seeded RNG for this.

## 4. fillStyle values

| value        | meaning                         |
|--------------|---------------------------------|
| `solid`      | flat fill (use this for nodes)  |
| `hachure`    | diagonal hatch lines           |
| `cross-hatch`| crossed hatch lines             |
| `zigzag`     | zigzag fill                     |
| `bg`         | background-only (effectively unfilled) |

Default for shapes is `solid`; `hachure` reads as "sketchy".

## 5. roundness (corners / curves) — enum `ot`

```
{ LEGACY: 1, PROPORTIONAL_RADIUS: 2, ADAPTIVE_RADIUS: 3 }
```

- `rectangle` → `{ "type": 3 }` (ADAPTIVE_RADIUS) for rounded corners, or `null` for sharp.
- `diamond` → `null` for **sharp** vertices (classic flowchart decision); `{"type":2}` rounds the points into a "soft" diamond.
- `ellipse` → `null` or `{"type":2}` — no corners, so roundness is irrelevant.
- `arrow`/`line` → `null` for straight segments; `{ "type": 2 }` (PROPORTIONAL_RADIUS) makes a curve through the points.

The generator sets `{"type":3}` on rectangles and `{"type":3}` is harmless on
diamond/ellipse (they ignore it). Keep roundness off (`null`) on arrows unless
you want curves, because curved arrows re-route on every edit.

## 6. Linear elements (arrow / line) — factory `On`

Adds, on top of base:

```
points              [[x,y],...]   RELATIVE to the element's x,y
lastCommittedPoint  [x,y]|null    last confirmed vertex (set null)
startBinding        Binding|null  see §8
endBinding          Binding|null
startArrowhead      enum|null     see §9  (line always null)
endArrowhead        enum|null
```

- `points[0]` is conventionally `[0,0]` (the arrow's own x,y is the start).
  `width`/`height` should mirror the point span (`abs(dx)`, `abs(dy)`).
- A 2-point arrow is a straight segment; 3+ points make a polyline. Elbow
  arrows (§10) are the orthogonal-routing variant.
- `lastCommittedPoint` = `null` means "not being actively edited". Always null in generated scenes.

## 7. image element — factory `Wb`

```
fileId    string      key into scene "files"
status    string      "pending"|"saved"|"error"
scale     [sx,sy]     usually [1,1]
crop      object|null {…} or null
strokeColor "transparent"  (images have no stroke)
```

The matching `files[fileId]` entry: `{ id, mimeType, dataURL, created, lastRetrievedAt }`.
Images are out of scope for `generate.py`; noted for completeness.

## 8. Bindings (why arrows follow shapes)

A binding attaches one arrow endpoint to one shape. It is **bidirectional** —
both elements must reference each other, or dragging a shape won't move the
arrow (and Obsidian's plugin treats it as unbound).

**On the arrow** (`startBinding` / `endBinding`):
```json
{ "elementId": "<shape id>", "focus": 0, "gap": 1 }
```
- `elementId` — the bound shape's id.
- `focus` — float in `[-1, 1]`. Where on the bound edge the arrow attaches,
  `0` = center, `±1` = the corners of that edge. Use `0` for centered anchors.
- `gap` — px distance from the shape edge to the arrow tip. `1` is the standard
  "touch the edge"; increase to lift the arrowhead off the shape.

**On the shape** (`boundElements` array), list every arrow bound to it:
```json
[{ "id": "<arrow id>", "type": "arrow" }]
```

**Bound text** (a label glued to a shape or arrow) uses the same mechanism with
`type: "text"`:
- text element sets `containerId: "<shape or arrow id>"`;
- the shape/arrow lists it in `boundElements` as `{ id, type: "text" }`.

The generator wires all of this automatically. **If you hand-write, replicate
both directions exactly.**

## 9. arrowhead values

`startArrowhead` / `endArrowhead`. `null` = none.

| value                  | shape                  |
|------------------------|------------------------|
| `arrow`                | filled triangle (default end) |
| `triangle`             | outline triangle       |
| `triangle_outline`     | outline triangle (alt) |
| `bar`                  | perpendicular bar (→)| |
| `dot`                  | filled dot             |
| `circle`               | filled circle          |
| `circle_outline`       | outline circle         |
| `diamond`              | filled diamond         |
| `diamond_outline`      | outline diamond        |
| `crowfoot_one`         | ER "one"               |
| `crowfoot_many`        | ER "many"              |
| `crowfoot_one_or_many` | ER "one or many"       |

For bidirectional edges set both `startArrowhead` and `endArrowhead`. For plain
connectors set both to `null`.

## 10. Elbow arrows (orthogonal routing) — factory `Zb`

Modern Excalidraw routes arrows around shapes with right-angle segments. An
elbow arrow carries these extra fields and **must** set `elbowed: true`:

```
elbowed         true
fixedSegments   []                # user-pinned segments
startIsSpecial  false
endIsSpecial    false
points          still relative, but multi-point
```

⚠ **Obsidian caveat:** the Obsidian Excalidraw plugin historically broke
linkage when `elbowed` was present (even `false`). The generator therefore
emits straight 2-point arrows only and omits `elbowed` entirely. Do NOT add
`elbowed` to generated scenes unless you have verified the target plugin
version supports it. Prefer straight arrows + the layout doing the work.

## 11. Text element — factory `qt`

Adds, on top of base:

```
text          string     normalized text (newlines are real \n)
originalText  string     raw text incl. wrapping; default = text
fontSize      number     px (default 20)
fontFamily    enum       see §12 (default 5 = Excalifont)
textAlign     enum       "left" | "center" | "right" (default "left")
verticalAlign enum       "top" | "middle" | "bottom" (default "top")
containerId   string|null  bound shape/arrow id (null = free text)
autoResize    boolean    shrink-wrap to text (default true)
lineHeight    number     font-dependent: 1.25 (Excalifont/Virgil), 1.35 (Nunito),
                          1.15 (Helvetica/Lilita/Liberation), 1.2 (Cascadia), 1.25 (Comic Shanns)
```

For a label glued to a box: `containerId = box.id`, `textAlign: "center"`,
`verticalAlign: "middle"`, and list it on the box's `boundElements`. Excalidraw
then repositions it on the box center; for diamond/ellipse it uses the inscribed
rectangle (diamond: width/4 inset on each axis; ellipse: inset by
`width/2 * (1 - √2/2)`), so keep labels short on those shapes.

Bound-text height: 22 px per line is a safe estimate at fontSize 18.

## 12. fontFamily enum (`Ie`)

| id | name            | style          | lineHeight | status     |
|----|-----------------|----------------|:----------:|------------|
| 1  | Virgil          | hand-drawn     | 1.25       | deprecated |
| 2  | Helvetica       | sans           | 1.15       | deprecated |
| 3  | Cascadia        | mono           | 1.20       | deprecated |
| 5  | Excalifont      | hand-drawn     | 1.25       | **default**|
| 6  | Nunito          | sans           | 1.35       | current    |
| 7  | Lilita One      | display        | 1.15       | current    |
| 8  | Comic Shanns    | comic          | 1.25       | current    |
| 9  | Liberation Sans | sans (server)  | 1.15       | current    |

(4 is unused.) Use `5` (default, hand-drawn, matches Excalidraw's look) or `2`
(clean print). The render harness must have the font available or it falls back.

## 13. Color

Strings are `#rrggbb`, `#rrggbbaa`, `#rgb`, or `"transparent"`. No named colors.
Dark themes use a dark `viewBackgroundColor` + lighter stroke/text.

## 14. Minimum valid element (cheat sheet)

Rectangle with a bound label + an arrow bound to it:

```json
[
  { "id":"a","type":"rectangle","x":100,"y":100,"width":160,"height":64,
    "angle":0,"strokeColor":"#1e1e1e","backgroundColor":"transparent","fillStyle":"solid",
    "strokeWidth":2,"strokeStyle":"solid","roughness":1,"opacity":100,
    "groupIds":[],"frameId":null,"index":null,"roundness":{"type":3},
    "seed":1,"version":1,"versionNonce":1,"isDeleted":false,
    "boundElements":[
      {"id":"a-label","type":"text"},
      {"id":"arr-0","type":"arrow"}
    ],
    "updated":1700000000000,"link":null,"locked":false },

  { "id":"a-label","type":"text","x":112,"y":121,"width":136,"height":22,
    "angle":0,"strokeColor":"#1e1e1e","backgroundColor":"transparent","fillStyle":"solid",
    "strokeWidth":1,"strokeStyle":"solid","roughness":1,"opacity":100,
    "groupIds":[],"frameId":null,"index":null,"roundness":null,
    "seed":2,"version":1,"versionNonce":2,"isDeleted":false,
    "boundElements":null,"updated":1700000000000,"link":null,"locked":false,
    "text":"Cart","originalText":"Cart","fontSize":18,"fontFamily":5,
    "textAlign":"center","verticalAlign":"middle","containerId":"a",
    "autoResize":true,"lineHeight":1.25 },

  { "id":"arr-0","type":"arrow","x":260,"y":132,"width":200,"height":0,
    "angle":0,"strokeColor":"#1e1e1e","backgroundColor":"transparent","fillStyle":"solid",
    "strokeWidth":2,"strokeStyle":"solid","roughness":1,"opacity":100,
    "groupIds":[],"frameId":null,"index":null,"roundness":null,
    "seed":3,"version":1,"versionNonce":3,"isDeleted":false,
    "boundElements":null,"updated":1700000000000,"link":null,"locked":false,
    "points":[[0,0],[200,0]],"lastCommittedPoint":null,
    "startBinding":{"elementId":"a","focus":0,"gap":1},
    "endBinding":{"elementId":"b","focus":0,"gap":1},
    "startArrowhead":null,"endArrowhead":"arrow" }
]
```

## 15. Gotchas

- **`elbowed`**: omit it for Obsidian (see §10). Never emit `elbowed: false`
  "just in case" — older plugins drop the arrow's bindings when they see the key.
- **Binding is bidirectional** — forgetting the shape's `boundElements` entry is
  the #1 cause of "arrow doesn't follow when I drag".
- **`points` are relative** to the element's `x,y`, not absolute scene coords.
- **`width`/`height` must match** the point span for linear elements, or
  selection boxes and hit-testing are wrong.
- **Diamond/ellipse labels** render in the inscribed box — keep them short or
  the text overflows the visible shape.
- **`roundness` on an arrow** makes it curve; the curve re-flows on every edit.
  Leave it `null` for predictable routing.
- **`versionNonce`** should change on every edit; for generated files any
  distinct int per element is fine.
- **Obsidian `.excalidraw.md`**: frontmatter `excalidraw-plugin: parsed`, a
  `## Text Elements` section with `text ^blockid` lines, then the raw scene in a
  fenced `json` block under `## Drawing`. Round-tripping through external
  import/export strips bindings — write once via `to_obsidian_md`.
