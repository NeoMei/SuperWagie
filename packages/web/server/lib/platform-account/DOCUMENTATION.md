# Platform account

Managed SuperWagie uses the published UniHub model catalog when no local model
override is present. The gateway is `https://llmrouter.quukk.com/platform/v1`.
Set `OPENCHAMBER_UNIHUB_DISABLED=1` or `OPENCHAMBER_UNIHUB_MODE=off` to disable
the managed provider; these switches take precedence over explicit gateway and
model overrides. Local OpenCode/BYOK providers remain independent.

## Ownership

This module owns UniHub browser and JSON login, registration, the global user gate, self-service profile operations, account projection, personal API key metadata reads and sandbox commerce for managed web and desktop backends. UI authentication and device pairing remain in `ui-auth` and `client-auth`. UniHub owns identity, billing membership, credits, funds and account permissions. Platform model transport owns immutable task payer bindings separately.

## Invariants

- The account projection reports `modelRecoveryAvailable` separately from
  `modelService`: a suspended model runtime can still allow the original
  authenticated owner to read and reconcile an existing task. This flag
  indicates local journal availability, not permission to read a task or its
  generated artifacts; the model routes enforce identity and payer checks.
- The managed server installs `access-gate.js` before bootstrap route registration. Every `/api/*` business request and every host WebSocket upgrade must carry a validated UniHub actor. Identity, runtime pairing, discovery and health metadata remain exact bootstrap exceptions; the GET-only preview, guest-file and guest OAuth callback paths carry their own capability and are validated by their owning routes. Missing configuration, external OpenCode, expired sessions and unsupported runtimes fail closed.
- `GET /api/platform-account/session` returns only the verified identity status, public user and expiry. Password login returns this same contract. Financial projection has a separate request, so unavailable balances cannot prevent a valid user from entering the app. The renderer defers workspace bootstrap and app mounting until this identity check succeeds.
- Personal identity reads and profile operations remain valid across billing-account selection. Commerce captures still reject a billing-account change. An authoritative upstream authentication failure revokes the exact captured local session; a late response cannot revoke a newer login in the same runtime namespace.
- Self-service routes capture the current identity session before network IO and reject replacement or expiry before accepting the result. Profile reads and display-name writes expose the fixed provider username, display name, email, avatar availability and version. Only the display name is writable through the profile endpoint; email and login username remain read-only.
- Profile and avatar GET/HEAD reads accept a missing Origin only when Fetch Metadata explicitly reports `Sec-Fetch-Site: same-origin`. Explicit origins still require the configured origin check, including packaged desktop origins. Writes always require that check. Runtime authentication and the platform access gate remain mandatory, and reads accept no URL-token identity.
- Avatar upload accepts PNG or JPEG bytes up to 512 KiB. UniHub validates dimensions, normalizes the image and stores it privately. Reads proxy only authenticated `/v1/me/avatar` bytes with a bounded size and image type. External avatar URLs are rejected.
- Password changes require the current password. Success invalidates every local session for that user and issuer, and UniHub revokes identity-provider and browser sessions. An uncertain upstream password result also invalidates local sessions and requires a fresh login. This includes a local logout or session replacement racing the successful upstream response. A rejected current password preserves the session. Passwords never enter logs or persisted settings.
- WebSocket upgrades and readable HTTP media/event streams use the same scoped runtime URL-token rules as the existing UI-auth layer. A URL token minted for one readable/socket path cannot authorize another API path. Open responses and sockets are revalidated on a bounded 1 second timer and close after the actor session expires, is replaced or is removed. Already-started background tasks continue under their existing authority.
- Managed agent-tool, limit-failover, notification and Git credential callbacks bypass user-session checks only at exact POST paths after their existing capability authentication succeeds. An absent or invalid service capability receives the ordinary user-session check. Isolated-space container servers receive no environment bypass; their independent UniHub session is required until an explicit delegation contract exists.

