# Account center layout implementation plan

> **For agentic workers:** Use subagent-driven-development for independent commerce and usage tasks, with coordinator integration and review. Do not run Git commands.

**Goal:** Implement the corrected SuperWagie account center: wallet, SuperWagie subscription and API Key activation with automatic model configuration and a connectivity test, with consumption/orders as records and backend services invisible.

**Architecture:** Preserve financial commands. Add an account/actor-scoped durable activation flow through the existing service request boundary and owning native provider modules. The account page owns navigation and identity; commerce owns balances, purchase forms and order recovery; usage owns independent authoritative reports; model bootstrap owns key/configuration/test recovery.

**Tech stack:** React, TypeScript, shared Settings primitives, existing Bun and browser tests.

**Spec:** The maintainer's 2026-11-06 correction in this chat supersedes the initial mockup's product scope: no UniHub/LLMRouter reports, branding, setup or administration in the user center. The initial layout artifact remains a preserved draft, not the final design.

## Constraints and surfaces

- Web and Electron use the same account-center layout and existing runtime HTTP contracts.
- VS Code, hosted mobile and Capacitor retain their explicit unsupported state.
- Narrow supported web panes show navigation above the content; account identity and actions remain reachable.
- Preserve separate CREDIT, SuperWagie CNY and LLMRouter CNY balances, permissions, missing data, pending commands and exact quantities.
- No new payment, upgrade, renewal, migration or publishing behavior. The maintainer's later clarification authorizes one explicit account-key activation and automatic chat connectivity test, with an explicit retest action after failure.
- Keep the existing Settings entry, search targets and model-funding deep links.
- Use real English and Simplified Chinese translations, semantic theme tokens and logical positioning.
- No dependencies, Git commands, commits, releases or changes to unrelated files.

## Tasks

- [x] Account shell: update `PlatformAccountPage.tsx`, `platformAccountTabs.ts` and existing navigation tests. Display billing, keys, usage, orders and profile in that order, put identity/account/actions in navigation, preserve login and error flows. Add a navigation regression that switches to orders and confirms zero purchase/recharge requests.
- [x] Commerce: update `PlatformAccountCommerce.tsx` and focused tests. Accept `view: 'overview' | 'orders'`; consume `membershipSummary(actions)` with membership/addon open callbacks and states. Put wallet actions next to the matching balance, reveal existing forms on demand, and keep recovery reachable in both views.
- [x] Usage: update `PlatformAccountUsage.tsx` and its browser test. Preserve `PlatformAccountUsage({accountId})`, add `PlatformAccountUsageSummary({accountId})`; the latter fetches only the summary. Verify there are no other-product requests, denied summary with successful calls, and stale-response isolation across account/runtime changes.
- [x] Integration: update feature translations and module documentation; run focused account tests, translation parity, UI type-check, UI lint and browser validation serially on the combined source. Inspect light/dark and narrow views using fixture data without financial mutations.

## Regression contracts

```tsx
await tab('Orders');
expect(rechargeRequests).toBe(0);
expect(purchaseRequests).toBe(0);
await tab('Wallet and subscription');
expect(host.querySelector('#unihub-recharge-amount')).toBeNull();
```

Existing tests continue to cover original-key recovery, switching payer, stale runtime responses, exact amounts, forbidden data and sandbox settlement separate from purchase. Only adjust assertions whose visible placement changed in the approved layout.

## Validation

Use `bun test packages/ui/src/components/sections/platform-account/PlatformAccountPage.test.tsx` for the integrated component, focused new commerce tests, and the existing Node browser fixtures. Use package scripts `type-check:ui` and `lint:ui` once editing is finished. No commit is planned, so no pre-commit gate or Git-based diff is run. Compare against preserved source snapshots and report runtime acceptance separately from fixture checks.

## Corrected product scope

- [x] Remove backend console/model setup links, report selector, raw permission scopes and infrastructure brands from normal account UI.
- [x] Keep wallet amounts separate under purpose names; omit unrelated product catalogs/history, retain uncertain-operation recovery.
- [x] Add an owned-key metadata route and view with account/actor filtering, explicit failures and upstream-list truncation. IDs are labeled as IDs; no key is issued or retrieved. Current model-connection/native-key ownership is not inferred.
- [x] Revise focused and browser tests for the new product scope and capture fresh fixtures.
- [x] Run combined final static checks and review responsive screenshots.

## Validation status

