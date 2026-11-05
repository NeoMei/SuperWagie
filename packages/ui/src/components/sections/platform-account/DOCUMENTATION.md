# Platform account settings

## Ownership

The UniHub account page owns in-app registration and login, the user center profile and security controls, account selection, membership and credit display, and sandbox commerce controls. `lib/platformAccount.ts`, `lib/platformProfile.ts`, and `lib/platformCommerce.ts` validate the authenticated runtime HTTP contracts. Existing provider settings retain ownership of BYOK configuration. The backend owns credentials, financial authorization, authoritative balances and durable purchase/recharge recovery.

## Invariants

- The renderer receives public account data and a one-time login initiation URL. Platform access and refresh tokens never reach state, persisted settings or browser storage. Password inputs are cleared before credential requests are sent and unmounted on runtime/account changes.
- Successful password login remembers only the submitted username in browser storage under the connected runtime identity. Reopened login forms restore that username with an empty password. Failed logins do not replace it, transient runtime identities do not share it, and unavailable browser storage never blocks login. Registration recovery takes precedence over the remembered username. Existing server session restoration and expiry remain unchanged.
- The user center reads the profile from UniHub and keeps the login username and email read-only. Users can change the display name, upload a PNG or JPEG avatar up to 512 KiB, and change the password. Avatar bytes stay behind the authenticated runtime route; object URLs are revoked when replaced or unmounted. A successful password change signs the current runtime out and returns to the gate.
- Avatar file reads capture their profile and runtime owner. If either changes before the file finishes reading, the upload is cancelled before any request is sent. Settings search and jump links open the profile tab before highlighting a profile control.
- Sign-in methods come from the backend configuration. Registration recovery stores only the original idempotency key, username and optional display name/email under the runtime identity. The password is never persisted. Unknown outcomes expose a same-key recovery action without a password; if the backend reports that the original key has no registration record, the form asks for the original password and retries the same key and metadata. Browser storage failure blocks new registration. Display names are limited to 80 Unicode code points. Registration passwords require at least 8 Unicode code points, at most 128 code points and 72 UTF-8 bytes, and no control characters. No baseline composition or username/email exclusion applies. Local validation shows a specific issue while typing and preserves unsent input for correction. Passwords are cleared when dispatched. Whitelisted provider password issues explain explicit organization requirements; malformed or legacy errors use a generic rejection without displaying upstream text.
- Runtime switching invalidates pending reads and clears the displayed account. A failed read or logout clears stale data and retains an explicit refresh action without claiming the user signed out. An explicit platform session expiry restores the sign-in form.
- Registration and login rate limits show a countdown only when the server supplies a positive, bounded `retry_after`. The deadline starts when the response arrives. A leaf notice uses the shared second clock and unsubscribes after expiry or unmount; the form does not re-render on ticks. Editing a password preserves the rate-limit notice. A new attempt or auth-mode/runtime change clears it. Expiry invites an explicit retry and does not claim the backend has unlocked the identity. Missing or malformed timing retains the generic error without inventing a duration.
- Account selection affects future tasks. Model transport must preserve the task's original server binding.
- Independently admitted media tasks appear in paginated account history even
  when managed dispatch is suspended. The server filters the original device,
  actor and current payer; selecting a task's settlement check is explicit and
  never re-dispatches the original model request.