- The dedicated `uiAuthController.resolvePlatformAuthContext` validates runtime identity before selecting a server session through an HMAC namespace. Explicit bearers have sole authority; invalid bearers cannot inherit ambient cookies. Passwordless browser identities require the independent signed instance cookie. Session and client identities are distinct. Without an explicit instance-owner policy, an instance has no global platform user or account.
- Authorization uses Code + S256 PKCE, state, nonce, a fixed redirect URI and signature, issuer and audience verification. Browser login uses its configured public OIDC client; a one-time start ticket and HttpOnly transaction cookie bind the callback. JSON login uses an explicitly configured headless client and verifies its exact audience. Logout and a newer login invalidate pending authorization, including a pending token response.
- Registration forwards the caller's stable idempotency key. `UNKNOWN`, an invalid success payload or a service failure after dispatch preserve uncertainty. Reconciliation sends the original key and metadata without a password. `CREATED` still requires login. Passwords and provider responses are never logged or persisted. The access-token session is persisted only in the encrypted, mode-`0600` backend store described below; the public error contract contains only known error codes, supported interaction kinds and allowlisted password issue codes.
- Upstream `rate_limited` errors retain a validated positive integer wait of at most 86400 seconds through `retry_after` and the numeric `Retry-After` response header. Valid JSON metadata takes precedence; a bounded numeric upstream header is the fallback. Missing, malformed, zero, negative and excessive waits keep the generic error, and other error codes never receive wait metadata. The adapter does not infer a cooldown, parse HTTP-date wait headers or retry a registration, password authorization or token exchange automatically.
- Registration limits match UniHub: display names contain at most 80 Unicode code points; a supplied registration password contains 8 to 128 Unicode code points, at most 72 UTF-8 bytes and no control characters. The adapter adds no composition, username or email exclusion rule. UniHub remains authoritative for explicit organization policy. `invalid_password` errors may include `password_issues` containing only `too_short`, `too_long`, `too_many_bytes`, `control_character`, `letter_case_and_digit_required`, `special_character_required` or `repeated_character`; absent or malformed metadata retains the generic error. New profile passwords also accept the 8-character minimum, while current-password login remains unchanged. A passwordless recovery rejected with `invalid_password` becomes `platform_registration_password_required`; the caller can re-enter a password using the same key and metadata. Other recovery errors do not authorize a new key.
- The managed backend keeps the current UniHub access-token session encrypted in `$OPENCHAMBER_DATA_DIR/platform-account-sessions.json`, with an opaque identity index, atomic writes and `0600` file permissions. The file never contains the raw runtime identity or a plaintext token, and public responses never contain tokens. Approved UniHub clients also return an opaque refresh token; the backend stores it in the same encrypted record with a 30-day refresh expiry and rotates it before the one-hour access token expires. A restart restores both credentials without exposing either token to the renderer. If the refresh family is expired, revoked or rejected by UniHub, the local session is cleared and the UI asks for a fresh login. Runtime authentication, BYOK configuration and pairing are unchanged by platform logout.
- Account switching verifies current UniHub membership. Failure leaves the previous selection intact. Task transport must capture actor/account before a task starts and must never re-read the current selection to charge an existing task.
- The server-only knowledge result reader binds a current user session, payer, model and task to a fresh task credential. It sends the current access token only to the configured HTTPS gateway, refuses redirects and caps the response. It rechecks the session before returning bytes. It is not a browser API and does not expose either token to WeKnora. The gateway validates the original call, current account membership and settlement; a later revocation can race that point-in-time check.
- The server-only managed knowledge adapter keeps the original access token and task credential inside the account runtime. Paid preflight and dispatch accept only the two fixed model/wire pairs and use both credentials at the trusted HTTPS gateway. Embedding requests keep the public UniHub model and 1024 dimensions; when `encoding_format` is present, only `float` is accepted. Rerank requests keep the nested native input and parameters body. Both dispatch the validated caller bytes unchanged. `index_read` uses only the captured original access token and has no task or dispatch headers. It returns route metadata without paid authority, including a nonnegative upstream access version that remains separate from the local account version. Network operations check the same login and account version before and after IO.
- Managed result evidence comes from one no-store HTTPS response. The adapter hashes the exact body bytes and validates the receipt from that response, including duplicate fields, schema, identity, task, call, current reader credential, settled status, model, wire, expiry and body digest. The historical producer and pin remain historical facts; a consumer checks the active route before reuse. Raw credentials and encoded receipts stay private.
- Managed knowledge preflight, route reads, dispatch and result reads refuse external gateways in enterprise mode. Loopback-only gateways remain local to the machine.
- The product client sends no OIDC client secret. Configuration pins the issuer and API URL. Browser login uses `OPENCHAMBER_UNIHUB_CLIENT_ID` and `OPENCHAMBER_UNIHUB_REDIRECT_URI`. JSON login and registration require `OPENCHAMBER_UNIHUB_HEADLESS_CLIENT_ID`; `OPENCHAMBER_UNIHUB_HEADLESS_REDIRECT_URI` defaults to the existing redirect. There is no audience fallback. The console URL is optional. HTTP is allowed only for loopback services. Discovery endpoints share the configured issuer origin.
- Auth-method availability reports local configuration. UniHub still controls whether that client may register or authenticate. MFA, CAPTCHA and policy challenges remain explicit unsupported interactions; a product login cannot bypass them.
- The auth-method response includes a same-issuer password recovery URL when UniHub is configured. The UI opens that provider-owned page in the system browser; SuperWagie never handles or stores recovery passwords.
- Upstream requests use an exact method and path allowlist. A commerce capture fixes the backend session, actor, account, service URL and client audience. It rejects a changed account or login before and after network IO. A mutation interrupted after dispatch remains uncertain and must be reconciled by its original operation; an HTTP failure is not evidence that no mutation occurred.
- VS Code, external OpenCode and mobile are unsupported in this slice. The shared UI displays that state. The backend refuses external OpenCode independently.
- Account, subscription and credit fetch failures are errors. They never become an empty authoritative balance. Membership is filtered to SuperWagie. Available credits include valid, unfrozen batches only.

