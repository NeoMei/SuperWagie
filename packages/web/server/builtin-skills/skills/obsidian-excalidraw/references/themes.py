"""Curated themes for obsidian-excalidraw.

A theme maps a node's *role* to a harmonious {fill, stroke} pair, and fixes a
typography scale + spacing so every diagram looks consistent without manual styling.

Pick a theme by name in the spec: {"theme": "soft", ...}. Roles are semantic
(client / service / store / queue / external / decision) — color follows meaning.

Palette philosophy: the signature Excalidraw look is HAND-DRAWN (roughness 1) on a
white board, with each role wearing a Material-Design tint pairing — a light "50"
fill under a saturated "500" stroke of the same hue. That pairing reads calm and
harmonious; it's the aesthetic the reference diagrams target.
"""

# Typography scale (px). One ladder, reused everywhere.
FONT_TITLE = 34
FONT_SECTION = 26        # group/column headers
FONT_NODE = 18
FONT_EDGE = 13
FONT_NOTE = 14

# Geometry defaults
NODE_H = 80                 # single-line node height (2:1-ish with min width)
NODE_MIN_W = 180            # never narrower than this
CHAR_W = 11                 # approx px per LATIN char for width estimation
CHAR_W_CJK = 18             # CJK / fullwidth chars are ~1 fontSize wide
NODE_PAD_X = 44             # horizontal padding inside a node
LAYER_GAP = 150             # vertical gap between layers (TB) — generous whitespace
SIBLING_GAP = 64            # horizontal gap between sibling nodes
ARROW_GAP = 1               # binding gap
# Column / zone layout (comparison diagrams)
COLUMN_W = 320              # default container width
COLUMN_GAP = 60             # gap between side-by-side containers
NODE_VGAP = 40              # vertical gap between nodes inside a column
CONTAINER_PAD = 24          # inner padding of a container
CONTAINER_TITLE_ROOM = 56   # space reserved at top for the container title

# Role → hue index (so every theme agrees on which role is which color family)
# client=blue, service=teal, store=indigo, queue=amber, external=gray, decision=purple
ROLE_ORDER = ("client", "service", "store", "queue", "external", "decision")

def _theme(board, text, fills_strokes, arrow, note, stroke_width=2):
    """Build a theme from parallel role→(fill,stroke) pairs in ROLE_ORDER."""
    return {"board": board, "text": text,
            "roles": dict(zip(ROLE_ORDER, fills_strokes)),
            "arrow": arrow, "note": note, "stroke_width": stroke_width}

THEMES = {
    # Soft — Material "50/500" tint pairings on white. The default. Calm, elegant.
    "soft": _theme(
        "#ffffff", "#1e1e1e",
        [("#e3f2fd", "#1e88e5"),   # client  — blue
         ("#e0f2f1", "#00897b"),   # service — teal
         ("#e8eaf6", "#3949ab"),   # store   — indigo
         ("#fff8e1", "#f9a825"),   # queue   — amber
         ("#f5f5f5", "#757575"),   # external— gray
         ("#f3e5f5", "#8e24aa")],  # decision— purple
        "#555555", "#6b6b6b"),

    # Mono — grayscale, ink-on-paper. Elegant, print-friendly.
    "mono": _theme(
        "#ffffff", "#1e1e1e",
        [("#f5f5f5", "#616161"),
         ("#eeeeee", "#424242"),
         ("#e0e0e0", "#212121"),
         ("#eeeeee", "#616161"),
         ("#fafafa", "#9e9e9e"),
         ("#eeeeee", "#424242")],
        "#212121", "#616161"),

    # Vivid — Material "200/700" pairings. Saturated, confident. For presentations.
    "vivid": _theme(
        "#ffffff", "#1e1e1e",
        [("#bbdefb", "#1565c0"),
         ("#b2dfdb", "#00695c"),
         ("#c5cae9", "#283593"),
         ("#ffe082", "#ff8f00"),
         ("#e0e0e0", "#616161"),
         ("#e1bee7", "#6a1b9a")],
        "#37474f", "#546e7a"),

    # Dark — deep slate board with luminous strokes over dark fills. For Obsidian dark mode.
    "dark": _theme(
        "#1e1e2e", "#e9e9f0",
        [("#1a2f4a", "#64b5f6"),
         ("#143a36", "#4db6ac"),
         ("#283148", "#7986cb"),
         ("#3d3010", "#ffb74d"),
         ("#2b2b33", "#9e9e9e"),
         ("#3a1f47", "#ba68c8")],
        "#9090a8", "#8a8aa0"),
}

DEFAULT_THEME = "soft"
DEFAULT_ROLE = "service"

def resolve(name):
    return THEMES.get(name, THEMES[DEFAULT_THEME])

def node_colors(theme, role):
    return theme["roles"].get(role, theme["roles"][DEFAULT_ROLE])

def _char_weight(c):
    """Width weight of one char: CJK/fullwidth ~1 em, latin ~0.6 em."""
    return CHAR_W_CJK if ord(c) > 0x2E80 else CHAR_W

def node_width(label):
    """Auto-size width from label length so text never truncates (CJK-aware)."""
    longest = max((sum(_char_weight(c) for c in line) for line in label.split("\n")), default=0)
    return max(NODE_MIN_W, longest + NODE_PAD_X)
