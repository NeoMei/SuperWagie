# Platform account

## Ownership

The SuperWagie account page owns in-app registration and login, the user center profile and security controls, account selection, membership and credit display, published subscription and add-on choices, and balance-funded commerce controls. `lib/platformAccount.ts`, `lib/platformProfile.ts`, `lib/platformCommerce.ts`, and `lib/platformApiKeys.ts` validate the authenticated runtime HTTP contracts. Existing provider settings retain ownership of BYOK configuration. The backend owns credentials, financial authorization, authoritative balances and durable purchase/recharge recovery.

## Invariants

- The renderer receives public account data and a one-time login initiation URL. Platform access and refresh tokens never reach state, persisted settings or browser storage. Password inputs are cleared before credential requests are sent and unmounted on runtime/account changes.
- Successful password login remembers only the submitted username in browser storage under the connected runtime identity. Reopened login forms restore that username with an empty password. Failed logins do not replace it, transient runtime identities do not share it, and unavailable browser storage never blocks login. Registration recovery takes precedence over the remembered username. Existing server session restoration and expiry remain unchanged.
- The user center reads the profile from UniHub and keeps the login username and email read-only. Users can change the display name, upload a PNG or JPEG avatar up to 512 KiB, and change the password. Avatar bytes stay behind the authenticated runtime route; object URLs are revoked when replaced or unmounted. A successful password change signs the current runtime out and returns to the gate.
- Profile editing uses one compact avatar row with a button-backed hidden file input. Username and email are read-only text, the display name keeps an explicit Save action, and password changes remain a separate form. The session expiry follows the controls. Keyboard activation uses a real button, and the file-format hint is associated with it.
- Avatar file reads capture their profile and runtime owner. If either changes before the file finishes reading, the upload is cancelled before any request is sent. Profile controls belong to the user center, not Settings search.
- Sign-in methods come from the backend configuration. Registration recovery stores only the original idempotency key, username and optional display name/email under the runtime identity. The password is never persisted. Unknown outcomes expose a same-key recovery action without a password; if the backend reports that the original key has no registration record, the form asks for the original password and retries the same key and metadata. Browser storage failure blocks new registration. Display names are limited to 80 Unicode code points. Registration passwords require at least 8 Unicode code points, at most 128 code points and 72 UTF-8 bytes, and no control characters. No baseline composition or username/email exclusion applies. Local validation shows a specific issue while typing and preserves unsent input for correction. Passwords are cleared when dispatched. Whitelisted provider password issues explain explicit organization requirements; malformed or legacy errors use a generic rejection without displaying upstream text.
- Runtime switching invalidates pending reads and clears the displayed account. A failed read or logout clears stale data and retains an explicit refresh action without claiming the user signed out. An explicit platform session expiry restores the sign-in form.
- Registration and login rate limits show a countdown only when the server supplies a positive, bounded `retry_after`. The deadline starts when the response arrives. A leaf notice uses the shared second clock and unsubscribes after expiry or unmount; the form does not re-render on ticks. Editing a password preserves the rate-limit notice. A new attempt or auth-mode/runtime change clears it. Expiry invites an explicit retry and does not claim the backend has unlocked the identity. Missing or malformed timing retains the generic error without inventing a duration.
- Account selection affects future tasks. Model transport must preserve the task's original server binding.
- Independently admitted media tasks appear in paginated account history even
  when managed dispatch is suspended. The server filters the original device,
  actor and current payer; selecting a task's settlement check is explicit and
  never re-dispatches the original model request.
