#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_MANIFEST = path.resolve(
  HERE,
  '../../../fixtures/gate-3/G3-REVIEW-002/scenarios.json'
);

export const ISOLATION_SCENARIOS = Object.freeze([
  'codex-never-installed',
  'codex-installed-not-running',
  'codex-running',
  'codex-config-mutated'
]);

export const RECOVERY_SCENARIOS = Object.freeze([
  'wps-missing',
  'wps-timeout',
  'wps-crash',
  'webview-restart',
  'cache-corrupt',
  'source-revision-changed'
]);

export async function validateAuthoritativeScenarioRouting() {
  const value = JSON.parse(await readFile(SCENARIO_MANIFEST, 'utf8'));
  if (!value || value.fixture !== 'G3-REVIEW-002' || !Array.isArray(value.scenarios)
    || value.scenarios.some((entry) => !entry || typeof entry.id !== 'string'
      || entry.required !== true || Object.keys(entry).sort().join('\0') !== 'id\0required')) {
    throw new Error('RECOVERY_SCENARIO_MANIFEST_INVALID');
  }
  const authoritative = value.scenarios.map(({ id }) => id);
  const routed = [...ISOLATION_SCENARIOS, ...RECOVERY_SCENARIOS];
  if (authoritative.length !== 10 || new Set(authoritative).size !== authoritative.length
    || JSON.stringify([...authoritative].sort()) !== JSON.stringify([...routed].sort())) {
    throw new Error('RECOVERY_SCENARIO_ROUTING_MISMATCH');
  }
  return { authoritative, isolation: [...ISOLATION_SCENARIOS], recovery: [...RECOVERY_SCENARIOS] };
}

export async function routeScenario(scenario) {
  await validateAuthoritativeScenarioRouting();
  if (ISOLATION_SCENARIOS.includes(scenario)) return 'isolation';
  if (RECOVERY_SCENARIOS.includes(scenario)) return 'recovery';
  throw new Error('UNKNOWN_G3_REVIEW_002_SCENARIO');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) process.exitCode = 64;
  else routeScenario(process.argv[2]).then(
    (route) => process.stdout.write(`${route}\n`),
    () => { process.exitCode = 64; }
  );
}
