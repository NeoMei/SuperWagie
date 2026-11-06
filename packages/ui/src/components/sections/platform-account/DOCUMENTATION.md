# Platform account settings

## Ownership

The SuperWagie account page owns in-app registration and login, the user center profile and security controls, account selection, membership and credit display, and sandbox commerce controls. `lib/platformAccount.ts`, `lib/platformProfile.ts`, `lib/platformCommerce.ts`, and `lib/platformApiKeys.ts` validate the authenticated runtime HTTP contracts. Existing provider settings retain ownership of BYOK configuration. The backend owns credentials, financial authorization, authoritative balances and durable purchase/recharge recovery.

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
- Membership and add-on CREDIT benefits are separate from CNY model cash. Copy explains the published offer scope without promising general model redemption. The wallet section names the unified CNY wallet Account balance, the SuperWagie wallet Subscription balance, and the llmrouter wallet Model balance. They remain separate amounts; the UI does not infer which balance pays a particular key or sum these ledgers. Subscription purchases may use an existing authorized funding source server-side.
- Credit balances and consumed amounts display CREDIT/6 using integer division and a 6 digit fractional part. The renderer never converts ledger quantities to JavaScript Number.
- Membership choices are grouped by monthly or annual billing, with an independently priced credit-addon list. Every option shows its published price and credit amount before selection; annual pricing is the whole-year charge and still grants credits monthly. Addons show their own validity and never extend membership. Changing the membership period clears a hidden membership selection; it preserves a selected addon. No selector sends a financial request.
- Cash balances and offer prices preserve CNY/6 precision. Recharge accepts positive whole cents. The chosen offer shows its exact price, product wallet and credit grant before purchase.
- Wallet, catalog and order `null` values mean unavailable permission. They never render as zero balances or empty history. Ordinary members retain access to membership and credits while financial controls remain restricted.
- Consumption records load only the SuperWagie 30-day summary and latest 20 calls. The overview reads only that summary. There is no source selector or request to native LLMRouter reports. Summary and call-list reads fail independently and distinguish permission denial, errors and authoritative emptiness. Runtime, actor and account remount keys reject stale responses.
- Pending and unknown calls stay visible. Confirmed charges and refunds retain integer precision and are shown separately in CREDIT/6, CNY/6 or LR_QUOTA/0 units. The report does not infer usage from BYOK providers or from local task receipts.
- The default user-center tab is Wallet and subscription. Profile and security remain reachable through Personal details, including login-session expiry. A managed model funding refusal opens the existing billing tab at the wallet selector and preselects `llmrouter` through the transient `platform-account.model-recharge` target. The target is consumed once, including when commerce is already mounted, and opens only the cash recharge task while retaining any selected offer; the model cash task selects `llmrouter`, and the generic recharge target explicitly selects `superwagie`. The model wallet shows its own funding explanation. Navigation never selects an offer, starts payment, transfers balances or changes a pending command's original product. Funding and refresh do not replay the failed chat.
- Sandbox recharge creation, simulated settlement and purchase are separate explicit actions. Funding a selected offer preserves the selection without buying it. Existing active memberships cannot be purchased again through this page; credit addons remain available.
- The backend journals financial commands before contacting UniHub. A lost response exposes same-key recovery, and overview reloads the durable intents after remount. Unknown or prepared intents block new commands. Refresh only reads state; it never settles, purchases or retries a financial command.
- Recharges shown in history are scoped to this instance. Purchase orders come from the server. Payment, fulfillment and refund statuses remain separate.
- The account picker resolves IDs to account names with explicit personal/team labels.
- The page is reachable in all Settings menus. VS Code and mobile show explicit unsupported text. External OpenCode is refused by the backend.
- The desktop and web sidebar avatar opens this page in an independent dialog. The existing Settings entry and search targets remain available. Account sign-out stays inside this page, and the footer keeps its other actions as separate icons. An unavailable identity read renders a neutral avatar.
- The signed-in account page has navigation for Wallet and subscription, API Key, Consumption records, Orders and Personal details. Identity, payer selection and sign-out remain in the navigation area. Wide panes place it beside the content; narrow panes place it above the content. Navigation uses ordinary keyboard-focusable buttons with an `aria-current` page marker. It does not issue financial commands.
- Wallet and subscription starts with membership status, exact CREDIT and separate CNY balances. Buying forms start collapsed and open from the matching membership, add-on or wallet action. The same commerce component stays mounted when switching between overview and orders, preserving its selected offer and original pending command. Orders contains supported subscription and addon history; unresolved intent recovery remains reachable in both views. The same composition is used in Web and Electron. VS Code, hosted mobile and Capacitor mobile keep the explicit unsupported state.
- Infrastructure console links, provider setup links, service names and raw permission scopes are not shown in the user center. The account page presents SuperWagie subscriptions, its addon benefits, purpose-labeled wallet balances and records. Other products' wallets, catalogs and completed history are omitted, but uncertain original operations retain recovery controls and their original server bindings.
- API Key reads the durable activation receipt owned by the current actor, account and service on this runtime. Opening, refreshing and polling only read state. An explicit Activate and configure action issues one account-scoped SuperWagie key, adds a SuperWagie model connection and native provider, and tests the server-selected models using that key. The server owns eligibility, missing-purpose setup and the maximum of three concurrent probes. Native selections on other providers are omitted; saved bindings on other connections remain unchanged and receive a skipped explanation. This action does not purchase a subscription. Existing purpose selections and native defaults remain authoritative.
- The renderer receives the real key's last four characters, configuration progress and per-model public test receipts, never the token. Each test names its actual purpose and model; only a verified receipt displays success. Real tests may consume balance or credits, and another batch requires an explicit action. Configuration completion refreshes the provider catalog and an already-mounted model settings page without replacing model defaults, session selections or dirty purpose drafts.
- A named setup and connection-test panel keeps the three server-owned stages and masked key beside compact model-result rows. The list grows as the server reports started or terminal tests; queued rows remain hidden and skipped explanations appear only after the batch finishes. Each row keeps a stable identity within its `testRunId`, so a sibling result never remounts or removes completed rows. Running rows use the shared clock Spinner, and ModelTestMotion pauses it for reduced motion or a hidden page. Entry motion runs once and respects reduced motion. Passed and total testable counts exclude explicitly skipped probes; skipped rows explain unavailable models, authorization, preserved legacy configuration or unsupported probes without exposing raw provider errors. No inferred percentage, sub-request log, latency or cost is displayed.
- Submitting an action shows immediate local request progress before a receipt exists. Retesting hides the entire old batch, including its success and timestamps, until a different authoritative run is observed. A lost POST followed by the same old run remains unconfirmed and exposes only read recovery; it cannot redisplay old success or admit another test. A read or POST failure preserves confirmed results from the current run, changes visible running rows to unknown and stops their animation. Unknown results remain distinct from failed tests, and alerts stay inside the panel. Legacy receipts without `tests` and `testRunId` retain their aggregate result without inventing model rows.
- Once issuance has been dispatched, an uncertain response cannot create another key. Continue setup reuses a safely stored key; Test again validates its saved configuration before a new bounded batch. Closing the panel never cancels or replays the server operation. Read failures remain errors rather than an empty state that offers another activation. Permission denial clears the visible receipt. Actor, account and runtime-instance changes discard late results and callbacks, including an A-to-B-to-A runtime visit.
- Enterprise policy blocks activation, configuration and testing at the server boundary; safe receipt reads remain available. The activation receipt is owner-scoped, but native providers and model configuration retain the current server's shared configuration scope. This flow does not provide per-user model invocation isolation or expose other users' keys.

