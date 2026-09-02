#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

const BLOCKERS = Object.freeze({
  'gate-0/G0-SHELL-002': {
    reason: 'SIGNED_ELECTRON_SOLUTION_B_SHELL_REQUIRED',
    evidence_revision: 'solution-b-v1',
    limitations: [
      'There is no signed Electron Main + Rust Product Core + isolated surface build for this run.',
      'The legacy Tauri/System WebView shell cannot sign G0-SHELL-002 or stand in for bundled Chromium isolation evidence.',
    ],
  },
  'gate-3/G3-REVIEW-001': {
    reason: 'ELECTRON_ARTIFACT_PREVIEW_SURFACE_REQUIRED',
    evidence_revision: 'solution-b-v1',
    limitations: [
      'The legacy Tauri reviewer can preserve historical rendering findings but cannot sign the Electron artifact_preview surface boundary.',
      'A signed solution B preview surface and both target-platform WPS authoritative render evidence are required.',
    ],
  },
  'gate-3/G3-REVIEW-002': {
    reason: 'ELECTRON_PREVIEW_RECOVERY_HARNESS_REQUIRED',
    evidence_revision: 'solution-b-v1',
    limitations: [
      'The current recovery harness targets the legacy Tauri reviewer process topology.',
      'A solution B artifact_preview renderer crash/restart harness with Product Core-owned state is required.',
    ],
  },
  'gate-5/G5-CONNECTOR-001': {
    reason: 'REAL_AGENTWIKI_AUTHORIZED_INSTANCE_REQUIRED',
    limitations: [
      'A real AgentWiki test instance, authorized test Space, and user-approved credential flow are unavailable in this run.',
      'Stubbed Pull/Push cannot prove preview/confirm, conflict, partial success, disconnect recovery, or audit semantics.',
    ],
  },
  'gate-6/G6-BILLING-001': {
    reason: 'REAL_BILLING_SANDBOX_REQUIRED',
    limitations: [
      'The account, organization wallet, payment callback, and Credits ledger services do not yet exist in a test environment.',
      'Local mocks cannot prove signed callbacks, cross-wallet isolation, concurrent reserve/settle/refund, replay resistance, or client/server reconciliation.',
    ],
  },
  'gate-6/G6-PACKAGE-001': {
    reason: 'SIGNED_INSTALLABLE_BUILDS_AND_CLEAN_MACHINES_REQUIRED',
    evidence_revision: 'solution-b-v1',
    limitations: [
      'There is no signed SuperWagie macOS or Windows installable build to install, notarize, upgrade, roll back, uninstall, or measure.',
      'The fixture requires clean macOS and Windows 11 machines plus release signing, update metadata, SBOM, and integrity infrastructure.',
    ],
  },
});

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

const gate = arg('--gate');
const fixture = arg('--fixture');
const platform = arg('--platform');
const resultsPath = arg('--results-json');
const blocker = BLOCKERS[`${gate}/${fixture}`];

if (!blocker || !platform || !isAbsolute(resultsPath)) {
  console.error('unsupported environment-gate fixture');
  process.exit(1);
}

mkdirSync(dirname(resultsPath), { recursive: true });
writeFileSync(resultsPath, `${JSON.stringify({
  schema_id: 'superwagie.environment-gate-result.v1', schema_version: 1,
  gate, fixture, platform,
  ...(blocker.evidence_revision ? { evidence_revision: blocker.evidence_revision } : {}),
  pass: false, status: 'blocked', decision_hint: 'BLOCKED_ENVIRONMENT',
  reasons: [blocker.reason], limitations: blocker.limitations,
}, null, 2)}\n`, { mode: 0o600 });
console.error(`BLOCKED_ENVIRONMENT: ${blocker.reason}`);
process.exit(2);
