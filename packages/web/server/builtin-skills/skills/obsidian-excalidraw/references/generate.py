#!/usr/bin/env python3
"""obsidian-excalidraw generator — turn a minimal spec into a beautiful, correctly-linked
Excalidraw diagram for Obsidian. Pure stdlib; no coordinates required.

The spec is deliberately tiny — you describe *what*, the generator handles *where*
(auto layout) and *how* (themes, bindings, geometry):

{
  "title": "Checkout flow",            // optional
  "theme": "soft",                     // soft | mono | vivid | dark (optional, default soft)
  "direction": "TB",                   // TB (top→bottom, default) | LR (left→right)
  "nodes": [
    {"id":"cart","label":"Cart","role":"client"},
    {"id":"chk","label":"Valid?","role":"decision"},   # decision role -> diamond automatically
    {"id":"ok","label":"OK","shape":"ellipse"},          # explicit shape: rectangle|diamond|ellipse
    {"id":"db","label":"Orders DB","role":"store"}
  ],
  "edges": [
    {"from":"cart","to":"chk"},
    {"from":"chk","to":"ok","style":"dotted"},            # style: solid|dashed|dotted
    {"from":"ok","to":"db","arrow":"both"},                # arrow: end(default)|start|both|none
    {"from":"db","to":"cart","arrowhead":"triangle"}       # arrowhead type (default "arrow")
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
import argparse
import hashlib
import heapq
import json
import math
import os
import re
import shutil
import sys
import tempfile
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import themes as T
from scene_limits import validate_scene_geometry


def _pairwise(items):
    """Yield adjacent pairs without requiring Python 3.10's itertools.pairwise."""
    iterator = iter(items)
    try:
        previous = next(iterator)
    except StopIteration:
        return
    for current in iterator:
        yield previous, current
        previous = current


def _nonce(element_id, purpose):
    """Return a stable positive roughness nonce derived from an element ID."""
    digest = hashlib.sha256(f"{purpose}:{element_id}".encode()).digest()
    return int.from_bytes(digest[:4], "big") or 1

def _base(el):
    # fill defaults WITHOUT clobbering caller values (so style/strokeWidth etc. stick)
    for k, v in {"angle":0,"strokeWidth":2,"strokeStyle":"solid","roughness":1,"opacity":100,
        "groupIds":[],"frameId":None,"index":None,"roundness":None,
        "seed":_nonce(el.get("id", ""), "seed"),"version":1,
        "versionNonce":_nonce(el.get("id", ""), "version"),"isDeleted":False,
        "updated":1700000000000,"link":None,"locked":False}.items():
        el.setdefault(k, v)
    if el.get("type") == "text":
        el.setdefault("autoResize", True)
    return el

def _text_id(key, used_ids):
    """Return the stable 8-char ID required by Obsidian Excalidraw text blocks."""
    salt = 0
    while True:
        source = key if salt == 0 else f"{key}:{salt}"
        candidate = hashlib.sha256(source.encode("utf-8")).hexdigest()[:8]
        if candidate not in used_ids:
            used_ids.add(candidate)
            return candidate
        salt += 1

# role → default shape. `decision` reads as a diamond (flowchart semantics);
# every other role is a rectangle unless the node sets `shape` explicitly.
SHAPE_BY_ROLE = {"decision": "diamond"}
VALID_SHAPES = ("rectangle", "diamond", "ellipse")
VALID_DIRECTIONS = ("TB", "LR")
VALID_FILL_STYLES = ("solid", "hachure", "cross-hatch", "zigzag")
VALID_STROKE_STYLES = ("solid", "dashed", "dotted")
VALID_ARROW_MODES = ("end", "start", "both", "none")
RENDERER_ARROWHEAD_ALIASES = {
    "cardinality_one": "crowfoot_one",
    "cardinality_many": "crowfoot_many",
    "cardinality_one_or_many": "crowfoot_one_or_many",
}
SUPPORTED_ARROWHEADS = {
    "arrow", "bar", "dot", "circle", "circle_outline", "triangle",
    "triangle_outline", "diamond", "diamond_outline", "crowfoot_one",
    "crowfoot_many", "crowfoot_one_or_many",
}
MAX_INPUT_COORDINATE = 1_000_000
MAX_INPUT_DIMENSION = 100_000
MAX_FONT_SIZE = 512
MIN_DENSE_LABEL_BUDGET = 36
LABELED_EDGES_PER_NODE_BUDGET = 4

def _require_utf8(value, field):
    """Reject lone surrogates before hashing, layout, or file output."""
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError(f"{field} must be valid UTF-8") from error

def _utf16_code_units(value):
    """Return JavaScript's string length for a validated Unicode string."""
    return sum(2 if ord(character) > 0xFFFF else 1 for character in value)

def _is_javascript_whitespace(character):
    """Match ECMAScript WhiteSpace and LineTerminator code points."""
    return (
        character in "\t\n\v\f\r\u2028\u2029\ufeff"
        or unicodedata.category(character) == "Zs"
    )

def _contains_js_block_reference_delimiter(value):
    r"""Mirror the plugin's `/\s\^(.{8})[\n]+/` UTF-16 matching."""
    for index, character in enumerate(value):
        if (
            character != "^"
            or index == 0
            or not _is_javascript_whitespace(value[index-1])
        ):
            continue
        newline = value.find("\n", index+1)
        if newline == -1:
            continue
        candidate = value[index+1:newline]
        if (
            not any(terminator in candidate for terminator in ("\r", "\u2028", "\u2029"))
            and _utf16_code_units(candidate) == 8
        ):
            return True
    return False

def _contains_js_element_link_record(value, element_ids, utf16_offset=0):
    """Mirror JS's multiline 8-code-unit element-link record recognition."""
    encoded = value.encode("utf-16-le")
    encoded_ids = {
        element_id.encode("utf-16-le")
        for element_id in element_ids
        if _utf16_code_units(element_id) == 8
    }
    units = [
        encoded[index] | (encoded[index + 1] << 8)
        for index in range(0, len(encoded), 2)
    ]
    line_start = min(utf16_offset, len(units))
    for index in range(line_start, len(units) + 1):
        if index < len(units) and units[index] not in (0x0A, 0x0D, 0x2028, 0x2029):
            continue
        if index - line_start >= 9 and units[line_start + 8] == ord(":"):
            candidate = encoded[line_start * 2:(line_start + 8) * 2]
            if candidate in encoded_ids:
                return True
        line_start = index + 1
    return False

