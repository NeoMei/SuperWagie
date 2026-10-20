#!/usr/bin/env python3
"""obsidian-excalidraw generator — turn a minimal spec into a beautiful, correctly-linked
Excalidraw diagram for Obsidian. Pure stdlib; no coordinates required.

The spec is deliberately tiny — you describe *what*, the generator handles *where*
(auto layout) and *how* (themes, bindings, geometry):

{
  "title": "Checkout flow",            // optional
  "theme": "soft",                     // soft | mono | vivid  (optional, default soft)
  "direction": "TB",                   // TB (top→bottom, default) | LR (left→right)
  "nodes": [
    {"id":"cart","label":"Cart","role":"client"},
    {"id":"chk","label":"Valid?","role":"decision"},   # decision role -> diamond automatically
    {"id":"ok","label":"OK","shape":"ellipse"},          # explicit shape: rectangle|diamond|ellipse
    {"id":"db","label":"Orders DB","role":"store"}
  ],
  "edges": [
    {"from":"cart","to":"db"},
    {"from":"db","to":"cart","style":"dotted"},           # style: solid|dashed|dotted
    {"from":"cart","to":"db","arrow":"both"},             # arrow: end(default)|start|both|none
    {"from":"cart","to":"db","arrowhead":"triangle"}      # arrowhead type (default "arrow")
  ],
  "notes": [                           // optional free-floating annotations
    {"x":40,"y":40,"text":"v2","size":14}
  ]
}

Roles → colors come from the theme (see themes.py): client / service / store / queue /
external / decision. Color follows meaning, not whim.

Usage:
  python3 generate.py spec.json --out scene.excalidraw
  python3 generate.py spec.json --out scene.excalidraw --obsidian scene.excalidraw.md
  cat spec.json | python3 generate.py - --out scene.excalidraw
"""
import json, sys, argparse, re, random
sys.path.insert(0, __file__.rsplit("/", 1)[0])
import themes as T

rng = random.Random(2026)
def _nonce(): return rng.randrange(10**9, 10**10)
def _base(el):
    # fill defaults WITHOUT clobbering caller values (so style/strokeWidth etc. stick)
    for k, v in {"angle":0,"strokeWidth":2,"strokeStyle":"solid","roughness":1,"opacity":100,
        "groupIds":[],"frameId":None,"roundness":{"type":3},"seed":_nonce(),"version":1,
        "versionNonce":_nonce(),"isDeleted":False,"updated":1700000000000,"link":None,"locked":False}.items():
        el.setdefault(k, v)
    return el

# role → default shape. `decision` reads as a diamond (flowchart semantics);
# every other role is a rectangle unless the node sets `shape` explicitly.
SHAPE_BY_ROLE = {"decision": "diamond"}
VALID_SHAPES = ("rectangle", "diamond", "ellipse")

def _node_shape(n):
    """Pick a node's Excalidraw shape: explicit node.shape > role mapping > rectangle."""
    sh = n.get("shape")
    if sh in VALID_SHAPES:
        return sh
    return SHAPE_BY_ROLE.get(n.get("role", T.DEFAULT_ROLE), "rectangle")

def _label_box(shape, x, y, w, h, nlines):
    """Inscribed label box for a shape (diamond/ellipse text renders in a smaller area)."""
    th = 22 * nlines
    lw = {"diamond": w * 0.62, "ellipse": w * 0.72}.get(shape, w - 24)
    return x + (w - lw) / 2, y + h / 2 - th / 2, lw, th

