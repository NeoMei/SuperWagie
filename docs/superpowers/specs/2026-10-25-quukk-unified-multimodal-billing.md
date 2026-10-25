# quukk unified model and billing design

## Current delivery scope

On 2026-10-26 the maintainer prioritized UniHub registration, login, account
readback and logout. Model integration and billing expansion are deferred.
The multimodal contracts below remain proposals, outside this identity delivery.
The account setup and supported runtimes are documented in
`packages/web/server/lib/platform-account/DOCUMENTATION.md`.

## Goal

Expose one user-facing model provider named `quukk` in SuperWagie. UniHub owns identity, account selection, memberships, wallets, credits and orders. llmrouter owns provider routing, upstream attempts, usage observation and settlement. The existing internal provider identifier `unihub` remains stable for saved OpenCode sessions and old task journals.

The sandbox phase must cover registration, password login, account selection, product-wallet recharge, explicit settlement, membership/add-on purchase, text model usage, and durable receipt readback. The same account model will later support production payment without moving balances into SuperWagie.

## Current evidence

The current sandbox path has already been exercised against an isolated Casdoor, PostgreSQL, Formance, UniHub, llmrouter and SuperWagie stack. A synthetic account registered and logged in, funded a CNY 1 SuperWagie wallet, purchased a monthly membership, called two quukk models, and read back two SETTLED calls charged 20 and 40 CREDIT/6. The remaining membership balance was 0.999940 CREDIT/6. The visible provider label is now `quukk`; the internal `unihub` identifier stays unchanged for compatibility.

## Unified operation contract

Every billable operation receives a short-lived UniHub model grant bound to actor, account, origin product, task, operation, model and an idempotency key. The grant is held by the managed backend and never enters renderer storage, bundled skill environment variables or a URL.

llmrouter exposes operation-specific platform routes that share admission and receipt semantics:

- `POST /platform/v1/chat/completions`
- `POST /platform/v1/responses`
- `POST /platform/v1/embeddings`
- `POST /platform/v1/rerank`
- `POST /platform/v1/multimodal/embeddings`
- `POST /platform/v1/audio/speech`
- `POST /platform/v1/audio/transcriptions`
- `POST /platform/v1/images/generations`
- `POST /platform/v1/images/edits`
- `POST /platform/v1/ocr`
- `POST /platform/v1/videos`
- `GET /platform/v1/calls/:callID`
- `GET /platform/v1/jobs/:jobID`
- `GET /platform/v1/jobs/:jobID/content`

The route strips caller-selected account, token, channel, group and provider headers. It validates operation, model, body bounds and media hashes before reservation. A dispatched call is never posted again after an ambiguous response. A terminal receipt or an explicit release is required before the next operation can use that task.

## Metered billing

The current five token buckets remain compatible as `exclusive_v1`. New operations use a versioned `metered_v2` rate with explicit integer-string units. UniHub publishes one rate per model, operation and asset. The gateway extracts usage from validated provider responses and never accepts a client-supplied final charge.

Initial meter vocabulary:

| Operation | Default measured units |
| --- | --- |
| Chat, responses, vision | input tokens, output tokens, cache read, cache write, reasoning tokens |
| Text embedding | input tokens |
| Rerank | input tokens or published document units |
| Multimodal embedding | text input tokens, visual input tokens, total vectors |
| Speech-to-text | provider audio seconds or input audio tokens, plus output text tokens |
| Text-to-speech | provider character count, with per-request pricing only when the published rate says so |
| Image generation/editing | successful image count plus published size/quality class |
| OCR | successful request count initially; page pricing requires a separately published rule |
| Video generation | provider-reported units or successful output seconds at a fixed size/quality class |

Missing, malformed, estimated or conflicting usage leaves the call unresolved. Unknown calls keep their reservation and require reconciliation. A provider response that contains output but no authoritative usage is not treated as free.

## Knowledge library

Knowledge operations use an explicit durable project or ingest task owned by the selected UniHub account. Interactive search, background indexing, embedding, rerank, vision and OCR each obtain an operation grant. The embedded knowledge backend cannot store a long-lived user API key for this path. SuperWagie either injects a short-lived operation credential per request or routes the operation through a local quukk proxy.

Existing embedding dimensions and indexed model identity remain immutable. Replacing the embedding model or endpoint still requires an explicit rebuild. A background watcher never inherits a newly selected account without a new task binding.

## Speech, image and video consumers

TTS, short STT, buffered dictation, image generation, editable-slide image helpers, OCR and video jobs must carry operation metadata through their server-only resolver or child-process stdin. Child helpers return a receipt/evidence object and sanitized errors. They do not receive durable API keys.

OpenCode primary chat, small-model helpers and auxiliary generations need a deliberate admission decision. The current platform plugin only admits primary Chat SSE. The design extends the same task binding to supported auxiliary calls or leaves them explicitly billed by their existing OpenCode provider until that adapter is implemented.

## Persistence and recovery

Each operation stores a durable mapping between public job/call ID and UniHub task/call ID. The mapping includes actor, account, source product, operation, model, asset, funding mode, rate schema, request digest, provider job ID, reservation and terminal command state. It stores no bearer token, provider key, prompt, image bytes or model output.

Synchronous calls persist `PREPARED`, `DISPATCHED`, `DELIVERED` or `UNKNOWN` before and after upstream I/O. Asynchronous video and OCR jobs persist provider acceptance and a pending terminal settlement command before exposing success. Restart recovery polls known provider jobs and retries only the original terminal settlement or release command.

## Runtime behavior

| Runtime | Behavior |
| --- | --- |
| Managed Web | Full quukk account, commerce and operation routes. |
| Electron | Shares the in-process managed backend and private operation capabilities. |
| VS Code | Explicitly unsupported until it has an authenticated managed backend. |
| Hosted mobile | Uses the active managed server; otherwise explicit unsupported state. |
| Capacitor | Uses the active managed server; no local provider credentials. |
| External OpenCode | Refuses platform admission and never falls back to direct quukk credentials. |

## Acceptance gates

Sandbox acceptance must prove each operation family with deterministic provider fixtures, UniHub reserve/settle/release, exact ledger deltas, local quota unchanged, duplicate idempotency, account-switch rejection, missing-usage blocking, partial output recovery, async job recovery and restart recovery. Text, one media operation and one knowledge operation must be accepted before enabling the full catalog. Real provider credentials, real merchant payment and production prices remain separate gates.
