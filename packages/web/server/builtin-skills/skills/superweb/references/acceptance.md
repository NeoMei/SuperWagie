# Browser acceptance

`superweb inspect` is the only acceptance mechanism. It starts a temporary
static server rooted at `预览/`, launches the locally installed Chrome through
`playwright-core`, and checks three viewports:

| Name | Width × height |
| --- | --- |
| desktop | 1440 × 900 |
| tablet | 768 × 1024 |
| mobile | 390 × 844 |

No Chromium download. Chrome discovery order:

1. `--chrome <path>`
2. `CHROME_PATH`
3. Platform defaults:
   - macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
     Chrome Beta, Chromium, `~/Applications/...`
   - Linux: `/usr/bin/google-chrome`, `google-chrome-stable`, `chromium`,
     `chromium-browser`, `/snap/bin/chromium`
   - Windows: Program Files and LocalAppData Chrome paths

## Checks

- **Horizontal overflow** — `documentElement.scrollWidth > innerWidth + 1`.
  Offending elements with `left < -1` or `right > innerWidth + 1` are listed
  (up to 8).
- **Text truncation** — leaf text elements whose content is clipped by
  `overflow: hidden/clip` without `text-overflow: ellipsis`. Intentional
  ellipsis is not reported.
- **Broken images** — images that finished loading with `naturalWidth === 0`.
- **Console and page errors** — every `console.error` and uncaught exception
  for that viewport. Duplicates are removed.
- **Primary action** — at least one visible link, button, select, or input in
  the first viewport.
- **Keyboard focus** — at least one visible focusable element, and pressing Tab
  moves focus to a visible element (up to four presses).

Screenshots are full-page and saved as:

```
验收/desktop.png
验收/tablet.png
验收/mobile.png
验收/report.json
```

## Report

```json
{
  "version": 1,
  "taskId": "…",
  "route": "page",
  "generatedAt": "…",
  "browser": { "available": true, "path": "…", "name": "Local Google Chrome" },
  "viewports": [
    {
      "name": "mobile",
      "width": 390,
      "height": 844,
      "screenshot": "验收/mobile.png",
      "checks": {
        "overflow": { "ok": false, "scrollWidth": 900, "innerWidth": 390, "offenders": [] },
        "truncation": { "ok": true, "items": [] },
        "images": { "ok": true, "broken": [] },
        "console": { "ok": true, "errors": [] },
        "primaryAction": { "ok": true, "visible": 1, "inViewport": 1 },
        "keyboard": { "ok": true, "focusable": 1, "focused": ["button"] }
      },
      "issues": []
    }
  ],
  "passed": false,
  "issueCount": 1,
  "issues": [
    { "viewport": "mobile", "check": "overflow", "message": "页面横向溢出：…" }
  ]
}
```

`passed` is true only when all viewport issues are empty. The task still moves
to `acceptance` on failure; the user decides whether to rework or explicitly
accept the risk.

## Failure handling

| Situation | Exit | Delivery |
| --- | --- | --- |
| Checks pass | 0 | `decide … accept` then `deliver` |
| Checks fail | 1 | Rework, or accept with `--acknowledge-issues` |
| Chrome missing / will not launch | 4 | Report explains; delivery only with `--acknowledge-issues` and readme says “未完成浏览器验收” |

The CLI never installs a browser, never falls back to a remote browser, and
never hides a failed check. A missing Chrome is a known, explainable state, not
a crash.

## Limits

These are fast structural checks, not a substitute for human judgment. They do
not test:

- visual quality, hierarchy, or whether the direction was followed
- color contrast or WCAG conformance
- Safari/Firefox behavior
- real form submission or backend behavior
- background-image network failures
- animation smoothness or reduced-motion correctness

Use screenshots plus human review for those. The report is evidence, not an
automatic approval.
