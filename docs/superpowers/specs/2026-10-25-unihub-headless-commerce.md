# UniHub registration and sandbox commerce

The maintainer approved this design in chat on 2026-10-25 and selected sandbox transactions because no payment merchant is configured.

## Product behavior

SuperWagie owns registration, password sign-in, account selection, product wallets, membership and addon purchase, and order recovery. UniHub remains authoritative for identity, roles, published prices, cash, subscriptions and model credits. Existing browser OIDC sign-in remains available when configured. Existing BYOK and task-bound llmrouter settlement remain unchanged.

Cash recharge does not grant credits. A purchase debits its product wallet and grants the published entitlement. SuperWagie membership and llmrouter addons show their own funding wallet. A pending payment or fulfillment is never displayed as complete. Sandbox settlement requires a separate explicit action and is labeled as test funds.

## Runtime scope

| Runtime | Behavior |
| --- | --- |
| Managed Web | Authenticated backend owns platform session and commerce intents. |
| Electron macOS and Windows | Uses the same in-process backend and shared UI; no new shell privileges. |
| VS Code | Existing explicit unsupported account state. |
| Hosted mobile | Existing explicit unsupported account state. |
| Capacitor | Existing explicit unsupported account state. |
| External OpenCode | Backend refuses platform account and commerce operations. |

Identity and financial requests contain only data needed by UniHub. They send no conversation content and create no provider entry. Existing enterprise policy continues to block platform model IO; the page retains the model-unavailable explanation. This change introduces no policy exception.

## Identity

An explicit headless client ID is configured separately from the browser OIDC client. No fallback grants the old client new scopes. Tokens stay in backend memory, at most one hour; passwords are never persisted. Registration and authorization use fixed configured client/redirect values. JSON authorization uses S256 PKCE, state and nonce with signature, issuer, audience and subject validation. Missing refresh, MFA continuation and account recovery capabilities are displayed accurately.

An uncertain registration retains its original key and nonsecret metadata. Recovery never changes the key or retries password authorization/token exchange automatically. Logout invalidates pending login and captured commerce sessions.

## Financial correctness

Every mutation binds the current runtime session, actor, account and UniHub service before network IO. The submitted account must match the selected account. Scope and current role are rechecked. The published catalog supplies purchase price, product and account eligibility. Quantities use canonical decimal integer strings and BigInt formatting.

The backend writes each financial intent durably before sending it. It persists the original key, immutable nonsecret command and returned resource IDs. It stores no credentials or passwords. Interrupted calls remain unknown. Passive refresh only reads. Explicit recovery may query a known object, or repeat an unresolved creation with exactly the original payload and idempotency key. It never creates a replacement charge.

UniHub lacks a recharge listing endpoint, so recharge history is explicitly limited to intents created by this server instance. Purchase history comes from UniHub. Missing financial scopes and roles are distinct from empty wallets and orders. A backend restart preserves intents; renewed authentication rechecks ownership before recovery.

## Delivery boundary

This slice includes sandbox registration, account and purchase flows with tests and local UI acceptance. It does not integrate a real payment provider, change commercial prices, deploy services, publish installers, add dependencies, or run Git/GitHub commands. Native installed-app and real-model acceptance must be reported separately from local tests.
