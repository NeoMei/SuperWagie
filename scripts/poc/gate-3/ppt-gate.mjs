#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative as relativePath, resolve, sep } from 'node:path';

const FIXTURE_ID = 'G3-PPT-001';
const CRITICAL_FILES = [
  'package.json',
  'package-lock.json',
  'skills/superppt/SKILL.md',
  'src/deck/pptx.ts',
  'src/deck/presentation-service.ts',
  'scripts/test.ts',
];
const FORBIDDEN_SOURCE_MARKERS = [
  '@oai/artifact-tool',
  'codex-primary-runtime',
  'codex-runtimes',
  'RUNTIME_NODE',
  'RUNTIME_NODE_MODULES',
  'RUNTIME_BIN_DIR',
];

function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function regularFile(file, label) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return readFileSync(file);
}

function candidateFile(root, relative, label) {
  const rootPath = resolve(root);
  const file = resolve(rootPath, relative);
  const containedPath = relativePath(rootPath, file);
  if (containedPath === '..' || containedPath.startsWith(`..${sep}`) || isAbsolute(containedPath)) {
    throw new Error(`${label} escapes candidate root`);
  }
  const parts = relative.split('/');
  let directory = rootPath;
  for (const part of parts.slice(0, -1)) {
    directory = resolve(directory, part);
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink()) throw new Error(`${label} parent directory must be non-symlink`);
    if (!metadata.isDirectory()) throw new Error(`${label} parent path must be a directory`);
  }
  return regularFile(file, label);
}

function result(decision, reasons, limitations = [], metrics = null) {
  return {
    schema_id: 'superwagie.g3-ppt-gate-result.v1',
    schema_version: 1,
    gate: 'gate-3',
    fixture: FIXTURE_ID,
    pass: decision === 'GO' || decision === 'CONDITIONAL_GO',
    status: decision === 'BLOCKED_ENVIRONMENT' ? 'blocked' : decision === 'NO_GO' ? 'failed' : 'passed',
    decision_hint: decision,
    reasons,
    limitations,
    ...(metrics ? { metrics } : {}),
  };
}

function writeResult(file, document) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

const fixture = value('--fixture');
const platform = value('--platform');
const resultsPath = value('--results-json');
const artifactsDir = value('--artifacts-dir');
const candidateRoot = value('--candidate-root');

if (fixture !== FIXTURE_ID || !platform || !isAbsolute(resultsPath) || !isAbsolute(artifactsDir)) {
  console.error(`usage: ppt-gate.mjs --fixture ${FIXTURE_ID} --platform ID --results-json ABS --artifacts-dir ABS --candidate-root ABS`);
  process.exit(2);
}
if (!candidateRoot) {
  writeResult(resultsPath, result('BLOCKED_ENVIRONMENT', ['SUPERPPT_CANDIDATE_REQUIRED'], [
    'The pinned SuperPPT checkout and its real three-slide WPS or PowerPoint visual evaluation are not available on this host.',
  ]));
  console.error('BLOCKED_ENVIRONMENT: pinned SuperPPT candidate and visual evaluation required');
  process.exit(2);
}
if (!isAbsolute(candidateRoot)) {
  console.error(`usage: ppt-gate.mjs --fixture ${FIXTURE_ID} --platform ID --results-json ABS --artifacts-dir ABS --candidate-root ABS`);
  process.exit(2);
}

