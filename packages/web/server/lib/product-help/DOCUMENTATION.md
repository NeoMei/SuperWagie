# Product help

## Ownership

This module owns bundled English and Simplified Chinese product help, semantic
article selection, and the authenticated `/api/product-help` routes. Shared UI
owns the right-sidebar assistant, workbench entry, conversation state and guided
navigation. The Small Model module owns all OpenCode model transport and policy.

`catalog.js` is reviewed product content shipped with the app, not the user's
knowledge library. Model setup and tests follow `model-configuration` and its UI;
knowledge entries follow `knowledge-library` and its panel; skills, extensions,
projects and chats follow their product docs; workbench follows its owning
extension. Appearance and shortcuts follow their current settings controls.
Update the catalogue version whenever those instructions change.

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

- Opening the panel or reading articles never calls a model. Only an explicit
  question can call it, using the user's complete selected provider/model pair
  or an explicitly configured Small Model. An arbitrary default provider is
  refused. The checked model is pinned for generation.
- Questions, at most six turns from this assistant, a short page identifier and
  bundled articles are the only model context. No ordinary session, project
  files, logs, knowledge documents or credentials are read. The directory only
  scopes existing OpenCode model configuration, never file content retrieval.
- Calls use `generateSmallModelText`, not a generic agent. OpenCode owns provider
  credentials and enforces provider policy, including enterprise deployments.
  This feature adds no provider entry, egress destination or listener.
- The model only selects article IDs and the scope outcome. User-visible prose,
  sources and actions come from the bundled catalogue. It cannot return arbitrary
  selectors, coordinates, URLs, tools or generated general-purpose answers.
- The response distinguishes `answer`, `out-of-scope` and `not-covered`.
  `mode: local` is a bounded keyword fallback; `mode: model` is semantic article
  matching, not free-form answer generation. Model absence and model failure are
  respectively `unconfigured` and `unavailable`. A locally rejected unrelated
  request is `not-used`, since no model availability was queried. Local help
  remains available. Local matching inherits history only for topic-free
  follow-ups; a named new topic wins. Later follow-ups can recognize complete
  reviewed answer text in the bounded history, but never arbitrary assistant
  prose. Generic how-to wording alone does not select the assistant article.
- Actions are restricted to `models`, `knowledge`, `appearance`, `theme` and
  `shortcuts`. `appearance` guides language selection; `theme` only locates theme
  settings, and font instructions have no action. Only first-connection setup
  and language selection offer a guide. Language and theme articles also offer
  explicit execute operations from the shipped allowlist. The UI accepts only
  those operation identifiers, and requires a click on a named operation before
  writing through existing settings persistence. Other model articles, knowledge and
  shortcuts offer location only. Model guidance covers configuring and testing
  a connection; purpose binding remains a separate operation.
  Other documented topics have no action. The UI validates and owns each target's
  navigation and successful step completion; the help backend itself never changes settings.
  Guidance explains and highlights controls; reaching its last step is not
  evidence that a setting was saved or that a connection test succeeded.
- Invalid input is rejected before provider access. Cancellation aborts active
  generation. Provider errors and malformed output never reach the browser.

## Decisions

### Why semantic selection and not unrestricted generated prose

The product assistant must only explain this product. Selecting reviewed
articles makes that boundary enforceable even when a question asks the model to
ignore its instructions. Natural-language matching and follow-ups use the model;
unsupported questions remain explicit instead of inventing UI instructions.

### Why bundled help and not the user's knowledge index

First-model setup must work before any embedding or model configuration exists.
Bundled articles also keep project documents and private content out of help.

### Why pin the checked model

Model resolution can fall through to a default from another connected provider.
This feature accepts only an explicit configuration or the selected provider,
then passes that resolved model explicitly so a later default change cannot
redirect the question.
