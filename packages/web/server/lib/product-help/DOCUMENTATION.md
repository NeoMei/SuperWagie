# Product help

## Ownership

This module owns reviewed English and Simplified Chinese product help, semantic
article selection, and the authenticated `/api/product-help` routes. Shared UI
owns the right-sidebar assistant, conversation state and guided
navigation. The Small Model module owns all OpenCode model transport and policy.
The question-mark rail entry stays available while viewing the workbench.

`content.json` is the author source and offline baseline. `content.js` validates
independent content publications; `content-store.js` downloads and caches them.
`catalog.js` owns local matching and shipped action capabilities. These sources
contain product instructions, separate from the user's knowledge library.
Model setup and tests follow `model-configuration` and its UI;
knowledge entries follow `knowledge-library` and its panel; skills, extensions,
projects and chats follow their product docs; workbench follows its owning
extension. Appearance and shortcuts follow their current settings controls.
Change `catalogVersion` and increment `revision` whenever instructions change.
`bun run help:check` validates content; `bun run help:build` prepares the
independent JSON artifact. The dedicated publisher and public readback steps
are documented in `site/README.md`.

Operation articles include the entry point, ordered steps, expected state and
recovery or destructive consequences. Their owning sources include:

- Chat input, forms, queue and context: `ChatInput`, `FormDock`, the composer
  submit modules and the context UI.
- Session history and exports: sidebar session actions and the Archive page.
- Goals and schedules: session-goal and scheduled-tasks modules, including the
  existing-session queue and loop-file lifecycle.
- Workflows: the persisted tool opt-in, chat approval cards and Workflows panel.
- Files, terminals, Git and worktrees: their views and owning runtime docs.
- MCP, permissions, voice, memory, remote access and updates: their Settings
  pages and runtime documentation. New MCP servers require Create; Voice fallback
  controls do not override a unified model-purpose binding.

Written steps use the existing article renderer. Adding help for an operation
does not register a guide or authorize execution of that operation.

Web, Electron, hosted mobile and Capacitor use the authenticated active backend.
The standalone VS Code extension has no backend route; shared UI must report
that runtime explicitly rather than sending requests to an unrelated server.
`feature-routes-runtime.js` mounts these routes after UI authentication and before
the startup pipeline installs the generic OpenCode proxy. The production UI sends
its effective directory; a request without one receives local help. Small Model
code is imported only after a submitted question needs semantic matching.
The answer route owns a `128kb` JSON parser: common request middleware leaves
unlisted `/api` JSON bodies untouched. Route tests install that actual common
middleware and verify both successful parsing and an oversized-body `413`.

## Invariants

- The active backend owns content for web, Electron, hosted mobile and Capacitor.
  VS Code remains unsupported. The public source is
  `https://www.superwagie.com/product-help/v1/catalog.json`; a server-side
  `OPENCHAMBER_PRODUCT_HELP_URL` override accepts HTTPS without URL credentials,
  query parameters, fragments or redirects. Downloads send only a generic GET
  with Accept and an optional ETag. Questions, history, page names, directory
  paths, credentials and installation identifiers never go to the content host.
  Enterprise mode keeps this public download behavior, matching other public
  catalogs; `OPENCHAMBER_PRODUCT_HELP_UPDATES=0` stops downloads.
- Content checks start on an article-list request from the visible panel,
  coalesce concurrent callers and occur at most once per 5 minutes. Answer
  requests use `getContent({ refresh: false })`: they load local cache only and
  neither start nor await a remote refresh. Text search in the panel uses its
  already loaded articles. No application-startup timer runs. Downloads
  have a 4-second deadline and a streamed 512,000-byte limit. A matching ETag
  avoids downloading unchanged content. Disabled checks still load valid cache.
- The cache is `product-help/content-cache.json` inside `OPENCHAMBER_DATA_DIR`
  or `~/.config/openchamber`. It belongs to one exact source URL and is validated
  again on load. A failed request, corrupt file, incompatible version or older
  revision preserves the last valid snapshot or the bundled baseline. Disk writes
  use a temporary file and rename; a failed disk write still permits validated
  content in memory. No failure clears the available help.
- Schema 1 accepts localized title/text and literal keywords only. Remote data
  cannot set actions, selectors, URLs, scripts or regular expressions. Entries
  replace bundled text by ID; omitted bundled entries remain. Each publication
  contains all cumulative edits and additions, so it does not depend on a sequence
  of previously downloaded patches. New articles have no executable actions.