# ---------- auto layout: layered (Sugiyama-lite) ----------
def _ranks(nodes, edges):
    """Longest-path rank from sources. rank[node] = max(rank[predecessor])+1, sources=0."""
    succ = {n["id"]: [] for n in nodes}
    indeg = {n["id"]: 0 for n in nodes}
    for e in edges:
        succ[e["from"]].append(e["to"]); indeg[e["to"]] += 1
    rank = {n["id"]: 0 for n in nodes}
    # Kahn-style, but propagate max depth
    queue = [nid for nid, d in indeg.items() if d == 0]
    seen = set(queue)
    while queue:
        cur = queue.pop(0)
        for nxt in succ[cur]:
            rank[nxt] = max(rank[nxt], rank[cur] + 1)
            indeg[nxt] -= 1
            if indeg[nxt] == 0 and nxt not in seen:
                seen.add(nxt); queue.append(nxt)
    # nodes left (cycles) get a rank one beyond max
    for nid in indeg:
        if nid not in seen:
            rank[nid] = max(rank.values(), default=0) + 1
    return rank

def layout(nodes, edges, direction="TB"):
    """Assign x,y,w,h to every node via layered (Sugiyama-lite) layout.
    Returns {id: (x,y,w,h)}. Layers are centered; whitespace is generous.
    TB: layers = rows (stack downward), centered horizontally.
    LR: layers = columns (stack rightward), centered vertically."""
    rank = _ranks(nodes, edges)
    by_rank = {}
    for n in nodes:
        by_rank.setdefault(rank[n["id"]], []).append(n)

    margin = 60
    title_room = 100  # leave space at top for the title
    _w = lambda n: T.node_width(n.get("label", n["id"]))

    if direction == "LR":
        # each column's width = its widest node; columns spaced by that + gap (no overlap)
        col_w = {r: max((_w(n) for n in layer), default=0) for r, layer in by_rank.items()}
        max_col_h = max(
            (len(layer) * T.NODE_H + (len(layer) - 1) * T.NODE_VGAP
             for layer in by_rank.values()), default=0)
        board_h = max_col_h + 2 * margin + title_room
        geo = {}
        x = margin
        for r in sorted(by_rank):
            layer = by_rank[r]
            col_h = len(layer) * T.NODE_H + (len(layer) - 1) * T.NODE_VGAP
            y = (board_h - col_h) / 2  # center this column vertically
            for n in layer:
                geo[n["id"]] = (x, y, _w(n), T.NODE_H)
                y += T.NODE_H + T.NODE_VGAP
            x += col_w[r] + T.SIBLING_GAP
        return geo

    # TB: board width = widest row (centered), so rows align on a clean center axis
    max_layer_w = max(
        (sum(_w(n) for n in layer) + T.SIBLING_GAP * (len(layer) - 1)
         for layer in by_rank.values()), default=0)
    board_w = max_layer_w + 2 * margin
    geo = {}
    for r in sorted(by_rank):
        layer = by_rank[r]
        widths = [_w(n) for n in layer]
        layer_w = sum(widths) + T.SIBLING_GAP * (len(layer) - 1)
        cursor = (board_w - layer_w) / 2  # center this row horizontally
        for n, w in zip(layer, widths):
            geo[n["id"]] = (cursor, title_room + r * T.LAYER_GAP, w, T.NODE_H)
            cursor += w + T.SIBLING_GAP
    return geo

# ---------- arrow geometry ----------
def _anchors(g_from, g_to, direction):
    ax, ay, aw, ah = g_from; bx, by, bw, bh = g_to
    if direction == "LR":
        # prefer right→left; if target above/below, route bottom→top accordingly
        if bx >= ax + aw:
            return (ax+aw, ay+ah/2), (bx, by+bh/2)
        if by + bh <= ay:
            return (ax+aw/2, ay+ah), (bx+bw/2, by)
        return (ax+aw/2, ay), (bx+bw/2, by+bh)
    else:  # TB
        if by >= ay + ah:
            return (ax+aw/2, ay+ah), (bx+bw/2, by)
        if bx + bw <= ax:
            return (ax, ay+ah/2), (bx+bw, by+bh/2)
        return (ax+aw/2, ay), (bx+bw/2, by+bh)

