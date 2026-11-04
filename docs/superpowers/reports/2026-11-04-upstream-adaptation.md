# SuperWagie upstream adaptation verification

Date: 2026-11-04. This report records adaptation verification against version 2.7.53, before the subsequent 2.7.54 release.

The approved first-wave adaptation is implemented. Independent task reviews and the final whole-change source review have no unresolved actionable findings. At this verification stage, no commit, push, public release, installer, installed-app replacement or user-data migration had been performed.

## Delivered behavior

| Area | Result |
| --- | --- |
| Standard engine | Official client, schema, protocol and packaged CLI align on 2.2.5. External minimum remains 2.2.4; Electron remains 44.9.3. Existing Vite 7.3.7 resolution is retained. |
| Activity feedback | English and Simplified Chinese labels describe live activity. Six approved Benma lines appear deterministically for approximately one reasoning part in four and remain stable within that part. Permissions, tool execution and retry labels retain their real meaning. |
| MCP | Configured on/off switches persist the disabled flag before connection work. Failed writes and retired runtime/directory responses cannot mutate a different scope. |
| Messages and directories | Control announcements use one authority. Pending synthetic inbox records reconcile delivery, cancellation, stale snapshots and history. Interactive question text and choices remain with their existing owner. SDK directory calls preserve UNC paths; missing project directories do not hide unrelated failures. |
| Native Memory | The existing manual adapter is available through an explicit setting, default off. Existing opt-in is retained. Index titles use newest-first complete-line budgeting and omission counts. Hy, authorized capture, semantic recall, source records, withdrawal and tombstones remain intact. |
| Workflow | Managed web/desktop and connected mobile expose a default-off setting. External/skip-start and VS Code remain unsupported. Public settings, guidance and execution use the same support predicate. BYOK prompts sync scoped project knowledge. Capture consent does not transfer to children; UniHub managed child-session admission remains restricted. |
| Tasks and results | Explicit scheduled models validate against the effective execution directory. Run results group by parent and completed run, persist their payload and delivery ID, recover relevant history and retry partial read failures without requiring a new idle event. |
| CSV and terminal | CSV/TSV mount viewport rows with stable bounded columns. Patched bun-pty retains at most 512 KiB of complete UTF-8 startup output and replays it once. |

The separate chat-row/scroll rewrite, custom sidebar sections, OpenUI blocks, Canary distribution and Electron 45 remain outside this wave.

## Verification

| Check | Observed result |
| --- | --- |
| Final `bun run type-check` | Passed, 3,673 files across 7 projects plus Electron syntax checks. |
| Final `bun run lint` | All workspaces passed. |
| Final `bun run dead-code` | Zero dead-code findings. One non-blocking configuration hint remains for the existing fix-deprecation entry. |
| Filesystem anti-slop comparison | 77 changed source files; 823 initial findings and 822 current; zero rules grew. |
| `bun run test:customizations` | 28 Bun and 26 Node tests passed. |
| Affected UI tests | 19 isolated processes, 522 tests passed, zero failed. |
| Affected server modules | 10 files, 351 tests passed. |
| Dispatch final suite | 37 tests passed, including restart, separate runs, pagination failures and recovery without a new event. |
| Preserved Hy/UniHub/Workflow behavior | Four preservation files passed. The unchanged Workflow runtime suite passed all 49 tests on isolated repeat. See the fixture note below. |
| Server and browser-script syntax | 20 changed JavaScript/module files passed `node --check`. |
| Real local PTYs | 2 tests passed for byte bounds, whole emoji, box characters and first-listener replay. |
| Real Chrome CSV fixture | 1 passed, zero skipped. A 2,000-row, 300-column table mounts 31 rows and 9,300 cells; final row is reachable and column widths remain stable. Short, empty and reopened content also pass. |
| Web build | Passed, including service worker. |
| VS Code extension and webview build | Passed. |
| Frozen dependencies | `bun install --frozen-lockfile --ignore-scripts` passed without changes. Official 2.2.5 registry metadata and lock comparison were retained. |

The canonical `check:changed` script invokes Git, which was outside this session's authorization. Its type, lint and dead-code steps ran individually. The pure anti-slop comparison used hash-verified source copies captured at task start, rather than a branch merge-base. No rule was silenced or weakened.

A supplementary combined preservation run initially passed 145 of 146 tests. The unchanged Workflow live-owner fixture captured disk bytes before its own asynchronous session-ID write finished. Runtime, store, process-owner and that test exactly match the initial snapshot. An isolated repeat passed all 49 Workflow runtime tests. No source workaround was added for that fixture race.

Builds retain CSS highlight-selector, mixed import and large-chunk warnings. The CSV browser fixture uses the actual component with a small functional stylesheet; its measurements describe mounted DOM and scroll behavior, not full-app performance.

## Remaining acceptance boundaries

- Native Windows, packaged Electron startup/update, Docker, installed-app replacement and real-provider Workflow execution were not exercised.
- No real account, credential, provider charge or user capture-consent change was used in tests.
- Recovery reads at most 20 pages of 50 records per attempt. An older entry whose boundary cannot be established within that budget remains pending with backoff. Recent explicit baselines and saved outcomes can proceed independently. Unknown history never becomes a guessed completion or cancellation.
- Dependency work used installed Bun 1.4.3; the repository requests 1.4.4. Postinstall was skipped during installation; owning build scripts ran during build verification.

## Local receipts

The ignored `.superpowers/sdd/2026-11-04-upstream-adaptation/` folder contains initial hashes and source copies, exact changed-file inventory and diff, registry/lock receipts, focused red/green logs, combined check logs and review reports.

- [Final whole-change review](../../../.superpowers/sdd/2026-11-04-upstream-adaptation/final-review.md)
- [Final source-check results](../../../.superpowers/sdd/2026-11-04-upstream-adaptation/final-check-results.json)
- [Task ledger](../../../.superpowers/sdd/2026-11-04-upstream-adaptation/progress.md)
