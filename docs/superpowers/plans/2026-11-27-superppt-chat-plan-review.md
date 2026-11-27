# SuperPPT Chat Plan Review Implementation Plan

> **For agentic workers:** Use test-driven development and the executing-plans workflow in this session.

**Goal:** Upgrade bundled SuperPPT to v0.3.8 and let capable hosts complete plan comments and style selection in chat.

**Architecture:** Add a launcher-declared interaction capability and deterministic OpenUI renderers beside the current HTML review. Keep task and decision contracts unchanged.

**Tech Stack:** Vendored TypeScript, Node test runner, npm component lockfile, existing SuperWagie OpenUI reply blocks.

**Spec:** `docs/superpowers/specs/2026-11-27-superppt-chat-plan-review-design.md`

## Global Constraints

- No new root dependencies, release, production change or running-app replacement.
- Preserve unrelated working-tree changes and existing managed-copy update protections.
- Test each new behavior before implementing it. Do not invoke paid generation.

## Review Focus

- Unmanaged hosts must not receive unsupported OpenUI interactions. Test CLI capability parsing and both render modes.
- Style, tier and palette answers must bind to the current decision and exact variant. Test generated answer text and the existing decision transaction.
- A requested slide must retain its stable identity and complete content. Test ordered slide selection and comment replies.
- An image-less or custom style must keep a text choice. Test missing preview fallback.
- The v0.3.8 snapshot must preserve local launchers and upgrades. Run component, snapshot and managed-identity checks.

### Task 1: Import official v0.3.8

- [x] Compare official v0.3.6 and v0.3.8 and preserve every local adaptation.
- [x] Copy owned upstream source, instruction, metadata and dependency updates.
- [x] Run the component tests and fix any merge-specific failures by behavior tests first.

### Task 2: Implement chat plan review

- [x] Add failing tests for opt-in capability, content-review choices, slide comments, style and complete variant answers, and portable fallback.
- [x] Implement deterministic OpenUI renderers and launcher capability declaration.
- [x] Update agent instructions for each conversation turn and authorization.
- [x] Run source and compiled component tests.

### Task 3: Validate packaging and upgrade identity

- [x] Update and verify vendor source hashes and generated bundle identity.
- [x] Run focused installer, presentation-runtime and customization tests.
- [x] Run the changed-source pre-commit gate and an independent whole-diff review.
- [x] Record validation limits and commit the finished work without pushing.