def _facing_anchors(g_from, g_to):
    """Direction-agnostic anchors: pick the source edge facing the target center and vice versa.
    Correct for cross-column arrows where the layered TB heuristic picks the wrong edge."""
    ax, ay, aw, ah = g_from; bx, by, bw, bh = g_to
    acx, acy = ax + aw/2, ay + ah/2; bcx, bcy = bx + bw/2, by + bh/2
    dx, dy = bcx - acx, bcy - acy
    if abs(dx) >= abs(dy):                       # horizontal relationship → side edges
        return ((ax+aw, acy), (bx, bcy)) if dx >= 0 else ((ax, acy), (bx+bw, bcy))
    return ((acx, ay+ah), (bcx, by)) if dy >= 0 else ((acx, ay), (bcx, by+bh))  # vertical → top/bottom

# ---------- column / zone layout (comparison diagrams) ----------
def _layout_columns(nodes, groups):
    """Lay nodes out in side-by-side colored containers (one per group).
    Returns (geo {id:(x,y,w,h)}, containers {gid:(x,y,w,h)})."""
    geo, containers = {}, {}
    title_room = 100
    x = 40
    placed = set()
    for g in groups:
        gid = g["id"]
        members = [n for n in nodes if n.get("group") == gid]
        placed.update(n["id"] for n in members)
        col_w = max(T.COLUMN_W, max(
            (T.node_width(n.get("label", n["id"])) for n in members), default=0) + 2 * T.CONTAINER_PAD)
        inner_w = col_w - 2 * T.CONTAINER_PAD
        cy = title_room + T.CONTAINER_TITLE_ROOM
        for n in members:
            w = min(T.node_width(n.get("label", n["id"])), inner_w)
            geo[n["id"]] = (x + (col_w - w)/2, cy, w, T.NODE_H)
            cy += T.NODE_H + T.NODE_VGAP
        cont_h = (cy - T.NODE_VGAP) - title_room + T.CONTAINER_PAD if members else 120
        containers[gid] = (x, title_room, col_w, cont_h)
        x += col_w + T.COLUMN_GAP
    # ungrouped nodes (in column mode) → a trailing unnamed column so nothing is dropped
    leftovers = [n for n in nodes if n["id"] not in placed]
    if leftovers:
        col_w = max(T.COLUMN_W, max(
            (T.node_width(n.get("label", n["id"])) for n in leftovers), default=0) + 2 * T.CONTAINER_PAD)
        inner_w = col_w - 2 * T.CONTAINER_PAD
        cy = title_room + T.CONTAINER_TITLE_ROOM
        for n in leftovers:
            w = min(T.node_width(n.get("label", n["id"])), inner_w)
            geo[n["id"]] = (x + (col_w - w)/2, cy, w, T.NODE_H)
            cy += T.NODE_H + T.NODE_VGAP
        containers["__ungrouped__"] = (x, title_room, col_w, (cy - T.NODE_VGAP) - title_room + T.CONTAINER_PAD)
    return geo, containers