- Model availability and historical recovery availability are separate runtime checks. When dispatch is suspended but the journal can be read, the current session's authenticated task status still shows its fixed payer and model, pending and unknown calls, and terminal receipts. Reconciliation only queries receipts; it cannot submit another model request. An unbound current session shows no task section. Other failures remain visible.
- Membership and add-on credits are separate from CNY model cash. One credit is one CREDIT (1,000,000 CREDIT/6 micro units). The overview omits reserved-point rows, batch-expiry disclosures and legacy CNY balance panels. The underlying holds and cash wallets remain separate accounting data for purchase eligibility and explicit compatibility recharge targets. Original uncertain operations remain recoverable; hiding these panels never migrates or discards funds. Subscription purchases may use an existing authorized funding source server-side.
- Membership balances and offer grants use credits with exact integer arithmetic and insignificant trailing zeros removed. The detailed usage ledger retains its original unit. The renderer never converts ledger quantities to JavaScript Number. Source cards distinguish explicitly attributed SuperWagie subscription/add-on points from other shared points, show their earliest positive-balance expiry, and exclude frozen, future and expired availability. An older server without batches retains the authoritative total with unavailable source detail. Reserved points remain separate in the contract. The expiry-first rule does not promise a new grant after an expired membership; remaining points retain their original expiry and require renewal for SuperWagie use.
- Membership choices are grouped by monthly or annual billing, with an independently priced credit-addon list. Every option prominently shows its published price and credit amount before selection; annual pricing is the whole-year charge and still grants credits monthly. Addons show their own validity and never extend membership. Changing the membership period clears a hidden membership selection; it preserves a selected addon. No selector sends a financial request.
- Cash balances and offer prices preserve CNY/6 precision. Recharge accepts positive whole cents. The chosen offer shows its exact price, product wallet and credit grant before purchase.
- Wallet, catalog and order `null` values mean unavailable permission. They never render as zero balances or empty history. Ordinary members retain access to membership and credits while financial controls remain restricted.
- Consumption records load only the SuperWagie 30-day summary and latest 20 calls. The overview also reads the separate 365-day activity endpoint. There is no source selector or request to native LLMRouter reports. Summary, call-list and activity reads fail independently and distinguish permission denial, errors and authoritative emptiness. Runtime, actor and account remount keys reject stale responses.
- Pending and unknown calls stay visible. Confirmed charges and refunds retain integer precision and are shown separately in CREDIT/6, CNY/6 or LR_QUOTA/0 units. The report does not infer usage from BYOK providers or from local task receipts.
- The default user-center tab is Membership and usage. Profile and security remain reachable through Personal details, including login-session expiry. A managed model funding refusal opens the existing billing tab at the wallet selector and preselects `llmrouter` through the transient `platform-account.model-recharge` target. The target is consumed once, including when commerce is already mounted, and opens only the cash recharge task while retaining any selected offer; the model cash task selects `llmrouter`, and the generic recharge target explicitly selects `superwagie`. The model wallet shows its own funding explanation. Navigation never selects an offer, starts payment, transfers balances or changes a pending command's original product. Funding and refresh do not replay the failed chat.
- Sandbox recharge creation, simulated settlement and purchase are separate explicit actions. Funding a selected offer preserves the selection without buying it. Existing active memberships cannot be purchased again through the ordinary purchase action. Selecting another plan can request an authoritative upgrade quote; only a separate confirmation accepts its exact payment and additional points. Expired quotes can be refreshed. A conclusively rejected `quote_invalidated` upgrade clears the stale quote and permits a new quote; a generic conflict or unknown outcome retains same-key recovery. Quote reads do not change the subscription. Accepting an upgrade uses its durable original idempotency key, including after a lost response. New SuperWagie add-ons require membership; historical shared add-ons retain their original rules.
- The formal credit program is available only when the server explicitly reports native CREDIT readiness. Missing readiness keeps it unavailable. Server-provided purchase readiness disables these offers with a clear explanation; prices are never hardcoded candidate products. Sandbox offers can exercise the flow. An unconfigured external payment gateway does not prevent eligible existing offers from using sufficient authorized balance, but it never creates a QR code or a pretend checkout. Cash funding failures still open the legacy model recharge target, while explicit subscription/add-on targets only open their catalog. No funding action automatically retries a task.
- The backend journals financial commands before contacting UniHub. A lost response exposes same-key recovery, and overview reloads the durable intents after remount. Unknown or prepared intents block new commands. Refresh only reads state; it never settles, purchases or retries a financial command.
- Recharges shown in history are scoped to this instance. Purchase orders come from the server. Payment, fulfillment and refund statuses remain separate.
- The account picker resolves IDs to account names with explicit personal/team labels.
- The desktop and web sidebar avatar opens this page in an independent dialog. Settings navigation, search and the command palette have no account entry. Old Settings account paths resolve through the normal unknown-page fallback. Account sign-out stays inside the user center, and the footer keeps its other actions as separate icons. An unavailable identity read renders a neutral avatar.
- `PlatformAccountDialog` owns the shared dialog chrome, on-demand page loading and shortcut suspension. The avatar and a model funding notice use this same dialog without changing Settings selection. Each trigger owns its open state and retains normal focus restoration. The funding trigger still prepares its one-time wallet target without starting a financial command or replaying chat. This also works without a mounted sidebar, including Mini Chat. VS Code, hosted mobile and Capacitor retain the page's explicit unsupported state; no new account capability or avatar entry is added there. External OpenCode remains refused by the backend.
- The signed-in account page has navigation for Membership and usage, API Key, Consumption records, Orders and Personal details. The top navigation stays in one horizontally scrollable row. Identity, the authenticated portrait, profile editing, payer selection and sign-out occupy a separate column beside the content in wide panes and above it in narrow panes. The identity column scrolls in short windows. Saving a display name or avatar refreshes the identity column; its object URL remains valid across tabs and is revoked on replacement or unmount. Navigation uses ordinary keyboard-focusable buttons with an `aria-current` page marker. It does not issue financial commands.
- Membership and usage starts with published plans for an unsubscribed account. With no membership, available points or reserved points, an empty balance overview is omitted so the plans remain first. A subscribed account starts with membership status and exact credits, with explicit management and add-on actions. Expired memberships with remaining points retain the balance and renewal notice. The two main purchase choices are subscriptions and add-ons; legacy CNY recharge remains reachable through compatible explicit navigation targets and original-operation recovery. The same commerce component stays mounted when switching between overview and orders, preserving its selected offer and original pending command. Orders contains supported subscription and addon history; unresolved intent recovery remains reachable in both views. The same composition is used in Web and Electron. VS Code, hosted mobile and Capacitor mobile keep the explicit unsupported state.
- Infrastructure console links, provider setup links, service names and raw permission scopes are not shown in the user center. The account page presents SuperWagie subscriptions, its addon benefits, purpose-labeled wallet balances and records. Other products' wallets, catalogs and completed history are omitted, but uncertain original operations retain recovery controls and their original server bindings.
- API Key reads the durable activation receipt owned by the current actor, account and service on this runtime. Opening, refreshing and polling only read state. An explicit Activate and configure action issues one account-scoped SuperWagie key, adds a SuperWagie model connection and native provider, and tests the server-selected models using that key. The server owns eligibility, model selection, the maximum of three concurrent probes and serial application of verified feature bindings. An explicit test-and-apply action uses this key for supported default features. Failed applications preserve the corresponding existing configuration. Project and session overrides remain unchanged. This action does not purchase a subscription.
- Before activation, a fresh installation uses the built-in OpenCode free models. Activation and explicit retesting select suitable models from the key's authoritative available catalog for supported purposes. A compatible existing choice is retained; an unavailable or incompatible choice is replaced by a suitable catalog candidate. The panel shows the actual selected model and reports connection only after its probe and application succeed. Unavailable purposes and protected existing knowledge indexes remain explicit partial results. This account setup is supported on Web and Electron; VS Code, hosted mobile and Capacitor mobile retain the explicit unsupported account state.
- Runtime identity refusals explain whether to use the built-in OpenCode or wait for it to start, then refresh before continuing. HTTP failures, durable receipts and per-purpose results use the same guidance and preserve the existing key; none automatically retries issuance or a model call.
- The renderer receives the real key's last four characters, configuration progress and per-model public test receipts, never the token. Each test names its actual purpose and model; a verified probe displays Passed, and only a verified receipt with `applied: true` displays Passed and connected. A verified probe with `applicationError` displays Passed, connection incomplete in warning color with the application-specific reason. It remains counted as a passed test while the feature stays incomplete. A terminal generic `account_key_test_failed` receipt with every probe verified and an explicit application error reports that model calls passed and feature settings need attention; its last step is partially complete. Global failures, unknown outcomes and active work retain their own guidance and progress. Older receipts retain their recorded outcomes. Real tests may consume balance or credits, and another batch requires an explicit action. Application-error guidance asks users to review feature settings or refresh status without recommending another paid probe. Each terminal batch refreshes the provider catalog and an already-mounted model settings page once, including a partially applied batch. Active testing does not trigger this completion refresh. Dirty purpose drafts and session selections remain intact.
- A named setup and connection-test panel keeps the three server-owned stages and masked key beside compact model-result rows. The list grows as the server reports started or terminal tests; queued rows remain hidden and skipped explanations appear only after the batch finishes. Each row keeps a stable identity within its `testRunId`, so a sibling result never remounts or removes completed rows. Running rows use the shared clock Spinner, and ModelTestMotion pauses it for reduced motion or a hidden page. Entry motion runs once and respects reduced motion. The total includes every row, including skipped features. Overall success requires a ready receipt and every row verified and applied. A historical ready receipt with skipped or unapplied rows displays incomplete status. Skipped and failed rows explain unavailable models, authorization, preserved legacy configuration, required knowledge-index rebuilding or unsupported consumers without exposing raw provider errors. No inferred percentage, sub-request log, latency or cost is displayed.
- Submitting an action shows immediate local request progress before a receipt exists. Retesting hides the entire old batch, including its success and timestamps, until a different authoritative run is observed. A lost POST followed by the same old run remains unconfirmed and exposes only read recovery; it cannot redisplay old success or admit another test. A read or POST failure preserves confirmed results from the current run, changes visible running rows to unknown and stops their animation. Unknown results remain distinct from failed tests, and alerts stay inside the panel. Legacy receipts without `tests`, `applied` or `testRunId` never imply all default features were applied; they keep the original evidence and offer an explicit test-and-apply action without inventing model rows.
- Once issuance has been dispatched, an uncertain response cannot create another key. Continue setup reuses a safely stored key; Test and apply to features validates the saved key before a new bounded batch and applies each supported, verified feature. Closing the panel never cancels or replays the server operation. Read failures remain errors rather than an empty state that offers another activation. Permission denial clears the visible receipt. Actor, account and runtime-instance changes discard late results and callbacks, including an A-to-B-to-A runtime visit.
- Enterprise policy blocks activation, configuration and testing at the server boundary; safe receipt reads remain available. The activation receipt is owner-scoped, but native providers and model configuration retain the current server's shared configuration scope. This flow does not provide per-user model invocation isolation or expose other users' keys.

