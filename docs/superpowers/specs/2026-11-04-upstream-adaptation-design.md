# SuperWagie upstream adaptation

## Approved scope

The maintainer approved the recommendations discussed on 2026-11-04: selected correctness fixes, OpenCode 2.2.5, localized activity feedback with Benma thinking lines, native Memory improvements while retaining Hy, and Workflow adaptation. This is source implementation and validation. A public release, Git operations, installation replacement and user-data migration are not part of this request.

The first wave excludes the separately proposed chat row/scroll rewrite, custom sidebar sections, OpenUI blocks, Canary distribution and Electron 45. The current product remains SuperWagie 2.7.53 until a release is requested. Preserve the existing optional Intel compatibility lane.

## Contracts

- SDK, schema and the standard packaged CLI move from 2.2.4 to 2.2.5 together. Keep the existing minimum 2.2.4 contract and six-hour managed updater policy. No new dependencies or unrelated package upgrades.
- Retain English and Simplified Chinese only. Do not restore retired languages or upstream branding.
- Localized activity labels describe actual current tools, permissions and retry states. Thinking lines occur for approximately one reasoning part in four, selected deterministically by reasoning identity and stable for that part. No polling, extra model calls or animated status transitions are added.
- The approved Chinese additions are: 正在让点子小跑一圈; 正在给思路顺顺毛; 正在给灵感添点草料; 正在牵回跑远的灵感; 正在和小马开个脑内会; 正在沿着线索找条好路. Keep ordinary activity labels and a small generic thinking pool. English receives corresponding natural copy.
- MCP on/off toggles persist the disabled configuration; independent connection controls retain their existing meaning. Writes and refreshes stay with the captured runtime and directory.
- OpenChamber announcements use the existing control stream with a single authoritative source. Pending inbox messages stay hidden while the agent awaits an interactive page or secret, become visible on delivery, and survive historical reloads correctly. Preserve SuperWagie's question text, choices, recorded answers and FormDock authority.
- Preserve UNC paths in SDK directory headers and create/list/move calls. An OpenCode LocationNotFoundError from one project must leave the other projects reachable.
- Validate only explicitly supplied scheduled-task models against the execution directory's available catalog. Failed catalog reads are failures; an authoritative empty catalog preserves the existing upstream fallback. A multi-prompt run reports one result per parent/run without losing durable retries or later runs.
- Native Memory remains the existing shared manual adapter. Expose its user-controlled setting with an off default; preserve IDs, scope, flags, source-aware Hy records, source withdrawal, tombstones, confirmation and indexing. Render newest titles first with complete-line budgets and explicit omissions.
- Workflow becomes a user-controlled, off-by-default feature on managed web/desktop and connected mobile, with explicit unsupported behavior for external OpenCode and VS Code. Sync authorized project knowledge before workflow agent prompts. Do not transfer conversation-capture consent to child sessions or treat generated reports as verified experience.
- Preserve UniHub's current immutable identity, payer, task and receipt contracts. The maintainer is being asked separately whether this wave should design managed child-task billing. Until that is settled, the existing managed child-session prohibition remains enforced and is surfaced clearly before execution; BYOK integration proceeds independently.
- CSV preview rows are virtualized with stable bounded column widths, correct scroll ownership and reachable final rows. PTY replay limits use UTF-8 bytes without broken code points.

## Runtime behavior

| Runtime | Behavior |
| --- | --- |
| Web | Shared UI fixes, managed Memory/Workflow settings, server-owned knowledge and task admission. |
| Electron | Same in-process server and shared UI; standard bundled engine 2.2.5; no native shell redesign. |
| VS Code | Shared activity/MCP/path fixes and SDK update; existing unsupported managed Memory/Workflow contract remains explicit. |
| Hosted mobile | Shared fixes and server-owned settings/cards through existing transports. |
| Capacitor mobile | Shared fixes and connected-server ownership; no new native capability. |

## Validation

Capture a filesystem baseline before edits and review only this wave's differences. Use deterministic fixtures for runtime changes, failed config writes, pending-message delivery, directory errors, duplicate run reports, memory truncation and feature defaults. Keep model calls, credentials, real account changes and production feeds outside tests. Run focused suites per task, then combined type-check, lint, dead-code, customization checks and affected builds serially. Verify visible status and CSV scrolling in an isolated UI fixture. Report native Windows and real-provider limits precisely.