def _node_shape(n):
    """Pick a node's Excalidraw shape: explicit node.shape > role mapping > rectangle."""
    sh = n.get("shape")
    if sh in VALID_SHAPES:
        return sh
    return SHAPE_BY_ROLE.get(n.get("role", T.DEFAULT_ROLE), "rectangle")

def _node_dimensions(n):
    """Size a node so its label fits inside the shape's usable inner region."""
    label = n.get("label", n["id"])
    shape = _node_shape(n)
    width = T.node_width(label)
    height = T.node_height(label)
    inner_factor = {"diamond": 0.5, "ellipse": 0.7}.get(shape)
    if inner_factor:
        natural_width = T.text_width(label, T.FONT_NODE) + 2 * T.NODE_PAD_Y
        natural_height = T.text_height(label, T.FONT_NODE) + 2 * T.NODE_PAD_Y
        width = max(width, math.ceil(natural_width / inner_factor))
        height = max(height, math.ceil(natural_height / inner_factor))
    return width, height

def _label_box(shape, x, y, w, h, label):
    """Inscribed label box for a shape (diamond/ellipse text renders in a smaller area)."""
    th = T.text_height(label, T.FONT_NODE)
    lw = {"diamond": w * 0.5, "ellipse": w * 0.7}.get(shape, w - 24)
    return x + (w - lw) / 2, y + h / 2 - th / 2, lw, th

def _fixed_point(geometry, anchor):
    """Convert a scene anchor to Excalidraw's element-relative binding ratio."""
    x, y, w, h = geometry
    ax, ay = anchor
    return [round((ax - x) / w, 6), round((ay - y) / h, 6)]

def _edge_label_size(edge):
    label = edge.get("label")
    if not label:
        return 0, 0
    return (
        T.text_width(label, T.FONT_EDGE, padding=20, minimum=80),
        T.text_height(label, T.FONT_EDGE, minimum=20),
    )

def _edge_label_extents(edges):
    sizes = [_edge_label_size(edge) for edge in edges]
    return (
        max((width for width, _ in sizes), default=0),
        max((height for _, height in sizes), default=0),
    )

def _validate_spec(spec):
    """Reject invalid documented inputs before layout silently changes their meaning."""
    if not isinstance(spec, dict):
        raise ValueError("spec must be a JSON object")  # noqa: TRY004 - one CLI validation type

    collections = {}
    for name in ("nodes", "edges", "notes", "groups"):
        value = spec.get(name, [])
        if not isinstance(value, list):
            raise ValueError(f"{name} must be a list")  # noqa: TRY004
        if any(not isinstance(item, dict) for item in value):
            raise ValueError(f"every {name} item must be an object")
        collections[name] = value
    nodes = collections["nodes"]
    edges = collections["edges"]
    notes = collections["notes"]
    groups = collections["groups"]

    title = spec.get("title")
    if title is not None and not isinstance(title, str):
        raise ValueError("title must be a string")
    if title is not None:
        _require_utf8(title, "title")
    theme_name = spec.get("theme", T.DEFAULT_THEME)
    if not isinstance(theme_name, str) or theme_name not in T.THEMES:
        raise ValueError(f"theme must be one of {tuple(T.THEMES)}: {theme_name!r}")
    direction = spec.get("direction", "TB")
    if direction not in VALID_DIRECTIONS:
        raise ValueError(f"direction must be one of {VALID_DIRECTIONS}: {direction!r}")

    node_ids = [node.get("id") for node in nodes]
    group_ids = [group.get("id") for group in groups]
    for kind, element_ids in (("node", node_ids), ("group", group_ids)):
        if any(not isinstance(element_id, str) or not element_id for element_id in element_ids):
            raise ValueError(f"{kind} id must be a non-empty string")
        for element_id in element_ids:
            _require_utf8(element_id, f"{kind} id")
        if len(element_ids) != len(set(element_ids)):
            raise ValueError(f"duplicate {kind} ids")

    known_groups = set(group_ids)
    for node in nodes:
        if "label" in node and not isinstance(node["label"], str):
            raise ValueError(f"node {node['id']!r} label must be a string")
        if "label" in node:
            _require_utf8(node["label"], f"node {node['id']!r} label")
        if "role" in node and node["role"] not in T.ROLE_ORDER:
            raise ValueError(f"node role must be one of {T.ROLE_ORDER}: {node['role']!r}")
        if "shape" in node and node["shape"] not in VALID_SHAPES:
            raise ValueError(f"shape must be one of {VALID_SHAPES}: {node['shape']!r}")
        if "fill" in node and node["fill"] not in VALID_FILL_STYLES:
            raise ValueError(f"fill must be one of {VALID_FILL_STYLES}: {node['fill']!r}")
        if node.get("group") is not None:
            if not isinstance(node["group"], str):
                raise ValueError(f"node {node['id']!r} group must be a string")
            if node["group"] not in known_groups:
                raise ValueError(f"node {node['id']!r} references unknown group {node['group']!r}")

    for group in groups:
        if "label" in group and not isinstance(group["label"], str):
            raise ValueError(f"group {group['id']!r} label must be a string")
        if "label" in group:
            _require_utf8(group["label"], f"group {group['id']!r} label")
        if "role" in group and group["role"] not in T.ROLE_ORDER:
            raise ValueError(f"group role must be one of {T.ROLE_ORDER}: {group['role']!r}")
        if "fill" in group and group["fill"] not in VALID_FILL_STYLES:
            raise ValueError(f"fill must be one of {VALID_FILL_STYLES}: {group['fill']!r}")

    def finite_number(value):
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
        )

    for index, note in enumerate(notes):
        if not isinstance(note.get("text"), str):
            raise ValueError(f"note {index} text must be a string")  # noqa: TRY004
        _require_utf8(note["text"], f"note {index} text")
        for coordinate in ("x", "y"):
            if not finite_number(note.get(coordinate)):
                raise ValueError(f"note {index} {coordinate} must be a finite number")
            if abs(note[coordinate]) > MAX_INPUT_COORDINATE:
                raise ValueError(f"note {index} {coordinate} exceeds the safe range")
        for dimension, default, maximum in (
            ("w", 300, MAX_INPUT_DIMENSION),
            ("h", 24, MAX_INPUT_DIMENSION),
            ("size", T.FONT_NOTE, MAX_FONT_SIZE),
        ):
            value = note.get(dimension, default)
            if not finite_number(value) or value <= 0:
                raise ValueError(f"note {index} {dimension} must be a finite positive number")
            if value > maximum:
                raise ValueError(f"note {index} {dimension} exceeds the safe range")

    known_nodes = set(node_ids)
    connected_pairs = set()
    for index, edge in enumerate(edges):
        source, target = edge.get("from"), edge.get("to")
        if not isinstance(source, str) or not source:
            raise ValueError(f"edge {index} from must be a non-empty string")
        if not isinstance(target, str) or not target:
            raise ValueError(f"edge {index} to must be a non-empty string")
        if source not in known_nodes or target not in known_nodes:
            raise ValueError(f"edge {index} references unknown node: {edge}")
        if source == target:
            raise ValueError(f"edge {index} is a self-loop, which is not supported")
        pair = frozenset((source, target))
        if pair in connected_pairs:
            raise ValueError(
                "multiple edges between the same nodes would overlap; "
                "combine them into one edge and use arrow='both' if needed"
            )
        connected_pairs.add(pair)
        if "label" in edge and not isinstance(edge["label"], str):
            raise ValueError(f"edge {index} label must be a string")
        if "label" in edge:
            _require_utf8(edge["label"], f"edge {index} label")
        if edge.get("style", "solid") not in VALID_STROKE_STYLES:
            raise ValueError(
                f"edge style must be one of {VALID_STROKE_STYLES}: {edge.get('style')!r}"
            )
        if edge.get("arrow", "end") not in VALID_ARROW_MODES:
            raise ValueError(
                f"edge arrow must be one of {VALID_ARROW_MODES}: {edge.get('arrow')!r}"
            )
        requested_head = edge.get("arrowhead", "arrow")
        if not isinstance(requested_head, str):
            raise ValueError(f"edge {index} arrowhead must be a string")  # noqa: TRY004
        head = RENDERER_ARROWHEAD_ALIASES.get(requested_head, requested_head)
        if head not in SUPPORTED_ARROWHEADS:
            raise ValueError(
                f"Arrowhead {requested_head!r} is not supported by the vendored renderer"
            )

    labeled_edge_count = sum(bool(edge.get("label")) for edge in edges)
    labeled_edge_budget = max(
        MIN_DENSE_LABEL_BUDGET,
        LABELED_EDGES_PER_NODE_BUDGET * len(nodes),
    )
    if labeled_edge_count > labeled_edge_budget:
        raise ValueError(
            "too many labeled edges for automatic routing; remove some labels "
            "or split the graph into smaller diagrams"
        )

    non_text_ids = node_ids + group_ids + [f"arr-{i}" for i in range(len(edges))]
    if len(non_text_ids) != len(set(non_text_ids)):
        raise ValueError("duplicate element ids across nodes, groups, and generated arrows")
    return nodes, edges, notes, groups

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