- Usage reads only the selected billing account, checked before and after upstream I/O. The two report pairs use fixed UniHub routes: product `/usage/summary` and `/calls?limit=20` under `usage:read`; LLMRouter `/model-pool/usage/summary` and `/model-pool/calls?limit=20` under explicit `usage:llmrouter`. UniHub enforces client instance, account role and the LLMRouter native `product_runtime` filter. The adapter verifies the returned scope and row bindings, strips identity and provider fields, and omits finance fields from actor-only reports. Missing scope or an invalid response is an error.
- Signed-in quick setup may POST the fixed UniHub account model-discovery path. UniHub applies the registered catalog scope and account policy before returning model metadata. Other methods and subpaths are not allowed.
- Authorized usage reports retain UniHub's confirmed charged and refunded amounts even when a later operation leaves the call `UNKNOWN`. Call status and completeness remain authoritative; an unknown operation neither erases confirmed amounts nor turns held funds into a confirmed charge.
- Failed usage reads recheck the captured login and account selection before applying authentication failure. A stale response returns `platform_session_changed` without revoking the current session or broadcasting expiry. An authoritative 401 for the current selection still revokes that login and returns `platform_session_expired`.
- Reporting reads existing records from the configured identity and billing service. It submits no new usage, prompt or telemetry and adds no gateway or provider egress. The account gate and managed web/desktop support are unchanged; VS Code, hosted mobile, Capacitor and external OpenCode remain unsupported.
- `GET /api/platform-account/api-keys?accountId=...` reads existing UniHub managed API key metadata for the selected account. It captures the refreshed login and account selection, checks both before and after upstream IO (including failures), and never lets a stale authentication response revoke a newer selection or login. UniHub checks its registered `model-credentials:write` scope, client instance and current account role. The adapter additionally filters by the captured actor, account and `superwagie` product, including for account owners and billing administrators.
- The key response is `{ accountId, keys: [{ id, name, createdAt, expiresAt, revokedAt }], incomplete }`; expiry and revocation may be null. IDs are record identifiers, not usable keys. Credentials, digests, masks, model scopes and internal ownership fields are not projected. A malformed list or failed read remains an error. `incomplete` is true when the original upstream list reaches its 500-row cap, before owner filtering, and does not claim that older keys are absent. No key is issued, revealed, copied, revoked or configured by this read, and it does not describe LLMRouter native keys or host-wide model connections. This fixed identity/billing-service read remains available in enterprise mode and adds no provider entry, model request, listener or telemetry.

## Decisions

### Why identity reads restore account-key consumer ownership

After a successful identity or account read, the server can restore the current
account-key receipt's in-memory owner. This hook never issues a key, starts a
probe or changes selected models. A missing receipt or a consumer recovery
failure leaves the verified identity usable. Identity is checked again after
the hook; account projections also retain their original payer fence.

The captured commerce session allows model discovery, key issuance and exact
same-key model-scope additions only for its selected account. Scope additions
retain the existing credential and use the server's registered product and
instance, with ownership and eligible models enforced by the account service.

### Why API key records are filtered again for the current user

UniHub permits account owners and billing administrators to list other members' keys. The personal user center exposes only the current actor's records, so the adapter filters server-side and projects only stable identifiers and timestamps. The upstream service stores only key digests; inventing a mask or reading a host-wide model connection would misrepresent both the credential and its owner.

### Why the access gate uses actor state

Every business API, including BYOK, requires a UniHub user. The gate reads the bounded local identity session without querying balances, subscription state or financial permissions. Login remains available when financial projection fails, and model funding retains its own authorization.

### Why socket checks run locally

A single timer checks active connections once per second against the account runtime. Logout, expiry and session replacement close those connections within that interval without remote identity requests. Scope validation happens before the URL token's bound identity is selected.

### Why the backend session store is encrypted and bounded

