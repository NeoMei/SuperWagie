# UniHub headless commerce implementation plan

> **For agentic workers:** Use subagent-driven-development to implement independent tasks with explicit file ownership, then review and validate the combined change. No Git commands or commits are authorized.

**Goal:** Complete SuperWagie's own registration, account and sandbox purchase workflow using UniHub.

**Architecture:** Extend platform-account identity and add a focused commerce module with a durable intent journal. Shared React pages use runtimeFetch and parsed public contracts. UniHub owns all financial amounts and entitlement changes.

**Tech Stack:** Existing JavaScript backend, React/TypeScript, Zod, Node filesystem, Bun tests and Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-unihub-headless-commerce.md`

## Global constraints

- No Git/GitHub commands, dependency additions, releases, deployments or real payments.
- Preserve existing OIDC, BYOK, task payer binding and runtime authentication.
- English and Simplified Chinese UI text; documentation and source comments in English.
- Managed Web/Electron supported; VS Code, hosted mobile, Capacitor and external OpenCode remain explicitly unsupported.
- No passwords/tokens in logs, URLs, persisted settings or commerce journal.
- Only the coordinator runs broad checks, after all source writers finish.

## Task 1: Headless identity

Files: `packages/web/server/lib/platform-account/runtime.js`, `routes.js`, identity helpers/tests and `DOCUMENTATION.md`.

Public endpoints and responses:

```ts
// GET /api/platform-account/auth-methods
type AuthMethods = { passwordLogin: boolean; registration: boolean; browserLogin: boolean };
// POST /api/platform-account/register
type RegistrationInput = { username: string; password?: string; email?: string; displayName?: string; idempotencyKey: string };
type RegistrationResult = { registrationId: string; status: 'CREATED' | 'UNKNOWN'; loginRequired: boolean; retryAfter?: number };
// POST /api/platform-account/password-login
type PasswordInput = { username: string; password: string };
// Returns existing PlatformAccountState; consoleUrl becomes nullable.
```

- [x] Add focused tests for successful registration/login, UNKNOWN registration, state/nonce/audience failure, single-use exchange, logout races, unsupported runtime and structured errors.
- [x] Implement explicit headless client configuration and fixed redirect without changing legacy client privileges.
- [x] Expose a captured commerce session with immutable actor/account/service and a guarded request function. Exact path/method allowlists remain backend-owned.
- [x] Run `bun run --cwd packages/web test server/lib/platform-account/runtime.test.js` and new focused test files; update owning docs.

## Task 2: Sandbox commerce and recovery

Files: new `packages/web/server/lib/platform-account/commerce.js`, `commerce-store.js`, `commerce-routes.js` and their tests. Coordinator wires `packages/web/server/index.js`.

```ts
// GET /api/platform-account/commerce
type CommerceState = {
  accountId: string; role: string; financialAccess: boolean; missingScopes: string[];
  payments: { mode: 'sandbox' | 'unconfigured'; canRecharge: boolean; canPurchase: boolean };
  wallets: Wallet[] | null; offers: Offer[] | null; orders: Order[] | null;
  intents: Intent[]; rechargeHistoryScope: 'this-instance';
};
type Wallet = { productId: string; asset: 'CNY/6'; amount: string };
type Offer = { id: string; productId: string; name: string; accountKind: string; kind: 'membership' | 'addon'; period: string; price: string; monthlyCredit: string; validityMonths: number; rank: number; sandbox: boolean };
type Order = { id: string; productId: string; offerName: string; amount: string; paymentStatus: string; fulfillmentStatus: string; refundStatus: string };
type Intent = { idempotencyKey: string; kind: 'recharge' | 'purchase'; accountId: string; productId: string; amount: string; offerId?: string; resourceId?: string; status: 'PREPARED' | 'UNKNOWN' | 'PENDING' | 'APPLIED' | 'FAILED'; errorCode?: string; createdAt: string };
// POST /commerce/recharges {accountId,productId,amount,idempotencyKey} -> Intent
// POST /commerce/purchases {accountId,offerId,idempotencyKey} -> Intent
// POST /commerce/intents/:key/reconcile {accountId} -> Intent
// POST /commerce/intents/:key/sandbox-settle {accountId} -> Intent
```

- [x] Test denied role/scope, mismatched account, unpublished or wrong-account offer, duplicate intent and unknown upstream outcome.
- [x] Implement atomic private persistence before IO; retain original keys and immutable commands across restart. Reject corrupt state and concurrent writers.
- [x] Implement scope-aware overview and explicit sandbox settlement. No passive refresh sends financial mutations.
- [x] Verify lost-response recovery returns the original order and credits once, including process restart. Update owning documentation after review.

## Task 3: Account UI and runtime transport

Files: `packages/ui/src/lib/platformAccount.ts`, new `platformCommerce.ts` and transport tests; `packages/ui/src/components/sections/platform-account/`; English/Chinese messages and relevant settings search entries.

- [x] Parse identity and commerce responses at the runtime boundary and retain structured error codes without raw remote messages.
- [x] Add forms with password clearing, stable registration recovery and explicit unavailable interactions.
- [x] Add account, membership, wallets and orders UI using shared Settings primitives; display sandbox mode, wallet destination and separate payment/fulfillment states.
- [x] Preserve original purchase selection through insufficient-balance recharge; require explicit purchase after funding. Display unknown intents with a recovery action that reuses the saved key.
- [x] Test large integer amounts, sandbox confirmation, member restrictions, account/runtime changes during requests, uncertain registration, financial recovery and both locales.

## Task 4: Integration and acceptance

- [x] Wire commerce with the existing data directory and graceful shutdown; verify route authentication and Origin rejection.
- [x] Review each task's contracts and security boundaries, then review combined lifecycle and recovery behavior.
- [x] Run focused backend/UI tests, `bun run type-check`, `bun run lint`, applicable build and dead-code checks serially. Check commands for prohibited Git invocations before use.
- [x] Exercise the UI against isolated synthetic sandbox services or available local test infrastructure. Label mocks explicitly; do not create remote users or financial records to hide absent local validation.
- [x] Record exact passed checks and remaining native, deployment, payment and real-model boundaries.

## Execution notes

2026-10-25: Interface review found shared ownership only at identity session capture and backend composition. Identity owns runtime/routes; commerce owns separate files; coordinator owns composition/transports; UI worker owns components/locales/search. No file has two concurrent writers. User selected sandbox-only delivery. Existing repository rules prohibit Git, so work remains in the supplied checkout with no commit workflow.


## Validation completed on 2026-10-25

- Backend account, commerce, existing model transport and shutdown suites: 71 tests passed across 8 files.
- UI account components: 14 tests and 92 assertions passed. Runtime transport: 7 tests and 32 assertions passed. English/Chinese dictionary parity: 1 test and 283 assertions passed. Settings search: 15 tests and 55 assertions passed. Total focused coverage: 108 tests.
- Workspace type-check passed for 3,439 files across 7 projects. Workspace lint passed with 5 existing React hook warnings outside the changed account components. Dead-code checks passed after removing unused type exports and making the model provider constant private. Knip emitted 3 existing configuration hints.
- `build:web` passed for the production UI and service worker. Vite reported dependency annotation, CSS highlight and chunk-size warnings. Node syntax checks passed for the backend entrypoint and changed runtime modules.
- The browser exercised the actual shared account components and account/commerce backend modules against an isolated real UniHub process using Casdoor and a separate PostgreSQL schema and Formance ledger. The temporary page used a test runtime cookie; route tests covered runtime identity and Origin rejection. This browser setup did not exercise production shell authentication.
- A synthetic user registered and signed in. A CNY 1 sandbox recharge funded the SuperWagie wallet; an explicit membership purchase consumed it and granted 1 credit. A separate CNY 1 recharge and addon purchase used the llmrouter wallet and increased credits to 2. Both purchase orders were PAID and FULFILLED.
- After graceful backend restart and renewed sign-in, both wallets remained at zero, the membership remained active, credits remained at 2, and exactly 4 APPLIED intents and 2 fulfilled orders remained. The journal had mode 0600. Response-loss recovery across restart was also covered with deterministic upstream test doubles and original-key/one-debit assertions.
- Final review corrected stale account projections, financial history after scope revocation, and same-key in-flight recovery after role or scope revocation. Regression tests cover all 3 cases.

## Remaining acceptance boundaries

- No real merchant, real payment, production deployment, installer publication, native installed-app run or real model generation was performed.
- MFA, CAPTCHA, password recovery, active membership upgrade/renewal and unsupported runtimes remain outside this implementation.
- Browser console warnings in the temporary page came from the absent shared-settings endpoint. The temporary page does not establish full application-shell acceptance.
- Git-based `check:changed` was not run because Git commands were not authorized. Its independent type, lint and dead-code checks were run; the Git-relative anti-slop ratchet was not evaluated. No commit was created.


## Membership purchase presentation follow-up

The maintainer requested that the membership-plus-addon pricing model be visible
inside SuperWagie. The shared account page now shows a monthly/annual membership
selector and separate addon choices. Option summaries show the full period price,
monthly included credit or one-time addon amount, and addon validity. Checkout
keeps the explicit funding and purchase steps. Search recognizes monthly, annual,
membership-fee and addon terms in Chinese and English.

Managed Web and Electron share this UI. VS Code, hosted mobile and Capacitor keep
their explicit unsupported state; external OpenCode remains refused by the backend.
No backend contract or price changed. The account UI, dictionary and Settings
search suites passed 33 tests. Workspace type-check and UI lint passed; lint has
5 existing warnings outside this feature. A read-only fixture preview of the
actual component was checked in light/dark themes and a 390px-wide pane. Annual
selection showed the full yearly amount and prefilled recharge for the correct product wallet;
this visual check did not execute a payment or repeat the prior real-service
integration acceptance. The installed desktop app has not been repackaged.