def layout(nodes, edges, direction="TB", title_room=100):
    """Assign x,y,w,h to every node via layered (Sugiyama-lite) layout.
    Returns {id: (x,y,w,h)}. Layers are centered; whitespace is generous.
    TB: layers = rows (stack downward), centered horizontally.
    LR: layers = columns (stack rightward), centered vertically."""
    rank = _ranks(nodes, edges)
    by_rank = {}
    for n in nodes:
        by_rank.setdefault(rank[n["id"]], []).append(n)

    margin = 60
    _w = lambda n: _node_dimensions(n)[0]
    _h = lambda n: _node_dimensions(n)[1]
    edge_label_width, edge_label_height = _edge_label_extents(edges)
    horizontal_gap = max(T.SIBLING_GAP, edge_label_width + 20)
    vertical_gap = max(T.LAYER_GAP - T.NODE_H, edge_label_height + 20)
    stack_gap = max(T.NODE_VGAP, edge_label_height + 20)

    if direction == "LR":
        # each column's width = its widest node; columns spaced by that + gap (no overlap)
        col_w = {r: max((_w(n) for n in layer), default=0) for r, layer in by_rank.items()}
        max_col_h = max(
            (sum(_h(n) for n in layer) + (len(layer) - 1) * stack_gap
             for layer in by_rank.values()), default=0)
        board_h = max_col_h + 2 * margin + title_room
        geo = {}
        x = margin
        for r in sorted(by_rank):
            layer = by_rank[r]
            col_h = sum(_h(n) for n in layer) + (len(layer) - 1) * stack_gap
            y = max(title_room, (board_h - col_h) / 2)  # never overlap a tall title
            for n in layer:
                node_h = _h(n)
                geo[n["id"]] = (x, y, _w(n), node_h)
                y += node_h + stack_gap
            x += col_w[r] + horizontal_gap
        return geo

    # TB: board width = widest row (centered), so rows align on a clean center axis
    max_layer_w = max(
        (sum(_w(n) for n in layer) + horizontal_gap * (len(layer) - 1)
         for layer in by_rank.values()), default=0)
    board_w = max_layer_w + 2 * margin
    geo = {}
    y = title_room
    for r in sorted(by_rank):
        layer = by_rank[r]
        widths = [_w(n) for n in layer]
        layer_w = sum(widths) + horizontal_gap * (len(layer) - 1)
        cursor = (board_w - layer_w) / 2  # center this row horizontally
        for n, w in zip(layer, widths):
            geo[n["id"]] = (cursor, y, w, _h(n))
            cursor += w + horizontal_gap
        y += max((_h(n) for n in layer), default=T.NODE_H) + vertical_gap
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

