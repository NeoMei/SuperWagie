> **superseded-for-current-architecture (2026-09-04):** This file preserves evidence for the retired WPS-authoritative Office Review path. It cannot satisfy Universal Viewer GVP-0–5 or current production admission. Current authority: `docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md`.

# G3-REVIEW-002 — Office Reviewer isolation scenarios

This fixture defines the ten required environment and recovery scenarios for
proving that SuperWagie Office Review remains independent from Codex Desktop,
handles WPS/runtime failures explicitly, and invalidates stale preview state.

`scenarios.json` is the machine-readable authoritative list. Each scenario is
required. The unified runner routes the four Codex-isolation IDs to the strict
baseline/hash-chain executor and the six recovery IDs to a fixed private
production-contract executor. The recovery executor accepts only the scenario
enum and host-owned evidence paths; it exposes no executable, argument, process,
filesystem, or network override.

The key boundary is R-DL-09: ReviewShell, Preview Adapter, cache, navigation,
annotation, difference, Agent-change request, and version-confirmation behavior
must work without reading or invoking Codex Desktop resources, processes, IPC,
configuration, or state. WPS remains the Office visual fact source; timeout,
crash, or absence must enter an explicit unavailable/fallback state.

The six fixture-local recovery contracts passed on the current macOS automated
harness in these retained run roots:

- `evidence/gate-3/20260831T091949Z-53143` (`wps-missing`)
- `evidence/gate-3/20260831T091950Z-53161` (`wps-timeout`)
- `evidence/gate-3/20260831T091951Z-53179` (`wps-crash`)
- `evidence/gate-3/20260831T091951Z-53197` (`webview-restart`)
- `evidence/gate-3/20260831T091951Z-53222` (`cache-corrupt`)
- `evidence/gate-3/20260831T091952Z-53140` (`source-revision-changed`)

Each run passed the host-bound admission freshness check when first published
and a separate archival validation of schema, hashes, attestation, and outcome.
Archival validation intentionally remains valid after the live admission window.

This bounded result does not prove a never-installed-Codex machine, Windows 11,
real WPS fidelity, visual acceptance, or the complete Gate 3 decision.
> **superseded-for-current-architecture (2026-09-04):** This file preserves evidence for the retired WPS-authoritative Office Review path. It cannot satisfy Universal Viewer GVP-0–5 or current production admission. Current authority: `docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md`.