The initial implementation passed its checks before the maintainer's product
correction. Those results do not establish the corrected implementation's status.
Corrected-source checks passed: account component 80/80, commerce 4/4,
key component 5/5, translation parity 1/1, and backend runtime 45/45.
Navigation and usage browser suites each passed, including light/dark/narrow
fixtures and wallet action containment. Workspace type-check and lint passed;
a new hook-cleanup lint warning was corrected and UI lint rerun clean. The
final UI edits passed UI type-check. Backend files passed node --check. All
browser evidence uses fixture data; no real credentials, payment, model dispatch,
Git operation, native package or publication is part of this task.

## Confirmed API-key flow

The maintainer clarified that the SuperWagie account panel should open an API
key, put it into model configuration and complete a connectivity test. This
supersedes the earlier metadata-only page. The issuance API does not itself buy
a new subscription; it uses the account's current permissions and model catalog.

- [x] Add a durable owner-bound activation receipt with strict issued-key scope validation, safe secret storage, actual last-four display and no automatic reissuance after an uncertain response.
- [x] Add a native SuperWagie provider and reusable model connection, preserving existing defaults, purpose bindings and project/session overrides.
- [x] Run a single explicit chat probe after configuration, distinguish verified/failed/unknown, and require an explicit action for another potentially billable test.
- [x] Connect read-only progress and recovery to the account page; refresh mounted model settings while preserving dirty drafts and account/runtime boundaries.
- [x] Cover fixture success, interrupted configuration, unknown issuance, permission/enterprise refusal, credential conflicts and explicit retest. Update bilingual UI and enterprise documentation.
- [x] Complete combined static checks and final regression review on this source.

Final activation-source validation passed: account page 80/80, API Key panel
15/15, mounted model configuration 38/38, translation parity 1/1, activation
33/33, native provider 23/23, model runtime 24/24, bootstrap 19/19 and bootstrap
routes 4/4. The final browser navigation/activation suite passed again after the
refresh-race fix; it covers read-only navigation, successful activation,
failed-test recovery, mounted model settings refresh, locale/theme/narrow layout
and no browser exceptions. Updated screenshots are retained in the thread's
`account-key-activation-current` artifact directory.

Workspace `type-check` and `lint` passed. `build:web` completed, including the
standalone model resolver and builtin extensions; it reported non-blocking CSS
highlight, annotation and chunk warnings. Server JavaScript syntax checks passed.
`docs:validate` passed for 696 pages and 58 sidebar links. No Git-dependent
pre-commit check was run because this task performs no commit or Git operation.

No real user key, payment or model request has been created during implementation.
Fixture tests and screenshots do not establish real-account, installed-client,
payment or production acceptance. Strong process termination during the existing
model configuration commit lock retains that module's documented manual lock
recovery boundary; it does not authorize reissuing an uncertain key.

## Visible connection-test progress

The maintainer subsequently requested a panel showing the test process and
result. The API Key page now keeps a named setup/test panel visible throughout
the request, with pending/running/completed/failed/unconfirmed states for key
activation, model configuration and connection testing. Local submission shows
immediate feedback before the server has a receipt. A retest hides its previous
outcome and timestamp; a completed read arriving before the POST response cannot
restart the displayed progress. Read failures and uncertain outcomes remain in
the same panel with the existing explicit recovery actions.

The progress UI uses the existing three server phases; it does not invent
request logs, percentages, latency or usage totals. The 18 component tests passed
with 163 assertions, translation parity passed, and UI type-check and lint passed.
The browser fixture covers phase-by-phase progression, old-result suppression,
failure/retry, read-only navigation and responsive layout. Chinese progress,
success and failure screenshots are retained in `key-test-progress-current`.
No real key or paid model request was used to validate this UI addition.

## Clarified target: model-purpose test animation

The maintainer clarified that the requested motion belongs to SuperWagie's
model-configuration probes, including embedding and image generation. The
account-key workflow alone does not satisfy that request.

The model settings overview, purpose editor and saved-connection editor now use
the shared `ModelTestFeedback` panel. An explicit test shows its model/purpose,
a shared-clock spinner and indeterminate activity bar until a real response is
available. Success, confirmed failure and unconfirmed results are distinct;
retesting hides the previous result and time. Image generation explains its
potentially longer wait. Reduced-motion changes and hidden surfaces stop the
indicators, and completed results remain static. No probe requests, default
models, automatic retry or billing policy were added.

Batch setup shows one running indicator and separate authoritative model results.
Pending results do not claim which model is currently executing. Skipped image
tests stay skipped; read failures offer a status refresh without another test
request, and closing the wizard cancels its scheduled status read.