def _segment_crosses_box(start, end, box, padding=12):
    """Return whether a segment enters a padded axis-aligned node box."""
    x1, y1 = start; x2, y2 = end
    x, y, w, h = box
    left, right = x - padding, x + w + padding
    top, bottom = y - padding, y + h + padding
    dx, dy = x2 - x1, y2 - y1
    entering, leaving = 0.0, 1.0
    for p, q in ((-dx, x1-left), (dx, right-x1), (-dy, y1-top), (dy, bottom-y1)):
        if p == 0:
            if q < 0:
                return False
            continue
        ratio = q / p
        if p < 0:
            entering = max(entering, ratio)
        else:
            leaving = min(leaving, ratio)
        if entering > leaving:
            return False
    return True

def _boxes_intersect(first, second):
    ax, ay, aw, ah = first; bx, by, bw, bh = second
    return not (
        ax + aw <= bx or bx + bw <= ax
        or ay + ah <= by or by + bh <= ay
    )

def _bound_text_anchor(path):
    """Mirror Excalidraw 0.18.1's bound-label anchor for linear elements."""
    middle = len(path) // 2
    if len(path) % 2:
        return path[middle]
    first, second = path[middle-1], path[middle]
    return ((first[0]+second[0])/2, (first[1]+second[1])/2)

def _deduplicate_adjacent_points(path):
    """Drop zero-length path segments before computing a bound-label anchor."""
    return [
        point for index, point in enumerate(path)
        if index == 0 or point != path[index-1]
    ]

def _prepare_path_for_bound_label(path, label_size, obstacles):
    """Add collinear points so Excalidraw anchors a label at a clear path location."""
    path = _deduplicate_adjacent_points(path)
    if not all(label_size):
        return path

    def label_fits(point):
        box = (
            point[0]-label_size[0]/2,
            point[1]-label_size[1]/2,
            label_size[0],
            label_size[1],
        )
        return all(not _boxes_intersect(box, obstacle) for obstacle in obstacles)

    if label_fits(_bound_text_anchor(path)):
        return path

    choices = []
    for index in range(1, len(path)-1):
        if label_fits(path[index]):
            choices.append((abs(index-(len(path)-1)/2), index, list(path)))
    for index, (start, end) in enumerate(_pairwise(path)):
        midpoint = ((start[0]+end[0])/2, (start[1]+end[1])/2)
        if label_fits(midpoint):
            candidate = [*path[:index+1], midpoint, *path[index+1:]]
            choices.append((abs((index+1)-(len(candidate)-1)/2), index+1, candidate))
    if not choices:
        return None

    _, target_index, prepared = min(choices, key=lambda choice: choice[0])
    add_before = max(0, len(prepared)-1-2*target_index)
    add_after = 2*target_index+add_before-len(prepared)+1

    if add_before:
        first, second = prepared[0], prepared[1]
        subdivisions = [
            (
                first[0]+(second[0]-first[0])*step/(add_before+1),
                first[1]+(second[1]-first[1])*step/(add_before+1),
            )
            for step in range(1, add_before+1)
        ]
        prepared = [first, *subdivisions, *prepared[1:]]
    if add_after:
        first, second = prepared[-2], prepared[-1]
        subdivisions = [
            (
                first[0]+(second[0]-first[0])*step/(add_after+1),
                first[1]+(second[1]-first[1])*step/(add_after+1),
            )
            for step in range(1, add_after+1)
        ]
        prepared = [*prepared[:-1], *subdivisions, second]
    return prepared