The repository has no shared protected OS credential store, while the managed
web and desktop backends need the same restart behavior. The session store keeps
 an encrypted access-token session and, for approved clients, its opaque refresh
 token under the existing data directory, keyed by a hash of the validated
 runtime identity. The access token remains bounded to 1 hour; renewal happens
 through UniHub's one-use rotating refresh grant, never by extending an access
 token or storing a provider password. Desktop uses its existing device identity
 to select its independent platform session and opens login in the system
 browser.

### Why managed knowledge requests stay in the account owner

The account runtime owns the current access token and selected payer. Its knowledge adapter captures that session and keeps credentials inside server-side closures while it calls the fixed LR routes. `index_read` has a separate request shape and cannot issue paid dispatch authority.

### Why the callback uses a browser bridge

The system browser cannot send the desktop device bearer. A 5 minute, single use start ticket transfers only login initiation to that browser. The resulting platform session is attached to the original validated device namespace. Neither start nor callback grants runtime access.

### Why JSON login has a separate configured client

The existing browser audience retains its original permissions. An explicit headless client gives deployment control over registration and commerce scopes, while preserving the browser flow for existing installations. A configured form can still receive a service policy refusal.

### Why registration uncertainty retains the original key

An identity insert can succeed before the response or local persistence fails. The original key and nonsensitive metadata let UniHub read that registration; issuing a new key could attempt another identity creation.

### Why platform login does not install a model provider

Adding a provider requires immutable task identity and durable model call recovery. Account login displays membership and credits. The injected model-runtime availability check controls whether the page offers platform model guidance. That check reports configured managed service availability, while task settlement remains an independently queried authoritative state. Identity reads contain no conversation content and create no provider entry.

## Sandbox commerce

The commerce adapter owns product-wallet recharge intent, sandbox settlement,
first or expired membership purchases, add-on purchases, and read-only order
projection. UniHub owns prices, membership authorization, wallets, payment
operations and fulfillment. The adapter neither calculates model charges nor
uses a redirect or HTTP success as evidence of funds arriving.

- Commerce captures the verified actor, selected account, service namespace and
  backend session before work begins. Its request closure rejects account or
  session changes. Financial actions recheck membership, financial role and
  product scopes against UniHub; caller-supplied account IDs must match.
- This release accepts only sandbox recharge and sandbox published offers.
  Settlement requires an explicit action and authoritative sandbox capability.
  Non-sandbox mutations are refused even when the caller has a wallet balance.
- Cash values remain canonical decimal integer strings in CNY/6. External
  recharge amounts must be positive whole cents. An add-on is charged against
  its own llmrouter wallet; it is never charged to SuperWagie's wallet by inference.
- A fresh active membership cannot be purchased again through this flow.
  Upgrades and renewal use separate UniHub contracts and are not exposed here.
- The private `unihub-commerce/state.json` journal persists actor, account,
  service namespace, idempotency key, original amount or offer, status and object
  IDs before network mutation. It stores no token, password, balance or model
  content. Service namespaces include API URL and authenticated client ID.
- Passive overview requests never submit financial commands. Explicit recovery
  reads a known object; if the original response was lost before its ID was
  saved, recovery resubmits only the original payload and idempotency key. A
  repeated request with changed parameters is rejected.
- Recharge creation remains pending until the associated UniHub ledger
  operation is APPLIED. Purchases display payment and fulfillment independently;
  their local intent is applied only once payment is PAID and fulfillment is
  FULFILLED. Response loss remains UNKNOWN and prevents the same actor from
  starting another uncertain operation on that account.
- Financial read failures remain errors. Missing financial scopes produce
  explicit null collections with missing-scope metadata, and nonfinancial roles
  receive no financial order or local intent list. Local intents also require
  the current read scope for their kind; scope revocation hides their projection
  while retaining unresolved write guards. Empty authorized results are
  represented by empty arrays.
- Local recharge history covers this instance and the authenticated actor only.
  UniHub purchase orders are queried from the service. The adapter makes no
  cross-device completeness claim because UniHub has no recharge-list endpoint.
- The journal has one writer per data directory, atomic fsync-backed writes and
  an 8 MiB limit. A second writer, corrupted state or stale lock fails closed.
  Graceful shutdown waits for active commands and releases its own lock. After a
  crash, an operator must stop all processes using the data directory, preserve
  `state.json`, and remove only `unihub-commerce/writer.lock` before restarting.

### Why recovery requires an explicit action

A response can disappear after funds were applied. Persisted keys let UniHub
return the original result, while an explicit recovery action prevents page
mounts, refreshes and account switches from initiating payments.

### Why registration and commerce use separate requests

