# Model configuration overview

The user approved a compact list of every model purpose with configuration, last test, healthy/fault state and direct configuration/test actions.

## Runtime surfaces

- Web: overview reads authenticated active-server configuration and public component metadata. Explicit tests use the existing purpose test operation.
- Electron: shares the web implementation and its in-process backend.
- VS Code: native settings remain reachable; unavailable app model configuration is shown as unknown/unavailable, never empty success.
- Hosted mobile: same authenticated server contracts with responsive rows.
- Capacitor mobile: same server contracts and runtime-switch lifecycle; touch targets remain standard.

## State contract

Each purpose has separate configuration and test states. Only persisted purpose verification can produce healthy/failed. A saved connection probe does not verify a purpose. Last-test wording/time makes the snapshot explicit. Legacy/native/local component configuration is identified separately, and unreadable metadata cannot become unconfigured. Planned adapters are not counted as missing required configuration.

## Work

- [x] Pure typed status projection and focused state tests.
- [x] Compact overview, English/Chinese strings and rendered action tests.
- [x] Default overview tab, metadata loading, existing probe integration, search target and documentation.
- [x] Independent review, serialized validation and browser light/dark/narrow checks with local fixtures.

No Git/GitHub commands, dependencies, real credentials, paid API calls, schema migration or background health polling. Preserve all existing settings and indexes.

## Acceptance

- Independent review has no outstanding findings. The projection, rendered overview and parent integration suites pass: 66 tests and 212 assertions.
- Serialized UI, web, VS Code, Electron and SDK type checks pass. UI, web, VS Code, mobile and SDK lint pass; the Electron lint script is a no-op. Web, VS Code, mobile assets and Electron main bundling pass.
- The actual shared settings component was exercised in an isolated preview with fake credentials and local provider fixtures. A 1280 by 720 viewport shows all 15 rows. Chinese light, Chinese dark and English 390-pixel-wide layouts were inspected; the narrow layout has no horizontal content overflow.
- The overview test action persisted a successful embedding verification; configure navigation opened the matching editor. The fixture separately demonstrates a failed vision verification, untested speech, missing configuration, inherited/native component settings and planned adapters.
- Screenshots are saved in the task visualization directory as `superwagie-model-overview.png`, `superwagie-model-overview-dark.png` and `superwagie-model-overview-mobile-en.png`.
- This validates source, builds and the isolated browser preview. It does not validate real cloud provider credentials or an installed native package. Component-owned models require their component's actual invocation; only saved purpose probes show passed or fault. No commit or Git-dependent changed-file checks were run.