Validation on the combined source passed: model page 44/44, connection editor
15/15, feedback panel 4/4, batch wizard 6/6, overview 9/9, animation guard 2/2 and
locale dictionaries 12/12. UI type-check, UI lint and the production Web build
passed. The browser fixture passed with exactly three explicit simulated probes:
embedding success, image failure and image retry success. DOM sampling confirmed
that the spinner/activity bar actually changes while waiting and stops on
completion, reduced motion and hidden purpose content. Narrow/light/dark
screenshots are retained under `model-test-animation-current`; its `build-web.log`
contains the build output and non-blocking bundler warnings. No CPU improvement,
real-provider acceptance, installed-client acceptance or publication is claimed.


## Confirmed account model-test list

The maintainer identified the API Key activation card as the intended surface.
Its model tests appear as compact rows in that same card. Undispatched rows stay
hidden; each actual start reveals a row with a short entrance transition and a
shared-clock spinner. Completed rows remain visible, and subsequent starts grow
the list. At most three probes run concurrently. Motion follows persisted server
states rather than a presentation timer or invented completion percentage.

The activation receipt adds a test-run ID and separate model results, preserving
older receipts without reissuing keys. Current native model choices and saved
purpose bindings remain authoritative. Fresh setup fills only supported missing
purpose bindings from the account catalog; known legacy knowledge models and
indexes remain unchanged. Tests use non-mutating connection probes so concurrent
checks cannot conflict with each other's configuration revisions. A failed row
does not erase successful rows; interrupted or unreadable results remain
unconfirmed. Retesting requires an explicit action and never reuses the previous
run's success animation. Polling and refresh do not dispatch provider requests.

Web and Electron expose this through their existing account panel and server.
VS Code, hosted mobile and Capacitor mobile retain the account page's explicit
unsupported state. No new runtime capability, public listener or dependency is
introduced. Provider entry and probes retain server-side enterprise and owner
checks. The account workflow does not replace active chat/session overrides or
claim to enumerate device-local voice settings.

The performance contract is an explicit activation/retest with one row per used
model/purpose: no more than three outstanding provider probes, one existing
800 ms receipt poll while active, and shared four-beat-per-second leaf spinners.
Terminal rows stop animating. Reduced motion and document visibility pause
waiting motion; row entrance transitions run once. No provider-speed or CPU
improvement is inferred from fixture timing.


Final combined validation: all 234 model-configuration server tests passed across
17 files. The account UI, client parser, locale and animation guard checks passed
32 tests with 908 assertions. Workspace type-check and lint passed; server
entrypoint/bootstrap syntax checks passed. The production Web build passed with
the existing non-blocking CSS and chunk warnings. The browser fixture exercises
three initially revealed models, seven rows after additional starts, independent
success/failure, explicit retest, old-run suppression, reduced motion and narrow
layout. Its progress data is simulated and no real user key, provider invocation,
charge, installed-client validation or publication was performed.

## Release validation and current-key scope

The account activation batch now probes only models authorized by its issued
API Key. Native selections from other providers remain unchanged and are omitted.
Saved bindings on another connection remain unchanged and show a skipped
explanation after the batch. Their credentials are never used by this batch.

The production account API issued one temporary API Key accepted by LLMRouter's
`/v1` inference endpoint. This is a centrally issued account credential, distinct
from an LLMRouter native-console token. Its corrected-scope retest completed
with exactly three verified rows: `glm-5.3`, `unihub-text-embedding-v4`, and
`qwen3-rerank`. Observed concurrency was three. Production router and billing
records matched the same credential ID. Two rounds charged CNY 0.005746 in
total. The key was revoked, subsequent router access returned 403, and the
isolated runtime credentials were deleted. Image and speech probes were not
accepted because the production SuperWagie model entitlement omits them.

The connectivity-only rerank probe uses one document to fit the production
model's batch limit. Focused backend coverage passed 46 activation tests and
43 adapter/runtime/probe tests. Final focused UI and client coverage passed
33 tests. The source gate, customization checks and whitespace check passed.
Packaging, publication and installed-client update acceptance are separate
release evidence.

A subsequent review reproduced three edits during activation: replacing the
connection key, changing its endpoint, and rotating its private secret reference.
Dispatch now compares the expected connection and resolved key against the same
snapshot used by the purpose probe. All three regression cases reject before
HTTP dispatch. The final activation suite passed 49 tests and the connection
probe suite passed 14 tests. The final source gate passed again. No further
paid request was needed for this guard-only change.
