# obsidian-excalidraw

An agent skill that draws **beautiful, correctly-linked Excalidraw diagrams in Obsidian** from a plain description of nodes and relationships. You describe *what* the diagram is; the skill handles *where* (auto-layout) and *how* it looks (curated themes) — and emits Obsidian's native `.excalidraw.md` so it opens as an editable, linked drawing.

## Why

Drawing Excalidraw by hand (or by hand-writing its JSON) is where diagrams break: arrows that don't link, labels that vanish, ugly ad-hoc layouts. This skill takes a tiny spec and produces a clean, themed, auto-laid-out diagram every time — with arrows that actually follow their shapes when you drag them.

## Install (OpenCode)

```bash
git clone https://github.com/NeoMei/obsidian-excalidraw.git \
  ~/.config/opencode/skills/obsidian-excalidraw
```
Restart OpenCode. (For Claude Code / Codex / Cursor, drop the folder into their skills dir.)

## Usage

### 1. Describe the diagram as a spec
```json
{
  "title": "Checkout flow",
  "theme": "soft",
  "direction": "TB",
  "nodes": [
    {"id":"cart","label":"Cart","role":"client"},
    {"id":"pay","label":"Payment","role":"service"},
    {"id":"db","label":"Orders DB","role":"store"}
  ],
  "edges": [
    {"from":"cart","to":"pay"},
    {"from":"pay","to":"db","style":"dashed","label":"async"}
  ]
}
```
**Roles** drive color: `client` · `service` · `store` · `queue` · `external` · `decision`. No coordinates needed — the generator lays everything out.

### 2. Generate
```bash
python3 references/generate.py spec.json --out scene.excalidraw \
  --obsidian scene.excalidraw.md      # Obsidian-native, opens in the Excalidraw plugin
```

### 3. (Optional) Render & self-check
```bash
cd references && uv sync && uv run playwright install chromium   # one-time
uv run python render.py ../scene.excalidraw -o preview.png
```

## Themes

| Theme | Look | Use for |
|-------|------|---------|
| `soft` *(default)* | calm low-saturation pastels, white board | notes, everyday docs |
| `mono` | grayscale, ink-on-paper | print, formal docs |
| `vivid` | confident, saturated | presentations, slides |
| `dark` | deep slate board, luminous desaturated fills | Obsidian dark mode |

Edit `references/themes.py` to add your own or rebrand.

## How arrows link

Linkage needs **bidirectional** binding: an arrow's `startBinding`/`endBinding` point at shapes, AND both shapes list the arrow in `boundElements`. Never add an `elbowed` field (it breaks linkage). `generate.py` enforces all of this — see [`SKILL.md`](./SKILL.md).

## Files

```
SKILL.md                       # when to trigger + the workflow (agent context)
references/
  generate.py                  # ⭐ spec -> .excalidraw / .excalidraw.md (auto-layout + themes)
  themes.py                    # curated palettes + typography scale
  render.py                    # .excalidraw -> PNG (Playwright, self-check)
  render.html                  # render template (loads vendored Excalidraw)
  entry.mjs                    # source for the vendored bundle
  excalidraw-vendored.mjs      # bundled Excalidraw (committed; rebuild via build-vendor.sh)
  build-vendor.sh              # regenerate the vendored bundle
  pyproject.toml               # render deps (playwright)
```

## Roadmap

- More layout strategies (radial for hub-spoke, sequence lanes, tree)
- Auto-routing that avoids crossing unrelated shapes in dense graphs
- More themes + a dark-board theme
- Sequence / ER / state diagram presets

Contributions welcome.

## License

MIT — see [`LICENSE`](./LICENSE).