# ---------- scene build ----------
def build(spec):
    nodes = spec.get("nodes", [])
    edges = spec.get("edges", [])
    notes = spec.get("notes", [])
    title = spec.get("title")
    theme = T.resolve(spec.get("theme", T.DEFAULT_THEME))
    direction = spec.get("direction", "TB")

    ids = [n["id"] for n in nodes]
    if len(ids) != len(set(ids)): sys.exit("ERROR: duplicate node ids")
    nset = set(ids)
    for i, e in enumerate(edges):
        if e.get("from") not in nset or e.get("to") not in nset:
            sys.exit(f"ERROR: edge {i} references unknown node: {e}")

    by_id = {}
    elements = []

    groups = spec.get("groups")
    use_columns = bool(groups)
    if use_columns:
        geo, containers = _layout_columns(nodes, groups)
    else:
        geo = layout(nodes, edges, direction)

    if title:
        elements.append(_base({"id":"title","type":"text","x":60,"y":30,"width":900,"height":40,
            "strokeColor":theme["text"],"backgroundColor":"transparent","fillStyle":"solid","strokeWidth":1,
            "fontSize":T.FONT_TITLE,"fontFamily":5,"text":title,"originalText":title,
            "textAlign":"left","verticalAlign":"top","containerId":None,"lineHeight":1.25,"boundElements":None}))

    for i, n in enumerate(notes):
        elements.append(_base({"id":f"note-{i}","type":"text","x":n["x"],"y":n["y"],
            "width":n.get("w",300),"height":n.get("h",24),"strokeColor":theme["note"],
            "backgroundColor":"transparent","fillStyle":"solid","strokeWidth":1,
            "fontSize":n.get("size",T.FONT_NOTE),"fontFamily":5,"text":n["text"],"originalText":n["text"],
            "textAlign":"left","verticalAlign":"top","containerId":None,"lineHeight":1.25,"boundElements":None}))

    # column containers (hachure-filled zones) — drawn BEFORE nodes so nodes sit on top
    if use_columns:
        for g in groups:
            gid = g["id"]; cx, cy, cw, ch = containers[gid]
            gfill, gstroke = T.node_colors(theme, g.get("role", "client"))
            elements.append(_base({"id":gid,"type":"rectangle","x":cx,"y":cy,"width":cw,"height":ch,
                "strokeColor":gstroke,"backgroundColor":gfill,"fillStyle":g.get("fill","hachure"),
                "strokeWidth":2,"roundness":{"type":3},"boundElements":[]}))
            if g.get("label"):
                elements.append(_base({"id":f"{gid}-title","type":"text","x":cx,"y":cy+14,"width":cw,"height":30,
                    "strokeColor":gstroke,"backgroundColor":"transparent","fillStyle":"solid","strokeWidth":1,
                    "fontSize":T.FONT_SECTION,"fontFamily":5,"text":g["label"],"originalText":g["label"],
                    "textAlign":"center","verticalAlign":"top","containerId":None,"lineHeight":1.25,"boundElements":None}))

    # nodes with explicit bound text labels
    for n in nodes:
        nid = n["id"]; x, y, w, h = geo[nid]
        label = n.get("label", nid)
        tid = f"{nid}-label"
        fill, stroke = T.node_colors(theme, n.get("role", T.DEFAULT_ROLE))
        shape = _node_shape(n)
        # rectangles keep rounded corners; diamonds need SHARP vertices (roundness rounds them),
        # ellipses have no corners so roundness is irrelevant — null both.
        node_roundness = {"type":3} if shape == "rectangle" else None
        by_id[nid] = _base({"id":nid,"type":shape,"x":x,"y":y,"width":w,"height":h,
            "strokeColor":stroke,"backgroundColor":fill,"fillStyle":n.get("fill","solid"),
            "strokeWidth":theme["stroke_width"],"roundness":node_roundness,
            "boundElements":[{"id":tid,"type":"text"}]})
        elements.append(by_id[nid])
        nlines = label.count("\n") + 1
        lx, ly, lw, th = _label_box(shape, x, y, w, h, nlines)
        elements.append(_base({"id":tid,"type":"text","x":lx,"y":ly,"width":lw,"height":th,
            "strokeColor":theme["text"],"backgroundColor":"transparent","fillStyle":"solid","strokeWidth":1,
            "fontSize":T.FONT_NODE,"fontFamily":5,"text":label,"originalText":label,
            "textAlign":"center","verticalAlign":"middle","containerId":nid,"lineHeight":1.25,"boundElements":None}))

    # arrows — bidirectional binding, computed geometry, NO elbowed
    for i, e in enumerate(edges):
        a, b = e["from"], e["to"]
        aid = f"arr-{i}"
        if use_columns:
            (sx, sy), (ex, ey) = _facing_anchors(geo[a], geo[b])
        else:
            (sx, sy), (ex, ey) = _anchors(geo[a], geo[b], direction)
        dx, dy = ex - sx, ey - sy
        # arrow: "end" (default) | "start" | "both" | "none"; arrowhead type override
        mode = e.get("arrow", "end")
        head = e.get("arrowhead", "arrow")
        start_head = head if mode in ("start", "both") else None
        end_head = head if mode in ("end", "both") else None
        arrow_el = _base({"id":aid,"type":"arrow","x":sx,"y":sy,"width":abs(dx) or 1,"height":abs(dy) or 1,
            "strokeColor":theme["arrow"],"backgroundColor":"transparent","fillStyle":"solid",
            "strokeStyle":e.get("style","solid"),
            "roundness":None,
            "points":[[0,0],[dx,dy]],"lastCommittedPoint":None,
            "startBinding":{"elementId":a,"focus":0,"gap":T.ARROW_GAP},
            "endBinding":{"elementId":b,"focus":0,"gap":T.ARROW_GAP},
            "startArrowhead":start_head,"endArrowhead":end_head,"boundElements":None})
        if e.get("label"):
            arrow_el["boundElements"] = [{"id":f"{aid}-label","type":"text"}]
        elements.append(arrow_el)
        by_id[a]["boundElements"].append({"id":aid,"type":"arrow"})
        by_id[b]["boundElements"].append({"id":aid,"type":"arrow"})
        if e.get("label"):
            mx, my = (sx+ex)/2 - 40, (sy+ey)/2 - 16
            elements.append(_base({"id":f"{aid}-label","type":"text","x":mx,"y":my,"width":80,"height":20,
                "strokeColor":theme["arrow"],"backgroundColor":"transparent","fillStyle":"solid","strokeWidth":1,
                "fontSize":T.FONT_EDGE,"fontFamily":5,"text":e["label"],"originalText":e["label"],
                "textAlign":"center","verticalAlign":"middle","containerId":aid,"lineHeight":1.25,"boundElements":None}))

    return {"type":"excalidraw","version":2,"source":"https://excalidraw.com",
            "elements":elements,"appState":{"viewBackgroundColor":theme["board"],"gridSize":None},"files":{}}

