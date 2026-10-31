# SuperWeb validation record

Current release: 1.2.0

Historical baseline: 1.1.0 (v1 plus the reduced-step UX)

Date: 2026-10-22

## Deep optimization follow-up

Date: 2026-10-29

The runtime was rechecked after consolidating the design skill and hardening the
full workflow. `npm test` passed 56 tests, `npm run typecheck` passed with no
diagnostics, `npm run smoke` printed the CLI help successfully, and
`git diff --check` reported no whitespace errors. `npm pack --dry-run` includes
the single `SKILL.md`, the unified guided contract, route references, and the
provenance note without a second external skill file.

The follow-up adds coverage for concurrent state writes, decision replay payload
conflicts, stale preview reports, missing legacy guided files, invalid gate
flags, preview boundary escapes, malformed asset URLs, symlinked assets,
missing acceptance evidence, and per-viewport browser failures.

## Environment

| Item | Value |
| --- | --- |
| OS | macOS (darwin), arm64 |
| Node.js | v26.12.0 (project requires >= 22) |
| npm | 11.20.0 |
| TypeScript | 5.9.3 |
| Google Chrome | 155.0.8059.85 |
| Test runner | Node built-in `node:test` with `tsx` |

## Commands and results

### Install

```
npm install
```

Result: success. Runtime dependencies: `playwright-core`, `tsx`, `zod`.
Dev dependencies: `typescript`, `@types/node`. No Chromium download.

### Type check

```
npm run typecheck
```

Result: exit 0, no diagnostics.

### Test suite

```
npm test
```

Result: 56 tests passed with Chrome available; no browser test was skipped.

### CLI help smoke

```
npm run smoke
```

Result: exit 0. Help text prints the command list.

```
./bin/superweb.mjs --version
```

Result: `superweb 1.2.0`, exit 0.

### Reduced-step UX behavior

Version 1.1.0 removes flags and steps without removing a gate:

- `start` with a substantial brief extracts the three directions immediately
  (stage `direction`, revision 2). A thin brief stays at `brief`.
- `decide` defaults `--revision` to the current revision and generates
  `--decision-id` when omitted. Explicit values still validate; stale revisions
  are still rejected.
- Accepting the acceptance gate runs delivery automatically. If self-contained
  checks fail, the acceptance decision is kept, the command exits 1, and no
  `交付/` is written.
- The normal flow is exactly three user confirmations and five CLI calls:
  `start`, `decide direction`, `decide sample`, `inspect`, `decide accept`.
- Browser tests cover auto-extraction, defaulted decide flags, three-decision
  lifecycle, and the auto-delivery failure path.

### Packaging and install

```
npm pack
npm install -g --prefix <temp-prefix> superweb-1.2.0.tgz
<temp-prefix>/bin/superweb --version   # run from /tmp
```

Result: tarball built with the current package files, installed globally into
a temporary prefix, and printed `superweb 1.2.0` when
run outside the repository. This verifies that the executable, the `tsx`
runtime dependency, `SKILL.md`, and the reference docs are all packaged.

### End-to-end CLI smoke

Executed with the packaged executable (`bin/superweb.mjs`) in a fresh temporary
task directory:

```
start      -> page route, 3 directions auto-extracted, revision 2, stage direction
decide     -> direction warm-humanist (no flags), revision 3, stage sample
           -> v0.html written, sample accept (no flags), revision 4, stage full
           -> index.html written
inspect    -> passed=true, issues=0, screenshots=3, stage acceptance, revision 5
decide     -> acceptance accept (no flags), revision 6, stage delivered
           -> 交付/ auto-built with index.html, 说明.md, 验收/
```

Smoke output:

```
START stage=direction rev=2 directions=3
DECISIONS revs=3,4,5,6 inspect=true delivery=true files=6
```

The delivery contained no `v0.html` and no preview-only files.

## Test coverage by area