def _route_edge(
    geo, source, target, default_start, default_end, direction,
    clearance=36, obstacle_padding=12, extra_blockers=(), label_size=(0, 0),
):
    """Route around non-endpoint nodes using a clear outer orthogonal corridor."""
    blockers = [
        box for nid, box in geo.items() if nid not in (source, target)
    ] + list(extra_blockers)

    label_obstacles = list(geo.values()) + list(extra_blockers)

    def clear(path):
        segments_clear = all(
            not _segment_crosses_box(start, end, box, obstacle_padding)
            for start, end in _pairwise(path)
            for box in blockers
        )
        if not segments_clear or not all(label_size):
            return segments_clear
        center_x, center_y = _bound_text_anchor(path)
        label_box = (
            center_x-label_size[0]/2,
            center_y-label_size[1]/2,
            label_size[0],
            label_size[1],
        )
        return all(not _boxes_intersect(label_box, box) for box in label_obstacles)

    direct = [default_start, default_end]
    if clear(direct):
        return direct

    routing_bounds = list(geo.values()) + list(extra_blockers)
    left = min(x for x, _, _, _ in routing_bounds) - clearance
    right = max(x + w for x, _, w, _ in routing_bounds) + clearance
    top = min(y for _, y, _, _ in routing_bounds) - clearance
    bottom = max(y + h for _, y, _, h in routing_bounds) + clearance
    ax, ay, aw, ah = geo[source]; bx, by, bw, bh = geo[target]
    side_paths = {
        "left": [(ax, ay+ah/2), (left, ay+ah/2), (left, by+bh/2), (bx, by+bh/2)],
        "right": [(ax+aw, ay+ah/2), (right, ay+ah/2), (right, by+bh/2), (bx+bw, by+bh/2)],
        "top": [(ax+aw/2, ay), (ax+aw/2, top), (bx+bw/2, top), (bx+bw/2, by)],
        "bottom": [(ax+aw/2, ay+ah), (ax+aw/2, bottom), (bx+bw/2, bottom), (bx+bw/2, by+bh)],
    }
    preference = ("left", "right", "top", "bottom") if direction == "TB" else ("top", "bottom", "left", "right")
    candidates = [side_paths[side] for side in preference if clear(side_paths[side])]
    if not candidates:
        perimeter_width = right - left
        perimeter_height = bottom - top
        perimeter_length = 2 * (perimeter_width + perimeter_height)

        def side_options(box):
            x, y, w, h = box
            return (
                ((x+w/2, y), (x+w/2, top), x+w/2-left),
                ((x+w, y+h/2), (right, y+h/2), perimeter_width+y+h/2-top),
                (
                    (x+w/2, y+h),
                    (x+w/2, bottom),
                    perimeter_width+perimeter_height+right-(x+w/2),
                ),
                (
                    (x, y+h/2),
                    (left, y+h/2),
                    2*perimeter_width+perimeter_height+bottom-(y+h/2),
                ),
            )

        def perimeter_point(distance):
            distance %= perimeter_length
            if distance <= perimeter_width:
                return (left+distance, top)
            distance -= perimeter_width
            if distance <= perimeter_height:
                return (right, top+distance)
            distance -= perimeter_height
            if distance <= perimeter_width:
                return (right-distance, bottom)
            distance -= perimeter_width
            return (left, bottom-distance)

        def clockwise_arc(start_distance, end_distance):
            adjusted_end = end_distance
            if adjusted_end < start_distance:
                adjusted_end += perimeter_length
            corner_distances = (
                perimeter_width,
                perimeter_width+perimeter_height,
                2*perimeter_width+perimeter_height,
                perimeter_length,
            )
            points = [perimeter_point(start_distance)]
            for loop in (0, perimeter_length):
                for corner in corner_distances:
                    candidate_distance = corner + loop
                    if start_distance < candidate_distance < adjusted_end:
                        points.append(perimeter_point(candidate_distance))
            points.append(perimeter_point(end_distance))
            return points

        perimeter_candidates = []
        for source_anchor, source_projection, source_distance in side_options(geo[source]):
            for target_anchor, target_projection, target_distance in side_options(geo[target]):
                clockwise = clockwise_arc(source_distance, target_distance)
                counterclockwise = list(reversed(clockwise_arc(target_distance, source_distance)))
                for arc in (clockwise, counterclockwise):
                    candidate = [source_anchor, source_projection, *arc[1:-1], target_projection, target_anchor]
                    candidate = [
                        point for index, point in enumerate(candidate)
                        if index == 0 or point != candidate[index-1]
                    ]
                    if clear(candidate):
                        perimeter_candidates.append(candidate)
        candidates = perimeter_candidates
    if not candidates:
        endpoint_ids = (source, target)
        graph_boxes = []
        for node_id, (x, y, w, h) in geo.items():
            padding = 0 if node_id in endpoint_ids else obstacle_padding + 1
            graph_boxes.append((x-padding, y-padding, w+2*padding, h+2*padding))
        for x, y, w, h in extra_blockers:
            padding = obstacle_padding + 1
            graph_boxes.append((x-padding, y-padding, w+2*padding, h+2*padding))

        def endpoint_anchors(box):
            x, y, w, h = box
            return ((x+w/2, y), (x+w, y+h/2), (x+w/2, y+h), (x, y+h/2))

        source_anchors = endpoint_anchors(geo[source])
        target_anchors = endpoint_anchors(geo[target])
        xs = {left, right, *(point[0] for point in source_anchors+target_anchors)}
        ys = {top, bottom, *(point[1] for point in source_anchors+target_anchors)}
        for x, y, w, h in graph_boxes:
            xs.update((x, x+w))
            ys.update((y, y+h))

        def inside_box(point, box):
            px, py = point; x, y, w, h = box
            return x < px < x+w and y < py < y+h

        graph_points = {
            (x, y) for x in xs for y in ys
            if not any(inside_box((x, y), box) for box in graph_boxes)
        }

        def graph_segment_clear(start, end):
            return all(
                not _segment_crosses_box(start, end, box, -1e-6)
                for box in graph_boxes
            )

        adjacency = {point: [] for point in graph_points}
        rows = {}
        columns = {}
        for point in graph_points:
            rows.setdefault(point[1], []).append(point)
            columns.setdefault(point[0], []).append(point)
        for points, axis in (
            ((sorted(row) for row in rows.values()), 0),
            ((sorted(column, key=lambda point: point[1]) for column in columns.values()), 1),
        ):
            for line in points:
                for first, second in _pairwise(line):
                    if graph_segment_clear(first, second):
                        distance = abs(second[axis]-first[axis])
                        adjacency[first].append((distance, second))
                        adjacency[second].append((distance, first))

        grid_candidates = []
        target_anchor_set = set(target_anchors) & graph_points
        source_anchor_set = set(source_anchors) & graph_points

        def shortest_tree(origin):
            distances = {origin: 0}
            previous = {}
            queue = [(0, origin)]
            while queue:
                distance, current = heapq.heappop(queue)
                if distance != distances[current]:
                    continue
                for step, neighbor in adjacency[current]:
                    candidate_distance = distance + step
                    if candidate_distance < distances.get(neighbor, math.inf):
                        distances[neighbor] = candidate_distance
                        previous[neighbor] = current
                        heapq.heappush(queue, (candidate_distance, neighbor))
            return distances, previous

        def reconstruct(origin, destination, distances, previous):
            if destination not in distances:
                return None
            path = [destination]
            while path[-1] != origin:
                path.append(previous[path[-1]])
            path.reverse()
            return path

        def simplify(path):
            simplified = [path[0]]
            for point in path[1:]:
                if (
                    len(simplified) >= 2
                    and (
                        simplified[-2][0] == simplified[-1][0] == point[0]
                        or simplified[-2][1] == simplified[-1][1] == point[1]
                    )
                ):
                    simplified[-1] = point
                else:
                    simplified.append(point)
            return simplified

        def accept(path):
            if path is None:
                return
            prepared = _prepare_path_for_bound_label(
                simplify(path), label_size, label_obstacles
            )
            if prepared is not None and clear(prepared):
                grid_candidates.append(prepared)

        outer_waypoints = {
            point for point in ((left, top), (right, top), (right, bottom), (left, bottom))
            if point in graph_points
        }
        waypoint_trees = {
            waypoint: shortest_tree(waypoint) for waypoint in outer_waypoints
        }
        for source_anchor in source_anchor_set:
            source_distances, source_previous = shortest_tree(source_anchor)
            for target_anchor in target_anchor_set:
                accept(reconstruct(
                    source_anchor, target_anchor, source_distances, source_previous
                ))
                for waypoint, (waypoint_distances, waypoint_previous) in waypoint_trees.items():
                    first = reconstruct(
                        source_anchor, waypoint, source_distances, source_previous
                    )
                    second = reconstruct(
                        waypoint, target_anchor, waypoint_distances, waypoint_previous
                    )
                    if first is not None and second is not None:
                        accept([*first, *second[1:]])
        candidates = grid_candidates
    if not candidates:
        if all(label_size):
            return _route_edge(
                geo, source, target, default_start, default_end, direction,
                clearance, obstacle_padding, extra_blockers, (0, 0),
            )
        raise ValueError(f"could not route edge {source!r} -> {target!r} around other nodes")
    return min(
        candidates,
        key=lambda path: sum(
            abs(end[0]-start[0]) + abs(end[1]-start[1])
            for start, end in _pairwise(path)
        ),
    )