- Model availability and historical recovery availability are separate runtime checks. When dispatch is suspended but the journal can be read, the current session's authenticated task status still shows its fixed payer and model, pending and unknown calls, and terminal receipts. Reconciliation only queries receipts; it cannot submit another model request. An unbound current session shows no task section. Other failures remain visible.
- Membership and add-on CREDIT benefits are separate from CNY model cash. Copy explains the published offer scope without promising general model redemption. SuperWagie wallets fund membership purchases; llmrouter wallets fund model calls.
- Credit balances and consumed amounts display CREDIT/6 using integer division and a 6 digit fractional part. The renderer never converts ledger quantities to JavaScript Number.
- Membership choices are grouped by monthly or annual billing, with an independently priced credit-addon list. Every option shows its published price and credit amount before selection; annual pricing is the whole-year charge and still grants credits monthly. Addons show their own validity and never extend membership. Changing the membership period clears a hidden membership selection; it preserves a selected addon. No selector sends a financial request.
- Cash balances and offer prices preserve CNY/6 precision. Recharge accepts positive whole cents. The chosen offer shows its exact price, product wallet and credit grant before purchase.
- Wallet, catalog and order `null` values mean unavailable permission. They never render as zero balances or empty history. Ordinary members retain access to membership and credits while financial controls remain restricted.
- The usage tab reads UniHub summaries and the latest 20 calls in each of two independent 30-day reports. The SuperWagie product report follows current account or actor visibility. The LLMRouter native report requires its own UniHub scope and a finance role. Each summary and list distinguishes permission denial, failure and authoritative emptiness, and a response from an old runtime, actor or account cannot populate the new view.
- Pending and unknown calls stay visible. Confirmed charges and refunds retain integer precision and are shown separately in CREDIT/6, CNY/6 or LR_QUOTA/0 units. The LLMRouter report has no verified generic Token counts. Neither report infers usage from BYOK providers or from local task receipts.
- A managed model funding refusal opens the existing billing tab at the wallet selector and preselects `llmrouter` through the transient `platform-account.model-recharge` target. The target is consumed once, including when commerce is already mounted, and folds the offer catalog while retaining any selected offer; ordinary billing opens with `superwagie`, and the generic recharge target explicitly selects it. The model wallet shows its own funding explanation. Navigation never selects an offer, starts payment, transfers balances or changes a pending command's original product. Funding and refresh do not replay the failed chat.
- Sandbox recharge creation, simulated settlement and purchase are separate explicit actions. Funding a selected offer preserves the selection without buying it. Existing active memberships cannot be purchased again through this page; credit addons remain available.
- The backend journals financial commands before contacting UniHub. A lost response exposes same-key recovery, and overview reloads the durable intents after remount. Unknown or prepared intents block new commands. Refresh only reads state; it never settles, purchases or retries a financial command.
- Recharges shown in history are scoped to this instance. Purchase orders come from the server. Payment, fulfillment and refund statuses remain separate.
- The account picker resolves IDs to account names with explicit personal/team labels.
- The page is reachable in all Settings menus. VS Code and mobile show explicit unsupported text. External OpenCode is refused by the backend.
- The desktop and web sidebar avatar opens this page in an independent dialog. The existing Settings entry and search targets remain available. Account sign-out stays inside this page, and the footer keeps its other actions as separate icons. An unavailable identity read renders a neutral avatar.
- The header tab strip sizes itself from its labels, so the content-sized header action slot cannot collapse it through container-query size containment.
- The account page keeps authentication in its own section, then shows a compact identity summary, account selector and tabs. Billing leads with the wallet/recharge action, followed by membership status, a collapsible offer catalog, purchase confirmation and history; the same composition is used in Web and Electron. VS Code, hosted mobile and Capacitor mobile keep the explicit unsupported state.
- A configured UniHub console remains an optional external link. Browser redirects do not establish payment success.

## Decisions

### Why platform sessions require explicit refresh

Browser login opens externally and provides a refresh action after authorization. In-app login receives only the public account result. Commerce refreshes after an explicit action. No persistent polling or cross-window token message is needed.

### Why registration retains metadata without a password

A registration response can be lost after account creation. Keeping the original key and public form metadata across remount permits a same-key status recovery; clearing the password limits credential lifetime. Starting another registration while that outcome is unknown could create a duplicate account.

### Why login remembers only successful usernames per runtime

Restoring the last successful username avoids retyping without retaining a password or replacing a working identifier after a typo. Runtime-scoped storage prevents a connected server from displaying another server's login identifier. Browser storage is optional because it does not authorize access.

### Why recharge and purchase remain separate

The recharge funds one product wallet and can finish after an interrupted request. A separate purchase action lets the person confirm the preserved offer and price after authoritative funding, and prevents refresh or settlement from buying an offer implicitly.

### Why the account page uses a summary and flat billing sections

The user center is opened as a focused dialog, so the first screen must answer who is signed in, which billing account is active and what can be done next. A compact identity summary keeps those facts together; a separate authentication section prevents the sign-in form from competing with signed-in account controls. Billing keeps the wallet and recharge action together, then separates plans, purchase confirmation and history so the primary path does not disappear inside a nested section.


### Why membership and addons have separate choices

Monthly and annual membership fees buy a paid service term with monthly credit
grants. Addons buy one extra credit batch with its own expiry. Separate lists
make that difference visible before checkout; the shared confirmation still
binds one published offer and its exact product wallet. Prices and tiers come
from UniHub, with no inferred annual discount or locally invented price.

### Why recharge comes before the offer catalog

A model funding refusal leads to its existing llmrouter wallet without changing the payer or selecting an offer. Folding the catalog keeps the funding action visible. Purchase confirmation and unknown-command recovery remain available outside the folded catalog, so the original offer and request survive navigation and refresh. Membership status remains visible when the commerce read fails.

### Why consumption has token details

Settled charges, refunds and pending reconciliation are shown before token detail. The existing native LLMRouter report retains its own scope and exact assets. A folded token breakdown does not change the report's financial totals or imply that unresolved calls are settled.

### Why the username is read-only

UniHub currently exposes safe self-service writes for the display name, avatar,
and password. Renaming a login identifier would require a separate trusted
identity flow and could invalidate active sessions, so the user center does not
pretend that an editable field can change it.
