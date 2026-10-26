# Platform account

## Ownership

This module owns UniHub browser and JSON login, registration, the global user gate, self-service profile operations, account projection and sandbox commerce for managed web and desktop backends. UI authentication and device pairing remain in `ui-auth` and `client-auth`. UniHub owns identity, billing membership, credits, funds and account permissions. Platform model transport owns immutable task payer bindings separately.

## Invariants

- The managed server installs `access-gate.js` before bootstrap route registration. Every `/api/*` business request and every host WebSocket upgrade must carry a validated UniHub actor. Identity, runtime pairing, discovery and health metadata remain exact bootstrap exceptions. Missing configuration, external OpenCode, expired sessions and unsupported runtimes fail closed.
- `GET /api/platform-account/session` returns only the verified identity status, public user and expiry. Password login returns this same contract. Financial projection has a separate request, so unavailable balances cannot prevent a valid user from entering the app. The renderer defers workspace bootstrap and app mounting until this identity check succeeds.
- Personal identity reads and profile operations remain valid across billing-account selection. Commerce captures still reject a billing-account change. An authoritative upstream authentication failure revokes the exact captured local session; a late response cannot revoke a newer login in the same runtime namespace.
- Self-service routes capture the current identity session before network IO and reject replacement or expiry before accepting the result. Profile reads and display-name writes expose the fixed provider username, display name, email, avatar availability and version. Only the display name is writable through the profile endpoint; email and login username remain read-only.
- Avatar upload accepts PNG or JPEG bytes up to 512 KiB. UniHub validates dimensions, normalizes the image and stores it privately. Reads proxy only authenticated `/v1/me/avatar` bytes with a bounded size and image type. External avatar URLs are rejected.
- Password changes require the current password. Success invalidates every local session for that user and issuer, and UniHub revokes identity-provider and browser sessions. An uncertain upstream password result also invalidates local sessions and requires a fresh login. This includes a local logout or session replacement racing the successful upstream response. A rejected current password preserves the session. Passwords never enter logs or persisted settings.
- WebSocket upgrades and readable HTTP media/event streams use the same scoped runtime URL-token rules as the existing UI-auth layer. A URL token minted for one readable/socket path cannot authorize another API path. Open responses and sockets are revalidated on a bounded 1 second timer and close after the actor session expires, is replaced or is removed. Already-started background tasks continue under their existing authority.
- Managed agent-tool, limit-failover, notification and Git credential callbacks bypass user-session checks only at exact POST paths after their existing capability authentication succeeds. An absent or invalid service capability receives the ordinary user-session check. Isolated-space container servers receive no environment bypass; their independent UniHub session is required until an explicit delegation contract exists.

- The dedicated `uiAuthController.resolvePlatformAuthContext` validates runtime identity before selecting a server session through an HMAC namespace. Explicit bearers have sole authority; invalid bearers cannot inherit ambient cookies. Passwordless browser identities require the independent signed instance cookie. Session and client identities are distinct. An instance has no global platform user or account.
- Authorization uses Code + S256 PKCE, state, nonce, a fixed redirect URI and signature, issuer and audience verification. Browser login uses its configured public OIDC client; a one-time start ticket and HttpOnly transaction cookie bind the callback. JSON login uses an explicitly configured headless client and verifies its exact audience. Logout and a newer login invalidate pending authorization, including a pending token response.
- Registration forwards the caller's stable idempotency key. `UNKNOWN`, an invalid success payload or a service failure after dispatch preserve uncertainty. Reconciliation sends the original key and metadata without a password. `CREATED` still requires login. No password, token or provider response is logged or persisted; the public error contract contains only known error codes and supported interaction kinds.
- Registration limits match UniHub: display names contain at most 80 Unicode code points; a supplied registration password contains at least 12 code points and at most 72 UTF-8 bytes. UniHub remains authoritative for password complexity and organization policy. A passwordless recovery rejected with `invalid_password` becomes `platform_registration_password_required`; the caller can re-enter a password using the same key and metadata. Other recovery errors do not authorize a new key.
- Access tokens exist only in server memory for at most 1 hour. Refresh tokens are discarded. Restart and expiry require another login. Public responses never contain tokens. Runtime authentication, BYOK configuration and pairing are unchanged by platform logout.
- Account switching verifies current UniHub membership. Failure leaves the previous selection intact. Task transport must capture actor/account before a task starts and must never re-read the current selection to charge an existing task.
- The product client sends no OIDC client secret. Configuration pins the issuer and API URL. Browser login uses `OPENCHAMBER_UNIHUB_CLIENT_ID` and `OPENCHAMBER_UNIHUB_REDIRECT_URI`. JSON login and registration require `OPENCHAMBER_UNIHUB_HEADLESS_CLIENT_ID`; `OPENCHAMBER_UNIHUB_HEADLESS_REDIRECT_URI` defaults to the existing redirect. There is no audience fallback. The console URL is optional. HTTP is allowed only for loopback services. Discovery endpoints share the configured issuer origin.
- Auth-method availability reports local configuration. UniHub still controls whether that client may register or authenticate. MFA, CAPTCHA and policy challenges remain explicit unsupported interactions; a product login cannot bypass them.
- Upstream requests use an exact method and path allowlist. A commerce capture fixes the backend session, actor, account, service URL and client audience. It rejects a changed account or login before and after network IO. A mutation interrupted after dispatch remains uncertain and must be reconciled by its original operation; an HTTP failure is not evidence that no mutation occurred.
- VS Code, external OpenCode and mobile are unsupported in this slice. The shared UI displays that state. The backend refuses external OpenCode independently.
- Account, subscription and credit fetch failures are errors. They never become an empty authoritative balance. Membership is filtered to SuperWagie. Available credits include valid, unfrozen batches only.

## Decisions

### Why the access gate uses actor state

Every business API, including BYOK, requires a UniHub user. The gate reads the bounded local identity session without querying balances, subscription state or financial permissions. Login remains available when financial projection fails, and model funding retains its own authorization.

### Why socket checks run locally

A single timer checks active connections once per second against the account runtime. Logout, expiry and session replacement close those connections within that interval without remote identity requests. Scope validation happens before the URL token's bound identity is selected.

### Why a bounded backend session

The repository has no protected OS credential store. A bounded memory session supports managed desktop and web without placing a refresh token in renderer storage. Desktop uses its existing device identity to select its independent platform session and opens login in the system browser.

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
verify both payment and fulfillment. A backend restart requires sign-in again;
the journal and UniHub orders remain available.

The browser OIDC client and optional console link retain their separate
configuration. Enabling a real merchant in UniHub does not enable real payment
commands in this sandbox-only adapter.