# ---------- column / zone layout (comparison diagrams) ----------
def _layout_columns(nodes, groups, edges, title_room=100):
    """Lay nodes out in side-by-side colored containers (one per group).
    Returns (geo {id:(x,y,w,h)}, containers {gid:(x,y,w,h)})."""
    geo, containers = {}, {}
    x = 40
    placed = set()
    edge_label_width, edge_label_height = _edge_label_extents(edges)
    column_gap = max(T.COLUMN_GAP, edge_label_width + 20)
    node_gap = max(T.NODE_VGAP, edge_label_height + 20)
    for g in groups:
        gid = g["id"]
        members = [n for n in nodes if n.get("group") == gid]
        placed.update(n["id"] for n in members)
        title_width = (
            T.text_width(g["label"], T.FONT_SECTION, padding=2 * T.CONTAINER_PAD)
            if g.get("label") else 0
        )
        col_w = max(
            T.COLUMN_W,
            title_width,
            max((_node_dimensions(n)[0] for n in members), default=0)
            + 2 * T.CONTAINER_PAD,
        )
        inner_w = col_w - 2 * T.CONTAINER_PAD
        group_title_height = (
            T.text_height(g["label"], T.FONT_SECTION, minimum=30)
            if g.get("label") else 0
        )
        header_room = max(
            T.CONTAINER_TITLE_ROOM,
            14 + group_title_height + 12 if group_title_height else 0,
        )
        cy = title_room + header_room
        for n in members:
            w, node_h = _node_dimensions(n)
            w = min(w, inner_w)
            geo[n["id"]] = (x + (col_w - w)/2, cy, w, node_h)
            cy += node_h + node_gap
        cont_h = (
            (cy - node_gap) - title_room + T.CONTAINER_PAD
            if members else max(120, header_room + T.CONTAINER_PAD)
        )
        containers[gid] = (x, title_room, col_w, cont_h)
        x += col_w + column_gap
    # ungrouped nodes (in column mode) → a trailing unnamed column so nothing is dropped
    leftovers = [n for n in nodes if n["id"] not in placed]
    if leftovers:
        col_w = max(
            T.COLUMN_W,
            max((_node_dimensions(n)[0] for n in leftovers), default=0)
            + 2 * T.CONTAINER_PAD,
        )
        inner_w = col_w - 2 * T.CONTAINER_PAD
        cy = title_room + T.CONTAINER_TITLE_ROOM
        for n in leftovers:
            w, node_h = _node_dimensions(n)
            w = min(w, inner_w)
            geo[n["id"]] = (x + (col_w - w)/2, cy, w, node_h)
            cy += node_h + node_gap
    return geo, containers

