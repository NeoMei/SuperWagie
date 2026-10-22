# Delivery

`superweb deliver` runs only at stage `delivered` with an acceptance `accept`
decision. Accepting the acceptance gate runs it automatically; the command
remains for retrying after fixing a refused check.

It validates the preview, builds a temporary copy, archives any previous
delivery, and only then replaces `交付/`. A failed check leaves both the old
delivery and the preview untouched.

## Self-contained rules

Every asset reference in HTML, CSS, JS, and SVG is checked:

- Allowed: relative paths to files inside `预览/`, `data:` URIs, `blob:` URIs
  generated at runtime, fragment links, `mailto:`, `tel:`.
- Refused: `http://` and `https://` asset URLs, protocol-relative `//host/...`,
  absolute filesystem paths, `file://`, Windows drive paths, and Web-root
  absolute paths such as `/assets/photo.png`.
- Refused: a relative reference whose target file does not exist.

Checked attribute positions: `src`, `srcset`, `poster`, `data-src`, and
`href` on stylesheet/icon/preload links; plus every CSS `url(...)` including
inline styles. External page links (`<a href="https://…">`) are allowed — they
are navigation, not assets.

Asset priority: user-provided local files → user-approved image generation →
explicit visible placeholder. Do not fetch stock images. Do not fabricate
logos, product screenshots, statistics, or testimonials.

## Output

```
交付/
  index.html
  assets/
  验收/
    desktop.png
    tablet.png
    mobile.png
    report.json
  说明.md
```

`说明.md` records the task, route, chosen direction, revision, timestamp,
acceptance status, and every remaining issue. If Chrome was unavailable, it
states prominently: **未完成浏览器验收**. If the user accepted a failed check,
it says the issues were accepted with knowledge.

The page must open by double-click with no server, no build step, and no
dependency installation.

## Archiving

If `交付/` exists, it is renamed to `交付-v1/` (or the next free number) before
the new directory is written. Never overwrite files the user may already have
copied away.

Post-delivery rework:

```bash
superweb decide --dir <task> --gate acceptance --choice rework --target full
# edit, re-inspect, re-accept (auto-delivers)
```

The new delivery gets `交付/`; the previous one stays as `交付-vN/`.

## Final check

Before handing over, open `交付/index.html` from Finder/Explorer and confirm:

- it renders without a server
- no broken image or font
- the primary action is reachable
- mobile width has no horizontal scroll
- `说明.md` describes the actual acceptance state honestly