| Area | File | Tests |
| --- | --- | --- |
| State machine | `test/state.test.ts` | normal path for page and app; stale revision; skipped stage; payload-safe idempotent replay; decision-ID conflict; acceptance-with-issues gate; rework before/after delivery; inspect stage guard; corrupt state untouched; disk round-trip; concurrent writes |
| Schema | `test/schema.test.ts` | missing field; unknown stage; unknown route; bad decision gate/revision/timestamp; unknown top-level key |
| Directions | `test/directions.test.ts` | 12 complete unique recipes; route coverage; seeded reproducibility; route filtering; seed variation; thin brief refusal; app/page detection; rendered doc + offered-ID parsing |
| Browser acceptance | `test/inspect.test.ts` | Chrome discovery; missing Chrome explainable failure (exit 4 + report); overflow/broken image/console errors found at mobile and others; 3 screenshots; clean page passes at 1440/768/390; preview fingerprint |
| Delivery | `test/delivery.test.ts` | relative/data assets allowed; absolute/remote/missing refs refused; remote CSS import and absolute JS path refused; directory escape, malformed URL, and symlink refs refused; missing acceptance/report refused; copy page/assets/report/readme; v0 excluded; previous delivery archived as `交付-v1`; no-browser note in readme |
| CLI black box | `test/cli.test.ts` | `start` files/route detection/override/no overwrite; auto direction extraction; read-only `status`; thin brief refusal; seeded directions; legacy guide recovery; stale/unknown/skipped decisions; invalid gate flags; defaulted revision/decision ID; idempotent replay; sample artifact gate; stale preview refusal; early delivery refusal; three-confirmation lifecycle with auto-delivery; auto-delivery refusal; corrupt state; usage errors/help/version |

Fixtures: `test/fixtures/pages/good.html` (responsive, no external assets) and
`bad.html` (overflow, clipped text, broken image, deliberate console error).

## Spec checks

| Spec requirement | Verified by |
| --- | --- |
| Three gates, six stages | state tests + CLI lifecycle |
| Stale revision rejected | state and CLI tests |
| Duplicate decision idempotent | state and CLI tests |
| page and app routes | state tests both routes; CLI route detection/override |
| 3 seeded directions, 12-library | direction tests |
| No directions for thin brief | direction unit + CLI test |
| Desktop/tablet/mobile screenshots | inspect test + smoke |
| Overflow, broken images, console errors | inspect test with `bad.html` |
| Primary action/keyboard checks | clean-page pass and issue report structure |
| Chrome missing is explainable | inspect test with nonexistent `--chrome` |
| Delivery self-contained | delivery tests |
| Old delivery not overwritten | delivery test |
| Acceptance decision required | delivery + CLI tests |
| Corrupt state not reset | schema/state + CLI tests |
| Static output, no React/Vite | source layout; delivered fixture has no build step |

## Not executed or not verified

- Node.js 22 exactly: the suite ran on Node 26. The engines field is `>=22`,
  and no Node-26-only API is used intentionally, but a Node 22 CI run is not
  recorded here.
- Linux and Windows Chrome discovery: only macOS paths were exercised.
- Global install: a temporary-prefix global install from the packed tarball was
  executed and succeeded (`superweb --version` from `/tmp`); installing into the
  user's real global prefix was not performed.
- Safari, Firefox, iOS Safari, and Android Chrome: out of scope; only local
  Chrome desktop emulation at three viewport widths.
- Visual quality, contrast/WCAG, animation smoothness, and reduced-motion
  behavior: human review only; the automated report explicitly does not claim
  these.
- Real form submission, backend, deployment, image generation, and stock-image
  fetching: out of scope for v1.
- OpenChamber or other client UI integration: deliberately absent. `SKILL.md`
  is a standalone Agent Skill document.
- A real user project beyond fixtures and the smoke page: not part of this
  validation run.

## Reproduce

```bash
npm install
npm test
npm run typecheck
npm run smoke
```

Browser tests skip themselves with a recorded reason when local Chrome is not
found; the missing-Chrome test still runs because it asserts the explainable
failure path.