## Decisions

### Why platform sessions require explicit refresh

Browser login opens externally and provides a refresh action after authorization. In-app login receives only the public account result. Commerce refreshes after an explicit action. No persistent polling or cross-window token message is needed.

### Why registration retains metadata without a password

A registration response can be lost after account creation. Keeping the original key and public form metadata across remount permits a same-key status recovery; clearing the password limits credential lifetime. Starting another registration while that outcome is unknown could create a duplicate account.

### Why login remembers only successful usernames per runtime

Restoring the last successful username avoids retyping without retaining a password or replacing a working identifier after a typo. Runtime-scoped storage prevents a connected server from displaying another server's login identifier. Browser storage is optional because it does not authorize access.

### Why recharge and purchase remain separate

The recharge funds one product wallet and can finish after an interrupted request. A separate purchase action lets the person confirm the preserved offer and price after authoritative funding, and prevents refresh or settlement from buying an offer implicitly.

### Why navigation stays beside the account overview

The user center is opened as a focused dialog. Keeping identity, payer and navigation together leaves the main area for membership, balances and consumption. A separate Orders view keeps historical requests out of the overview without hiding unresolved financial outcomes. Buying controls appear only after an explicit action; selectable offers still show their published price, CREDIT and period before confirmation.


### Why membership and addons have separate choices