try {
  const rootInfo = lstatSync(candidateRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('candidate root must be a regular non-symlink directory');
  const sources = {};
  const criticalSourceText = {};
  for (const relative of CRITICAL_FILES) {
    const bytes = candidateFile(candidateRoot, relative, relative);
    sources[relative] = { sha256: sha256(bytes), bytes: bytes.length };
    criticalSourceText[relative] = bytes.toString('utf8');
  }
  const packageDocument = JSON.parse(criticalSourceText['package.json']);
  const lockDocument = JSON.parse(criticalSourceText['package-lock.json']);
  if (packageDocument.name !== 'superppt' || packageDocument.version !== lockDocument.version
    || lockDocument.packages?.['']?.name !== 'superppt') throw new Error('package identity mismatch');

  const pptxSource = criticalSourceText['src/deck/pptx.ts'];
  const forbiddenSourceMarkers = Object.entries(criticalSourceText).flatMap(([relative, source]) =>
    FORBIDDEN_SOURCE_MARKERS.filter((marker) => source.includes(marker)).map((marker) => `${relative}:${marker}`));
  const directArtifactTool = forbiddenSourceMarkers.some((finding) => finding.endsWith(':@oai/artifact-tool'));
  const ownedAdapter = /pptxgenjs|writePresentation|PresentationService/.test(pptxSource);
  const runtimeEnvironmentContract = forbiddenSourceMarkers.some((finding) => /:RUNTIME_(?:NODE|NODE_MODULES|BIN_DIR)$/.test(finding));
  const codexDefaultRuntime = forbiddenSourceMarkers.some((finding) =>
    finding.endsWith(':codex-primary-runtime') || finding.endsWith(':codex-runtimes'));
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(resolve(artifactsDir, 'source-audit.json'), `${JSON.stringify({
    schema_id: 'superwagie.g3-ppt-source-audit.v1',
    schema_version: 1,
    fixture: FIXTURE_ID,
    platform,
    candidate_root_sha256: sha256(Buffer.from(candidateRoot)),
    package: { name: packageDocument.name, version: packageDocument.version },
    forbidden_markers: FORBIDDEN_SOURCE_MARKERS,
    forbidden_marker_set_sha256: sha256(Buffer.from(JSON.stringify(FORBIDDEN_SOURCE_MARKERS))),
    sources,
    findings: {
      direct_oai_artifact_tool_import: directArtifactTool,
      runtime_environment_contract: runtimeEnvironmentContract,
      codex_primary_runtime_default: codexDefaultRuntime,
      forbidden_source_markers: forbiddenSourceMarkers,
    },
  }, null, 2)}\n`, { mode: 0o600 });

  if (forbiddenSourceMarkers.length > 0) {
    writeResult(resultsPath, result('NO_GO', [
      'CODEX_ARTIFACT_TOOL_RUNTIME_COUPLING',
      'REAL_THREE_SLIDE_FLOW_NOT_EXECUTED',
      'REAL_WPS_SMOKE_NOT_EXECUTED',
    ], [
      'Replace the direct @oai/artifact-tool dependency with a SuperWagie-owned PresentationService or audited OOXML adapter before repeating this fixture.',
      'If Node is still required, it must come from the immutable Signed Runtime Image; system/user Node and Codex Desktop runtime/packages are forbidden.',
    ], {
      direct_oai_artifact_tool_import: directArtifactTool,
      codex_primary_runtime_default: codexDefaultRuntime,
      real_three_slide_flow_executed: false,
      real_wps_smoke_executed: false,
    }));
    console.error('NO_GO: SuperPPT still depends on a Codex runtime/package');
    process.exit(1);
  }

  if (!ownedAdapter) {
    writeResult(resultsPath, result('NO_GO', ['OWNED_PRESENTATION_SERVICE_MISSING'], [
      'Decoupling from Codex is not enough; SuperPPT must call a SuperWagie-owned PresentationService or audited OOXML adapter.',
    ]));
    console.error('NO_GO: SuperPPT owned PresentationService or audited OOXML adapter is missing');
    process.exit(1);
  }

  writeResult(resultsPath, result('BLOCKED_ENVIRONMENT', ['REAL_PPT_EVALUATION_REQUIRED'], [
    'Source decoupling alone cannot satisfy the seven-stage, three-slide, change-impact, and real-WPS acceptance fixture.',
  ]));
  console.error('BLOCKED_ENVIRONMENT: real PPT evaluation is required');
  process.exit(2);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeResult(resultsPath, result('NO_GO', ['PPT_SOURCE_AUDIT_INVALID'], [message]));
  console.error(message);
  process.exit(1);
}