def to_obsidian_md(scene, path):
    """Plain-json Drawing block (frontmatter 'parsed') — preserves bindings verbatim.
    Do NOT round-trip through middleware import/export; it drops arrow bindings."""
    def blk(eid): return re.sub(r"[^A-Za-z0-9]","",eid) or "x"
    text_els = [e for e in scene["elements"] if e.get("type")=="text"]
    out = ["---","excalidraw-plugin: parsed","tags: [excalidraw]","---",
           "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==","","",
           "# Excalidraw Data","## Text Elements"]
    for e in text_els:
        out.append(f"{(e.get('text') or '').replace(chr(10),' ')} ^{blk(e['id'])}"); out.append("")
    out += ["%%","## Drawing","```json",json.dumps(scene, ensure_ascii=False),"```","%%"]
    open(path,"w",encoding="utf-8").write("\n".join(out))

def main():
    ap = argparse.ArgumentParser(description="obsidian-excalidraw: spec → beautiful linked Excalidraw")
    ap.add_argument("spec", help="spec JSON file, or '-' for stdin")
    ap.add_argument("--out", required=True, help="output .excalidraw path")
    ap.add_argument("--obsidian", help="also write .excalidraw.md (Obsidian native, plain-json block)")
    a = ap.parse_args()
    spec = json.load(sys.stdin if a.spec == "-" else open(a.spec, encoding="utf-8"))
    scene = build(spec)
    json.dump(scene, open(a.out,"w",encoding="utf-8"), ensure_ascii=False)
    from collections import Counter
    print(f"wrote {a.out}: {Counter(e['type'] for e in scene['elements'])}")
    if a.obsidian:
        to_obsidian_md(scene, a.obsidian); print(f"wrote {a.obsidian} (Obsidian, plain-json block)")

if __name__ == "__main__":
    main()