Monthly and annual membership fees buy a paid service term with monthly credit
grants. Addons buy one extra credit batch with its own expiry. Separate lists
make that difference visible before checkout; the shared confirmation still
binds one published offer and its exact product wallet. Prices and tiers come
from UniHub, with no inferred annual discount or locally invented price.

### Why buying tasks share one detail area

Membership, benefit addons and model cash top-up are separate tasks. Only the active task shows its catalog or form, with purchase confirmation directly below its selected card. Switching tasks or visiting Orders preserves the selection; switching payer remounts and clears it. A model funding refusal opens the llmrouter cash task without selecting an offer. Unknown-command recovery remains visible even with all buying forms collapsed, and membership status remains visible when the commerce read fails.

### Why consumption has token details

Settled charges, refunds and pending reconciliation are shown before measurement detail. The SuperWagie report has a compact call table; native measurements and legacy Token counters share an expandable detail area while retaining their separate coverage and units. Folding measurements does not change financial totals or imply that unresolved calls are settled.

### Why the username is read-only

UniHub currently exposes safe self-service writes for the display name, avatar,
and password. Renaming a login identifier would require a separate trusted
identity flow and could invalidate active sessions, so the user center does not
pretend that an editable field can change it.

### Why native usage and token coverage remain separate

Native measurements retain operation, key, unit and provider-unit dimensions with exact scaled decimal display. Request-only billing shows requests; legacy token counters appear only when explicit legacy recorded-call coverage is positive, including real covered zero quantities. Missing coverage is unknown. Billing completeness describes settlement and does not establish provider token recording. Native token measurements remain separate from legacy totals. Runtime, actor and payer remount keys clear the report; failed reads cannot become empty usage.

Unavailable catalog offers remain visible with missing CREDIT-rate guidance and disabled purchase selection. A missing readiness field keeps old-server compatibility and explicitly supplies no confirmed readiness check. Wallets, paid rights, order history and existing intent recovery remain independent. A stale-catalog purchase rejected with the exact pre-admission code is FAILED and shows the rate guidance; its original command is not left pending. Other 409 or lost responses retain original-key recovery.

### Why backend services stay out of account navigation

SuperWagie users manage their wallet, subscription and key without administering
billing or routing services. Purpose names replace infrastructure branding while
authoritative ledgers, permissions and recovery remain intact. Separate balances
are retained because visual simplification does not authorize fund migration.

### Why API Key keeps one durable activation

The issuing service cannot replay an issuance request idempotently or return a
lost plaintext token. A private receipt records dispatch before the request,
retains a safely stored key for configuration recovery, and stops another
issuance when the outcome is unknown. The account panel shows a real masked
key only after the server has received and validated it. Per-model success
describes a confirmed request in the displayed batch; it is not a guarantee
about current balance, later revocation or every available model. A new run
identity separates explicit retests from older receipts, while each completed
row remains useful when another model fails or the next poll is interrupted.
