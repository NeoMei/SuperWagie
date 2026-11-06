# SuperWagie single-key LLMRouter contract

Status: implementation contract, approved product scope from the current user instruction. Existing release and paid-validation authorization remains in effect. The implementation reuses LLMRouter's existing prices and native price calculations, with the original Key and payer.

## Authority and compatibility

LLMRouter owns the available model catalog, route selection, capability descriptions and price calculation. UniHub owns identity, account membership, Key lifecycle, subscription eligibility, budgets and ledger execution. SuperWagie owns feature selections, configuration and progressive tests.

Existing selected-scope credentials keep their current contract. Dynamic scope is explicit, only for registered SuperWagie product instances using prepaid_cash and CNY/6. Task credentials remain selected-scope. Current API Key upgrades retain token/hash, ID, actor, account, origin, instance, expiry, funding address and limits. They do not migrate identities, balances or native credentials. The product wallet remains the existing llmrouter wallet, including a selected team payer.

## Key and discovery API

API Key metadata gains `model_scope`, `pricing_source` and `credential_version`.

- `model_scope`: `selected` by default; `llmrouter_available` for dynamic scope.
- `pricing_source`: `llmrouter_native` for dynamic scope; the selected path retains existing pricing.
- `credential_version`: positive, monotonically increments when scope changes; unchanged on an idempotent repeated upgrade.
- `models`: selected-scope authorization or retained historical snapshot. It has no authority for dynamic scope. An explicitly dynamic new key can have an empty historical array.

Creation accepts `model_scope`. Existing-Key upgrade is:

```http
POST /v1/accounts/{account}/api-keys/{key}/scope
Content-Type: application/json

{"model_scope":"llmrouter_available","origin_product_id":"superwagie","instance_id":"default"}
```

The upgrade returns current API Key metadata, without its token. It is an atomic, audited selected-to-dynamic transition under the existing payer and credential locks. Cross-account, inactive actor, revoked/expired Key, wrong product/instance and unsupported funding modes fail before mutation.

`POST /v1/accounts/{account}/model-discovery` accepts `model_scope`, defaulting to selected. Dynamic discovery validates the authenticated caller and payer, then proxies the LLMRouter catalog. It does not intersect with a second model allowlist or central per-model rate table. Discovery retains its existing model representation.

LLMRouter implements `POST /internal/v1/provider-catalog`, authenticated by a dedicated server credential. Its body contains `origin_product_id`, `instance_id`, `actor_id`, `account_id`. The response echoes those fields and contains `schema_version: 1`, `catalog_version`, `model_scope: "llmrouter_available"`, `pricing_source: "llmrouter_native"`, and models. Routing groups are selected by server configuration, never by the caller. Catalog failure stays a failure, not an empty successful catalog. The actual Key's `GET /v1/models` reports the same authority with current per-Key executable capabilities.

## Native pricing API

The existing authenticated LLMRouter service gets two additional UniHub routes. The desktop cannot submit monetary amounts to these routes.

```http
POST /internal/v1/calls/native-reserve

{"credential":"<existing key kept in process memory>","instance_id":"default","task_id":"","call_id":"<stable call id>","request_digest":"<request sha256>","model":"<public model>","wire_operation":"<operation>","quote":{}}
```

`quote` contains these exact fields:

```json
{
  "pricing_version": "lr-native-v1",
  "pricing_digest": "<sha256 of the persisted complete native price snapshot>",
  "billing_model": "<native billing model>",
  "wire_operation": "<operation>",
  "route_id": "0",
  "channel_id": "1",
  "group": "<server-selected native group>",
  "native_quota_max": "0",
  "conversion": {
    "version": "lr-quota-usd-cny-v1",
    "numerator": "1",
    "denominator": "1",
    "rounding": "lr-cumulative-ceil-v1"
  },
  "asset": "CNY/6",
  "max_amount": "0"
}
```

Numeric strings above illustrate encoding only. Actual conversion values are captured from the existing native CNY conversion owner, never these illustrative numbers. `route_id` is "0" for a legacy route. `channel_id` is positive. Quota is nonnegative and bounded by the existing native quota maximum. Conversion integers are positive. The maximum amount equals the existing cumulative ceiling conversion of maximum quota. Free native calls allow zero quota and amount. LLMRouter persists the full native price snapshot before provider dispatch and checks its digest during recovery.

```http
POST /internal/v1/calls/{call}/native-settle

{"pricing_digest":"<same digest>","native_quota":"0","amount":"0","provider_cost":"0"}
```

`usage` and `provider_cost` are optional and retain existing validated representations. The actual amount must equal the frozen conversion of actual native quota. A changed digest or incompatible replay conflicts. Old settle rejects native calls; native settle rejects old selected calls. Existing authenticated top-up, release and call read paths are reused with the same payer and Key budget checks. Above-held settlement requires a successful top-up before final settlement; failure leaves a recoverable pending obligation. It never silently truncates the charge or books a platform difference. Zero-price calls retain call/settlement evidence and generate no zero-value ledger postings.

Each authorization and reservation rechecks current identity, account membership, product/subscription access, scope version, expiry/revocation, budget and route availability. Completed financial obligations remain reconcilable under the existing terminal-decision rules. An uncertain provider dispatch is not retried or refunded without evidence.

## LLMRouter execution

Dynamic scope retains managed credential authentication and immutable task ownership. It reuses native catalog, channel and pricing helpers, while managed Key budgets and funding remain authoritative. The implementation does not create a shadow native Token or admit the external Key through ordinary TokenAuth/local-quota fallback. PlatformMode continues to prevent a second local quota deduction; a distinct pricing strategy selects native prices.

Chat metadata must describe actual supported chat operations. `operation_authorization_unknown` is not an explicit denial. Authorized executable operations get authoritative metadata; unsupported adapters retain an explicit reason and never appear verified. OCR/video private reads remain bound to credential ID, actor, account, origin and instance. The OCR document endpoint must return the canonical document expected by SuperWagie after current-owner and settlement checks.

## SuperWagie behavior

Account activation and explicit retest create or upgrade dynamic scope on the same Key. Discovery before issuance uses the authenticated proxy; subsequent probes use that Key against LLMRouter. Feature selection never narrows Key authority. There is no 32-model union or 100-model authorization snapshot for dynamic scope. Network/schema size bounds remain explicit failures rather than silent truncation.

The native SuperWagie provider registers the complete current chat directory. Refresh supports additions and removals, guarded against concurrent manual edits. Existing purpose model IDs, dimensions, voice and language are preserved. An ID absent from the authoritative router catalog remains visibly unavailable; no automatic substitution or transfer of local vendor secrets occurs.

Testing covers configured model purposes, with at most three concurrent probes and progressively revealed rows. Applying successful results remains serialized and conflict checked. Failures stay per-row. All-model authorization does not trigger paid calls for every catalog entry. Quick setup must reuse the same owned account Key; ordinary BYOK and foreign selected-scope Keys retain their contracts.

## Required evidence

Verify one unchanged Key with more than 32 models and a newly enabled model without another scope mutation; legacy selected Keys remain narrow. Verify ownership, team payer, original wallet address, subscription, revoke/expiry, budget races, exact replay/conflict, zero-price calls, above-held settlement and uncertain recovery. Verify native price equivalence and no local double charge. Probe configured modalities with the actual existing Key only after deployment identity and ownership are checked, then read back settlements. Release and installed-client acceptance are reported separately.