# ---------- scene build ----------
def build(spec):
    nodes, edges, notes, groups = _validate_spec(spec)
    title = spec.get("title")
    theme_name = spec.get("theme", T.DEFAULT_THEME)
    theme = T.resolve(theme_name)
    direction = spec.get("direction", "TB")
    title_height = T.text_height(title, T.FONT_TITLE, minimum=40) if title else 0
    title_room = max(100, 30 + title_height + 30) if title else 100

    ids = [n["id"] for n in nodes]

    by_id = {}
    elements = []
    note_elements = []
    routing_obstacles = []
    non_text_ids = ids + [g["id"] for g in groups] + [f"arr-{i}" for i in range(len(edges))]
    text_ids = set(non_text_ids)

    use_columns = bool(groups)
    if use_columns:
        geo, containers = _layout_columns(nodes, groups, edges, title_room)
    else:
        geo = layout(nodes, edges, direction, title_room)

    if title:
        title_id = _text_id("title", text_ids)
        title_width = T.text_width(title, T.FONT_TITLE, minimum=900)
        elements.append(_base({"id":title_id,"type":"text","x":60,"y":30,"width":title_width,"height":title_height,
            "strokeColor":theme["text"],"backgroundColor":"transparent","fillStyle":"solid","strokeWidth":1,
            "fontSize":T.FONT_TITLE,"fontFamily":5,"text":title,"originalText":title,
            "textAlign":"left","verticalAlign":"top","containerId":None,"lineHeight":1.25,"boundElements":None}))
        routing_obstacles.append((60, 30, title_width, title_height))

    for i, n in enumerate(notes):
        note_id = _text_id(f"note:{i}", text_ids)
        note_size = n.get("size", T.FONT_NOTE)
        natural_note_height = T.text_height(n["text"], note_size, minimum=24)
        note_height = max(n.get("h", natural_note_height), natural_note_height)
        natural_note_width = T.text_width(n["text"], note_size)
        note_width = max(n.get("w", 300), natural_note_width)
        note_elements.append(_base({"id":note_id,"type":"text","x":n["x"],"y":n["y"],
            "width":note_width,"height":note_height,"strokeColor":theme["note"],
            "backgroundColor":"transparent","fillStyle":"solid","strokeWidth":1,
            "fontSize":note_size,"fontFamily":5,"text":n["text"],"originalText":n["text"],
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
                group_title_id = _text_id(f"group:{gid}:title", text_ids)
                group_title_height = T.text_height(g["label"], T.FONT_SECTION, minimum=30)
                elements.append(_base({"id":group_title_id,"type":"text","x":cx,"y":cy+14,"width":cw,"height":group_title_height,
                    "strokeColor":gstroke,"backgroundColor":"transparent","fillStyle":"solid","strokeWidth":1,
                    "fontSize":T.FONT_SECTION,"fontFamily":5,"text":g["label"],"originalText":g["label"],
                    "textAlign":"center","verticalAlign":"top","containerId":None,"lineHeight":1.25,"boundElements":None}))
                routing_obstacles.append((cx, cy+14, cw, group_title_height))

    # nodes with explicit bound text labels
    for n in nodes:
        nid = n["id"]; x, y, w, h = geo[nid]
        label = n.get("label", nid)
        tid = _text_id(f"node:{nid}:label", text_ids)
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
        lx, ly, lw, th = _label_box(shape, x, y, w, h, label)
        elements.append(_base({"id":tid,"type":"text","x":lx,"y":ly,"width":lw,"height":th,
            "strokeColor":theme["text"],"backgroundColor":"transparent","fillStyle":"solid","strokeWidth":1,
            "fontSize":T.FONT_NODE,"fontFamily":5,"text":label,"originalText":label,
            "textAlign":"center","verticalAlign":"middle","containerId":nid,"lineHeight":1.25,"boundElements":None}))

    # arrows — bidirectional fixed-point binding with current non-elbow schema
    for i, e in enumerate(edges):
        a, b = e["from"], e["to"]
        aid = f"arr-{i}"
        if use_columns:
            (sx, sy), (ex, ey) = _facing_anchors(geo[a], geo[b])
        else:
            (sx, sy), (ex, ey) = _anchors(geo[a], geo[b], direction)
        route_direction = direction
        if use_columns:
            route_direction = "LR" if abs(ex-sx) >= abs(ey-sy) else "TB"
        label_width, label_height = _edge_label_size(e)
        route_clearance = max(36, label_width/2 + 12, label_height/2 + 12) + i*24
        path = _route_edge(
            geo, a, b, (sx, sy), (ex, ey), route_direction, route_clearance,
            12, routing_obstacles, (label_width, label_height),
        )
        prepared_path = _prepare_path_for_bound_label(
            path,
            (label_width, label_height),
            [*geo.values(), *routing_obstacles],
        )
        if prepared_path is None:
            raise ValueError(f"could not place edge label for {a!r} -> {b!r}")
        path = prepared_path
        sx, sy = path[0]; ex, ey = path[-1]
        points = [[x-sx, y-sy] for x, y in path]
        point_xs = [point[0] for point in points]
        point_ys = [point[1] for point in points]
        # arrow: "end" (default) | "start" | "both" | "none"; arrowhead type override
        mode = e.get("arrow", "end")
        requested_head = e.get("arrowhead", "arrow")
        head = RENDERER_ARROWHEAD_ALIASES.get(requested_head, requested_head)
        if head not in SUPPORTED_ARROWHEADS:
            raise ValueError(
                f"Arrowhead {requested_head!r} is not supported by the vendored renderer"
            )
        start_head = head if mode in ("start", "both") else None
        end_head = head if mode in ("end", "both") else None
        arrow_el = _base({"id":aid,"type":"arrow","x":sx,"y":sy,
            "width":max(point_xs)-min(point_xs),"height":max(point_ys)-min(point_ys),
            "strokeColor":theme["arrow"],"backgroundColor":"transparent","fillStyle":"solid",
            "strokeStyle":e.get("style","solid"),
            "roundness":None,
            "points":points,
            "startBinding":{"elementId":a,"fixedPoint":_fixed_point(geo[a], (sx, sy)),"mode":"orbit"},
            "endBinding":{"elementId":b,"fixedPoint":_fixed_point(geo[b], (ex, ey)),"mode":"orbit"},
            "elbowed":False,
            "startArrowhead":start_head,"endArrowhead":end_head,"boundElements":None})
        arrow_label_id = _text_id(f"edge:{i}:label", text_ids) if e.get("label") else None
        if arrow_label_id:
            arrow_el["boundElements"] = [{"id":arrow_label_id,"type":"text"}]
        elements.append(arrow_el)
        by_id[a]["boundElements"].append({"id":aid,"type":"arrow"})
        by_id[b]["boundElements"].append({"id":aid,"type":"arrow"})
        if arrow_label_id:
            edge_label_width, edge_label_height = _edge_label_size(e)
            path_mid_x, path_mid_y = _bound_text_anchor(path)
            mx = path_mid_x - edge_label_width/2
            my = path_mid_y - edge_label_height/2
            elements.append(_base({"id":arrow_label_id,"type":"text","x":mx,"y":my,"width":edge_label_width,"height":edge_label_height,
                "strokeColor":theme["arrow"],"backgroundColor":"transparent","fillStyle":"solid","strokeWidth":1,
                "fontSize":T.FONT_EDGE,"fontFamily":5,"text":e["label"],"originalText":e["label"],
                "textAlign":"center","verticalAlign":"middle","containerId":aid,"lineHeight":1.25,"boundElements":None}))
            routing_obstacles.append((mx, my, edge_label_width, edge_label_height))

    # Free annotations are an overlay. Keep them after opaque group backgrounds,
    # nodes, and connectors so a valid note coordinate can never be hidden.
    elements.extend(note_elements)

    scene = {"type":"excalidraw","version":2,"source":"https://excalidraw.com",
             "elements":elements,"appState":{"theme":"dark" if theme_name == "dark" else "light",
             "viewBackgroundColor":theme["board"],"gridSize":None},"files":{}}
    validate_scene_geometry(elements)
    return scene

def _obsidian_markdown(scene):
    """Serialize and validate an Obsidian-native Markdown drawing in memory."""
    elements = scene.get("elements") if isinstance(scene, dict) else None
    if not isinstance(elements, list) or any(not isinstance(e, dict) for e in elements):
        raise ValueError("scene elements must be a list of objects")
    element_ids = [element.get("id") for element in elements]
    if any(not isinstance(element_id, str) or not element_id for element_id in element_ids):
        raise ValueError("every scene element id must be a non-empty string")
    if len(element_ids) != len(set(element_ids)):
        raise ValueError("duplicate element id in scene")
    for element_id in element_ids:
        _require_utf8(element_id, "scene element id")
    text_els = [e for e in elements if e.get("type")=="text"]
    out = ["---","excalidraw-plugin: parsed","tags: [excalidraw]","---",
           "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==","","",
           "# Excalidraw Data","","## Text Elements"]
    text_data_start = len(out)
    for e in text_els:
        if not re.fullmatch(r"[A-Za-z0-9]{8}", e["id"]):
            raise ValueError(f"Obsidian text element ID must be 8 alphanumeric characters: {e['id']!r}")
        raw_text = e.get("originalText") if e.get("originalText") is not None else e.get("text", "")
        if not isinstance(raw_text, str):
            raise ValueError(  # noqa: TRY004
                f"Text element {e['id']!r} originalText/text must be a string"
            )
        _require_utf8(raw_text, f"Text element {e['id']!r}")
        if _contains_js_block_reference_delimiter(raw_text):
            raise ValueError(
                f"Text element {e['id']!r} contains an Obsidian block-reference delimiter"
            )
        if re.search(r"(?:^|\n)#{1,2} Drawing\n", raw_text):
            raise ValueError(
                f"Text element {e['id']!r} contains a reserved Obsidian Drawing heading"
            )
        metadata_sentinels = (
            "## Element Links\n", "# Element Links\n",
            "## Embedded Files\n", "# Embedded files\n",
            "## Embedded files\n", "# Embedded Files\n",
        )
        if any(sentinel in raw_text for sentinel in metadata_sentinels):
            raise ValueError(
                f"Text element {e['id']!r} contains a reserved Obsidian metadata heading"
            )
        if "```compressed-json\n" in raw_text:
            raise ValueError(
                f"Text element {e['id']!r} contains a reserved compressed-json fence"
            )
        if _contains_js_element_link_record(raw_text, element_ids):
            raise ValueError(
                f"Text element {e['id']!r} contains a line parsed as an element-link record"
            )
        out.append(f"{raw_text} ^{e['id']}"); out.append("")
    text_elements_data = "\n".join(out[text_data_start:])
    if _contains_js_element_link_record(
        text_elements_data,
        element_ids,
        utf16_offset=15,
    ):
        raise ValueError(
            "Text Elements contain an element-link record after the plugin's "
            "missing-section offset"
        )
    try:
        scene_json = json.dumps(scene, ensure_ascii=False, allow_nan=False)
    except ValueError as error:
        raise ValueError("scene must contain only finite JSON numbers") from error
    _require_utf8(scene_json, "scene JSON")
    out += ["%%","## Drawing","```json",scene_json,"```","%%"]
    return "\n".join(out)

def _atomic_write_texts(outputs):
    """Stage outputs, preserve modes, and roll the set back if a replace fails."""
    outputs = list(outputs)
    staged = []
    originals = []
    committed = []
    retained_backups = set()
    current_umask = os.umask(0)
    os.umask(current_umask)
    default_mode = 0o666 & ~current_umask
    try:
        targets = [Path(destination) for destination, _ in outputs]
        normalized = [os.path.abspath(os.fspath(target)) for target in targets]
        if len(normalized) != len(set(normalized)):
            raise ValueError("output destinations must be unique")
        for target in targets:
            if target.is_symlink():
                raise ValueError(f"output destination must not be a symbolic link: {target}")
            if target.exists() and not target.is_file():
                raise IsADirectoryError(f"output destination is not a regular file: {target}")
        for destination, content in outputs:
            target = Path(destination)
            mode = target.stat().st_mode & 0o777 if target.exists() else default_mode
            fd, temporary = tempfile.mkstemp(
                prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent)
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as output:
                    output.write(content)
                    output.flush()
                    os.fsync(output.fileno())
            except Exception:
                try:
                    os.close(fd)
                except OSError:
                    pass
                raise
            os.chmod(temporary, mode)
            staged.append((Path(temporary), target))
        try:
            for _, target in staged:
                if target.exists():
                    backup_fd, backup_name = tempfile.mkstemp(
                        prefix=f".{target.name}.", suffix=".bak", dir=str(target.parent)
                    )
                    os.close(backup_fd)
                    backup = Path(backup_name)
                    try:
                        shutil.copy2(target, backup)
                    except Exception:
                        backup.unlink(missing_ok=True)
                        raise
                    originals.append((target, backup))
                else:
                    originals.append((target, None))
            for temporary, target in staged:
                os.replace(temporary, target)
                committed.append(target)
        except Exception as commit_error:
            rollback_errors = []
            for target, backup in reversed(originals):
                try:
                    if backup is not None and backup.exists():
                        os.replace(backup, target)
                    elif target in committed:
                        target.unlink(missing_ok=True)
                except OSError as rollback_error:
                    rollback_errors.append((target, rollback_error))
                    if backup is not None and backup.exists():
                        retained_backups.add(backup)
            if rollback_errors:
                retained = ", ".join(str(path) for path in sorted(retained_backups))
                detail = "; ".join(
                    f"{target}: {error}" for target, error in rollback_errors
                )
                raise RuntimeError(
                    f"output rollback failed ({detail}); backups retained at: {retained or 'none'}"
                ) from commit_error
            raise
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)
        for _, backup in originals:
            if backup is not None and backup not in retained_backups:
                backup.unlink(missing_ok=True)

def to_obsidian_md(scene, path):
    """Write a validated plain-json Obsidian Drawing block atomically."""
    _atomic_write_texts([(path, _obsidian_markdown(scene))])

def main():
    ap = argparse.ArgumentParser(description="obsidian-excalidraw: spec → beautiful linked Excalidraw")
    ap.add_argument("spec", help="spec JSON file, or '-' for stdin")
    ap.add_argument("--out", required=True, help="output .excalidraw path")
    ap.add_argument("--obsidian", help="also write .excalidraw.md (Obsidian native, plain-json block)")
    a = ap.parse_args()
    try:
        if a.spec != "-":
            spec_path = Path(a.spec)
            output_paths = [Path(a.out)]
            if a.obsidian:
                output_paths.append(Path(a.obsidian))
            if any(spec_path.resolve() == path.resolve() for path in output_paths):
                raise ValueError("output must not overwrite the input spec")
        spec = json.load(sys.stdin) if a.spec == "-" else json.loads(Path(a.spec).read_text(encoding="utf-8"))
        scene = build(spec)
        outputs = [(a.out, json.dumps(scene, ensure_ascii=False))]
        if a.obsidian:
            if Path(a.out).resolve() == Path(a.obsidian).resolve():
                raise ValueError("--out and --obsidian must be different files")
            outputs.append((a.obsidian, _obsidian_markdown(scene)))
        _atomic_write_texts(outputs)
    except ValueError as error:
        ap.error(str(error))
    from collections import Counter
    print(f"wrote {a.out}: {Counter(e['type'] for e in scene['elements'])}")
    if a.obsidian:
        print(f"wrote {a.obsidian} (Obsidian, plain-json block)")

if __name__ == "__main__":
    main()