- `minAppVersion` and optional `maxAppVersion` constrain the backend version.
  Desktop's bundled backend follows its app version; remote clients use their
  server's content. This does not negotiate every older remote UI capability.
  There are at most 100 merged articles, 6,000 characters per article body and
  60,000 title/body characters per locale. Three selected entries fit the existing
  24,000-character answer limit. English keyword boundaries avoid substring
  matches inside other words; the longest literal matching phrase wins.
- A request captures one immutable snapshot for local matching, model input,
  allowed article IDs and answer rendering. API `catalogVersion` combines the
  author label, revision and the merged article digest as `label@revision:sha256`.
  Reusing an old label or changing the bundled baseline cannot make an old
  answer expand into a different article body. Content corrections
  and rollbacks publish a higher revision; old files are not accepted as updates.
- Opening the panel or reading articles never calls a model. Only an explicit
  question can call it, using the user's complete selected provider/model pair
  or an explicitly configured Small Model. An arbitrary default provider is
  refused. The checked model is pinned for generation.
- Questions, at most six turns from this assistant, a short page identifier and
  validated articles are the only model context. No ordinary session, project
  files, logs, knowledge documents or credentials are read. The directory only
  scopes existing OpenCode model configuration, never file content retrieval.
- Calls use `generateSmallModelText`, not a generic agent. OpenCode owns provider
  credentials and enforces provider policy, including enterprise deployments.
  The model path adds no provider entry or listener. Public content downloads
  use the separate data-only path described above.
- The model only selects article IDs and the scope outcome. User-visible prose,
  sources come from the captured content snapshot; actions come from shipped
  capabilities. It cannot return arbitrary
  selectors, coordinates, URLs, tools or generated general-purpose answers.
- The response distinguishes `answer`, `out-of-scope` and `not-covered`.
  `mode: local` is a bounded keyword fallback; `mode: model` is semantic article
  matching, not free-form answer generation. Model absence and model failure are
  respectively `unconfigured` and `unavailable`. A locally rejected unrelated
  request is `not-used`, since no model availability was queried. Local help
  remains available. Local matching inherits history only for topic-free
  follow-ups; a named new topic wins. Exact requests such as "Guide me" and
  "Locate here" keep the most recent recognized help topic, including a complete
  reviewed answer, instead of selecting the assistant's own instructions.
  Later follow-ups can recognize complete
  reviewed answer text in the bounded history, but never arbitrary assistant
  prose. Generic how-to wording alone does not select the assistant article.
- Local selection prioritizes named operation topics over broad project/chat
  words, and failure help over setup for the same topic. Chat attachments and
  project file uploads remain distinct; an explicit knowledge-library search
  keeps that scope. Current-page fallback uses only a fixed page-to-article map.
  Unconfigured or failed models retain the same operation instructions.
- Actions use the shipped article-to-target allowlist in `catalog.js`. Every
  registered target offers both location and guidance. Guidance opens its
  registered destination and keeps the displayed answer's reviewed instructions
  available while the user follows them. First-connection setup and language
  selection retain their control-driven flows; purpose binding and connection
  testing have separate targets. Guidance never executes the documented operation
  or reports a save, test or task as successful merely because instructions were
  displayed. The assistant's own instructions and unregistered content articles
  have no navigation action. Remote publications cannot register new targets.
  Language and theme articles also offer explicit execute operations from the
  shipped allowlist. The UI accepts only those operation identifiers and requires
  a click on a named operation before writing through existing settings
  persistence. The UI owns target availability, navigation and observed step
  completion; the help backend itself never changes settings.
- Invalid input is rejected before provider access. Cancellation aborts active
  generation. Provider errors and malformed output never reach the browser.

## Decisions

### Why semantic selection and not unrestricted generated prose

The product assistant must only explain this product. Selecting reviewed
articles makes that boundary enforceable even when a question asks the model to
ignore its instructions. Natural-language matching and follow-ups use the model;
unsupported questions remain explicit instead of inventing UI instructions.

### Why a bundled baseline and an independent content feed

First-model setup must work before any embedding or model configuration exists.
The baseline and last valid cache keep help available offline. Independent JSON
publication lets maintainers correct instructions and add topics without shipping
installers. Cumulative snapshots avoid patch-order failures after long periods
offline. Project documents and private content remain outside product help.

### Why pin the checked model

Model resolution can fall through to a default from another connected provider.
This feature accepts only an explicit configuration or the selected provider,
then passes that resolved model explicitly so a later default change cannot
redirect the question.