- The activity calendar shows today and the previous 364 UTC dates in seven fixed weekday rows and 53 week columns, with 11-pixel square cells, month/weekday labels and horizontal scrolling in narrow panes. Daily counts come from the runtime's bounded all-page report and preserve integer precision. Arrow keys move by day or week within the calendar; Home and End reach the first and latest dates. Partial reports label observed counts as lower bounds and unfilled dates as unknown. Missing historical dates remain a separate notice. Failed or denied reads never render an empty calendar, and the calendar does not infer charges, local BYOK activity or financial settlement from call counts.

## Decisions

### Why platform sessions require explicit refresh

Browser login opens externally and provides a refresh action after authorization. In-app login receives only the public account result. Commerce refreshes after an explicit action. No persistent polling or cross-window token message is needed.

### Why registration retains metadata without a password

A registration response can be lost after account creation. Keeping the original key and public form metadata across remount permits a same-key status recovery; clearing the password limits credential lifetime. Starting another registration while that outcome is unknown could create a duplicate account.

### Why login remembers only successful usernames per runtime

Restoring the last successful username avoids retyping without retaining a password or replacing a working identifier after a typo. Runtime-scoped storage prevents a connected server from displaying another server's login identifier. Browser storage is optional because it does not authorize access.

### Why recharge and purchase remain separate