Registering creates an identity. Creating a recharge, confirming sandbox funds
and purchasing an offer have separate idempotency and authorization boundaries.
The UI can resume each step without assuming a later step succeeded.

## Sandbox setup

Registration and login can be enabled before model integration. Set the 4
identity variables below; leave `OPENCHAMBER_UNIHUB_GATEWAY_URL` and
`OPENCHAMBER_UNIHUB_MODELS` unset. The account response reports
`modelService: unavailable` while registration, login and logout remain usable.
UniHub still needs its identity service, database and ledger dependencies.

The headless client must enable registration and password login, map to
SuperWagie, and allow `accounts:read`, `subscriptions:read` and `credits:read`
for the account page. Self-service nickname, avatar and password writes also
require `profile:write`. Membership and credit reads are part of the separate
account projection. If they fail, the page reports an error while personal
profile controls remain available. No membership purchase or model credential
is required to sign in.

Configure these values in the managed backend's environment and restart it:

| Variable | Value |
| --- | --- |
| `OPENCHAMBER_UNIHUB_ISSUER` | The issuer used by the UniHub identity service. |
| `OPENCHAMBER_UNIHUB_API_URL` | The UniHub API origin. |
| `OPENCHAMBER_UNIHUB_HEADLESS_CLIENT_ID` | A public client explicitly enabled for JSON login and registration. |
| `OPENCHAMBER_UNIHUB_HEADLESS_REDIRECT_URI` | The exact redirect registered for that client. JSON login does not navigate there. |

For sandbox commerce, the client also needs commerce capabilities in
UniHub. `/v1/capabilities` must report sandbox mode and product-wallet recharge
availability. Published sandbox SuperWagie memberships and llmrouter addons
populate the catalog. Missing scopes are shown in the account page. Financial
actions require the account's current owner or billing administrator role.

Register and sign in at the app's login screen. Open Settings > User center to
edit the profile or password. Open its membership and recharge tab to select an offer.
Fill its recharge amount, create the sandbox recharge, and select Simulate
settlement in the request history. Check the original request until UniHub
reports the ledger operation as applied. Confirm the purchase separately and
verify both payment and fulfillment. A backend restart restores a valid platform
session from the encrypted local store; an expired access token requires sign-in
again. The journal and UniHub orders remain available.

The browser OIDC client and optional console link retain their separate
configuration. Enabling a real merchant in UniHub does not enable real payment
commands in this sandbox-only adapter.

## Optional instance-owner HTTP access policy

A deployment may explicitly pin the existing instance to one UniHub user by
setting both `OPENCHAMBER_UNIHUB_INSTANCE_OWNER_ISSUER` and
`OPENCHAMBER_UNIHUB_INSTANCE_OWNER_USER_ID` in the trusted server environment.
The issuer must exactly match the verified session issuer and the user ID must
match the verified session user. The chosen user can continue using the same
instance across devices and billing-account changes. A different user is
refused by the common business API and WebSocket authorization gate. Incomplete
settings fail closed. With both settings absent, existing behavior is unchanged.

The operator must establish the owner independently before setting this policy.
A first browser login does not claim or migrate existing data. Restarting the
server with different environment values changes the policy, so deployment
configuration must be protected and any prior data attribution resolved.
Existing grant-only preview and guest URLs remain bearer capabilities, and
trusted service callbacks use their own credentials. The policy does not
isolate OpenCode, plugins or tools sharing the operating-system user or their
inherited credentials. It is not sufficient to run untrusted extensions or
multiple users against a shared runtime.

### Native usage and CREDIT sales readiness

Usage summaries preserve optional `native_usage` operation/measurement dimensions and `usage_coverage` canonical decimal counts after the existing scope and finance checks. Missing coverage from an older server remains absent. Native quantities use exact decimal strings, scales 0 through 9, unique operation/dimension keys, known units and compatible operations. Aggregated values may exceed the 38-digit per-call limit; the adapter bounds totals and coverage at 1024 digits, groups at 10 and dimensions at 4096 per operation. Integer dimensions require scale 0. No provider token observations are inferred from settled counts or billing completeness.

Catalog offers preserve optional transport-only `sales_readiness` as public `salesReadiness`. Absence supplies no readiness evidence and retains old-server purchase compatibility. Existing orders, balances and recovery reads do not depend on current sale readiness. Only a purchase rejected with exact `credit_rates_unavailable` and HTTP 409 marks its dispatched intent FAILED without a resource ID. Other conflicts and uncertain failures retain UNKNOWN and same-key recovery. UniHub owns the pre-admission guarantee that this rejection creates no new order or billing command; the BFF never infers that guarantee from a generic HTTP status.