The recharge funds one product wallet and can finish after an interrupted request. A separate purchase action lets the person confirm the preserved offer and price after authoritative funding, and prevents refresh or settlement from buying an offer implicitly.

### Why identity and navigation have separate places

The user center is opened as a focused dialog. A top tab row leaves the identity column for the portrait and account controls, while the content keeps the existing membership, points, checkout and order flows. A separate Orders view keeps historical requests out of the overview without hiding unresolved financial outcomes. Subscribers open buying controls explicitly; new users see the published plans first. Selectable offers show their published price, credits and period before confirmation.


### Why membership and addons have separate choices

Monthly and annual membership fees buy a paid service term with monthly credit
grants. Addons buy one extra credit batch with its own expiry. Separate lists
make that difference visible before checkout; the shared confirmation still
binds one published offer and its exact product wallet. Prices and tiers come
from UniHub, with no inferred annual discount or locally invented price. A missing published catalog remains a truthful empty state.

### Why buying tasks share one detail area

Subscriptions and point add-ons share two main choices. Existing cash top-up is a compatibility task opened by an explicit navigation target. Only the active task shows its catalog or form, with purchase confirmation directly below its selected card. Switching tasks or visiting Orders preserves the selection; switching payer remounts and clears it. A model funding refusal opens the llmrouter cash task without selecting an offer. Unknown-command recovery remains visible even with all buying forms collapsed, and membership status remains visible when the commerce read fails.

### Why remaining points use numeric cards

The remaining total comes from the authoritative account projection. Source cards sum only eligible batches and show the earliest expiry among their positive balances. Missing source data retains the total with an unavailable-details notice; explicit empty categories show zero. The response has no original granted-total denominator, so the overview presents exact balances without a percentage. Pending holds, individual batch details and cash balance panels stay outside this overview.

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


## Direct checkout controls

The membership/add-on confirmation includes an explicit payment method when
merchant checkout is configured. Choosing a channel, changing tabs and opening
the account page remain read-only. The legacy cash option remains separate.
Upgrade quotes bind their selected payment source and show the server's exact
cent-rounded external charge before confirmation.

The checkout panel recovers server records after reopening. Waiting, unknown,
paid-but-activating, completed and original-channel refund states stay distinct.
The WeChat QR is generated locally from the validated server session. Alipay
opens the official URL through `openExternalUrl` only after a click. Returning
from the browser cannot prove payment. Status, close and refund controls act on
the original checkout; refund requires a separate visible confirmation. Read
failure preserves the last checkout state with an error and recovery action.
Verified fulfillment refreshes account benefits and never replays a model task.
A `REJECTED` manual refund preserves the confirmed purchase status and shows
that the request was declined without a refund. A paid, fulfilled purchase
remains active. The refund button and any open refund confirmation disappear
on rejection; passive refresh and remount never submit another refund. Other
pending and review refund receipts keep their original explicit recovery.
The server's completed purchase intent permits a later independent purchase;
no wallet balance, credential or original refund identity is changed.

Customer-facing Chinese calls CREDIT benefits 积分; English calls them credits.
Asset identifiers, units, payload fields and legacy cash values are unchanged.

Native key setup presents an explicit cash or credits choice. Selection only
reads the selected mode's receipt; issuing, probing and applying still require
explicit actions. Credits readiness comes from the server, and missing readiness
keeps activation unavailable. A credits refusal opens the existing funding target,
which chooses membership or add-ons from the read membership state. The cash
refusal retains the model cash target. Neither destination starts a payment or
replays the model request.
