#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertContainedDirectoryChainSync, readStableRegularFileSync } from '../secure-file-read.mjs';
import {
  assertExactKeys,
  assertNoDuplicateJsonKeys,
  readAndValidateWriterHumanReceipt,
} from './writer-human-receipt.mjs';
import { reserveWriterOutputs } from './writer-output-transaction.mjs';
import {
  inspectImageBytes,
  loadWriterCollectorTrustConfig,
  readCleanDetachedGitSnapshot,
  validateGenerationReceiptBytes,
  validateWriterCollectorReceiptBytes,
  validateWpsAutomationObservationBytes,
  verifyGenerationExecutableClosure,
  verifyInstalledWpsRendererIdentity,
} from './writer-evidence-trust.mjs';

const FIXTURE_ID = 'G3-WRITER-001';
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;
const LEGACY_ARTIFACT_KEYS = [
  'source_md', 'docx', 'pdf', 'restart_docx',
  'opened_screenshot', 'edited_screenshot', 'restored_screenshot', 'discard_prompt_screenshot',
];
const V2_ARTIFACT_KEYS = [
  'source_md', 'docx', 'pdf', 'restart_docx', 'automation_observation',
  'opened_screenshot', 'edited_screenshot', 'restored_screenshot', 'discard_prompt_screenshot',
];
const V3_ARTIFACT_KEYS = [...V2_ARTIFACT_KEYS, 'generation_receipt'];
const AUTOMATED_CHECK_KEYS = [
  'superwriter_acceptance_example', 'wpscomposer_clean_preflight', 'docx_structure', 'pdf_structure',
  'required_content_coverage', 'kill_preserved_existing_output', 'restart_semantically_equal',
  'embedded_image_hash_equal', 'wps_opened_real_document', 'wps_edit_entered_dirty_state',
  'wps_undo_restored_original_text', 'canonical_hash_unchanged',
];
const MANUAL_CHECK_KEYS = [
  'seven_stage_receipts_complete', 'three_human_gates_complete',
  'human_visual_review_approved', 'wps_discard_close_reopen_confirmed',
];
const MANUAL_LIMITATIONS = Object.freeze({
  seven_stage_receipts_complete: 'Seven-stage SuperWriter checkpoint receipts have not been replayed and recorded for this fixture.',
  three_human_gates_complete: 'The three required human confirmation gate receipts have not been replayed and recorded for this fixture.',
  human_visual_review_approved: 'A human has not yet approved every page of the real-WPS visual result.',
  wps_discard_close_reopen_confirmed: 'WPS discard, close, and reopen has not yet been confirmed by a human operator.',
});

function argValue(argv, name) { const index = argv.indexOf(name); return index === -1 ? '' : argv[index + 1] ?? ''; }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function containedArtifact(root, entry, label) {
  assertExactKeys(entry, ['path', 'sha256'], label);
  if (typeof entry.path !== 'string' || entry.path.length === 0 || isAbsolute(entry.path)) throw new Error(`${label} path must be a nonempty relative path`);
  if (!SHA256.test(entry.sha256)) throw new Error(`${label} sha256 is invalid`);
  const segments = entry.path.split(/[\\/]/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new Error(`${label} path escapes its root`);
  const file = resolve(root, ...segments);
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error(`${label} path escapes its root`);
  if (segments.length > 1) assertContainedDirectoryChainSync(root, segments.slice(0, -1));
  return file;
}

function publishedArtifactManifest(stagingRoot, finalArtifactsPath) {
  const entries = [];
  const walk = (directory) => {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Writer staged artifacts contain a non-directory or symlink');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Writer staged artifacts contain a symlink');
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        const relativePath = relative(stagingRoot, child).split('\\').join('/');
        entries.push({ path: `${basename(finalArtifactsPath)}/${relativePath}`, sha256: sha256(readFileSync(child)) });
      } else throw new Error('Writer staged artifacts contain a non-regular entry');
    }
  };
  walk(stagingRoot);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function resultDocument({ decision, reasons = [], limitations = [], metrics = null, evidenceBinding = null, startedAt }) {
  return {
    schema_id: 'superwagie.g3-writer-gate-result.v1', schema_version: 1,
    gate: 'gate-3', fixture: FIXTURE_ID, started_at: startedAt, finished_at: new Date().toISOString(),
    pass: decision === 'GO' || decision === 'CONDITIONAL_GO',
    status: decision === 'BLOCKED_ENVIRONMENT' ? 'blocked' : decision === 'NO_GO' ? 'failed' : 'passed',
    decision_hint: decision, reasons, limitations,
    ...(metrics ? { metrics } : {}),
    ...(evidenceBinding ? { evidence_binding: evidenceBinding } : {}),
  };
}

function validateCommonEvaluation(evaluation, platform, artifactKeys, version) {
  if (evaluation.fixture !== FIXTURE_ID) throw new Error('evaluation fixture identity mismatch');
  if (evaluation.platform !== platform) throw new Error('evaluation platform mismatch');
  if (!Number.isFinite(Date.parse(evaluation.executed_at))) throw new Error('executed_at is invalid');
  if (typeof evaluation.operator_role !== 'string' || evaluation.operator_role.length === 0) throw new Error('operator_role is missing');
  const trusted = version >= 3;
  assertExactKeys(evaluation.source_identity, trusted
    ? ['superwriter_commit', 'superwriter_tree', 'superwriter_snapshot', 'wpscomposer_commit', 'wpscomposer_tree', 'wpscomposer_snapshot', 'generation_id', 'generation_receipt_sha256', 'host_skill_mirror_status']
    : ['superwriter_commit', 'wpscomposer_commit', 'wpscomposer_snapshot', 'host_skill_mirror_status'], 'source_identity');
  for (const key of trusted ? ['superwriter_commit', 'superwriter_tree', 'wpscomposer_commit', 'wpscomposer_tree'] : ['superwriter_commit', 'wpscomposer_commit']) {
    if (!/^[a-f0-9]{40}$/.test(evaluation.source_identity[key])) throw new Error('source commit/tree identity is invalid');
  }
  if (trusted && (evaluation.source_identity.superwriter_snapshot !== 'clean-detached-snapshot'
    || !IDENTIFIER.test(evaluation.source_identity.generation_id) || !SHA256.test(evaluation.source_identity.generation_receipt_sha256))) {
    throw new Error('SuperWriter generation provenance does not bind a clean detached snapshot');
  }
  if (evaluation.source_identity.wpscomposer_snapshot !== 'clean-detached-snapshot') throw new Error('WPSComposer evaluation was not run from a clean detached snapshot');
  if (!['clean', 'drift-detected'].includes(evaluation.source_identity.host_skill_mirror_status)) throw new Error('host skill mirror status is invalid');
  assertExactKeys(evaluation.renderer, version === 1 ? ['application', 'version', 'pdf_creator'] : trusted
    ? ['application', 'version', 'build', 'bundle_id', 'team_identifier', 'executable_sha256', 'identity_sha256', 'session_id', 'pdf_creator', 'page_count']
    : ['application', 'version', 'pdf_creator', 'page_count'], 'renderer');
  if (evaluation.renderer.application !== 'WPS Office' || typeof evaluation.renderer.version !== 'string'
    || evaluation.renderer.version.length === 0 || !/^WPS/.test(evaluation.renderer.pdf_creator)) throw new Error('renderer identity is not real WPS');
  if (version !== 1 && (!Number.isInteger(evaluation.renderer.page_count) || evaluation.renderer.page_count < 1 || evaluation.renderer.page_count > 10000)) throw new Error('renderer page_count is invalid');
  if (trusted && (evaluation.renderer.bundle_id !== 'com.kingsoft.wpsoffice.mac' || evaluation.renderer.team_identifier !== 'YK4WKE5WAM'
    || !SHA256.test(evaluation.renderer.executable_sha256) || !SHA256.test(evaluation.renderer.identity_sha256)
    || !IDENTIFIER.test(evaluation.renderer.session_id) || typeof evaluation.renderer.build !== 'string' || evaluation.renderer.build.length === 0)) throw new Error('trusted WPS renderer identity is invalid');
  assertExactKeys(evaluation.artifacts, artifactKeys, 'artifacts');
  assertExactKeys(evaluation.checks, AUTOMATED_CHECK_KEYS, 'checks');
  assertExactKeys(evaluation.manual_checks, MANUAL_CHECK_KEYS, 'manual_checks');
  for (const key of [...AUTOMATED_CHECK_KEYS, ...MANUAL_CHECK_KEYS]) {
    const group = AUTOMATED_CHECK_KEYS.includes(key) ? evaluation.checks : evaluation.manual_checks;
    if (typeof group[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  }
}

const fixture = argValue(process.argv, '--fixture');
const platform = argValue(process.argv, '--platform');
const resultsPath = argValue(process.argv, '--results-json');
const artifactsDir = argValue(process.argv, '--artifacts-dir');
const evaluationResult = argValue(process.argv, '--evaluation-result');
const collectorReceiptPath = argValue(process.argv, '--collector-receipt');
const superwriterRoot = argValue(process.argv, '--superwriter-root');
const wpscomposerRoot = argValue(process.argv, '--wpscomposer-root');
const startedAt = new Date().toISOString();

if (fixture !== FIXTURE_ID || !platform || !resultsPath || !artifactsDir || !isAbsolute(resultsPath) || !isAbsolute(artifactsDir)) {
  console.error(`usage: writer-gate.mjs --fixture ${FIXTURE_ID} --platform ID --results-json ABS --artifacts-dir ABS [--evaluation-result ABS --collector-receipt ABS --superwriter-root ABS --wpscomposer-root ABS]`);
  process.exit(2);
}
let outputs;
try {
  outputs = reserveWriterOutputs(resultsPath, artifactsDir);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const publicationArtifactsDir = outputs.artifactsPath;
if (!evaluationResult) {
  outputs.publish(resultDocument({ decision: 'BLOCKED_ENVIRONMENT', reasons: ['REAL_WRITER_EVALUATION_REQUIRED'], limitations: ['Static package checks and historical examples are not sufficient for this Gate.'], startedAt }));
  console.error('BLOCKED_ENVIRONMENT: a real SuperWriter/WPS evaluation is required');
  process.exit(2);
}

try {
  if (!isAbsolute(evaluationResult)) throw new Error('evaluation result path must be absolute');
  const evaluationBytes = readStableRegularFileSync(evaluationResult, MAX_EVIDENCE_BYTES);
  const evaluationText = evaluationBytes.toString('utf8');
  assertNoDuplicateJsonKeys(evaluationText);
  const evaluation = JSON.parse(evaluationText);
  const legacy = evaluation.schema_id === 'superwagie.g3-writer-evaluation.v1' && evaluation.schema_version === 1;
  const v2 = evaluation.schema_id === 'superwagie.g3-writer-evaluation.v2' && evaluation.schema_version === 2;
  const v3 = evaluation.schema_id === 'superwagie.g3-writer-evaluation.v3' && evaluation.schema_version === 3;
  const v4 = evaluation.schema_id === 'superwagie.g3-writer-evaluation.v4' && evaluation.schema_version === 4;
  if (!legacy && !v2 && !v3 && !v4) throw new Error('evaluation identity mismatch');
  if (legacy) {
    assertExactKeys(evaluation, ['schema_id', 'schema_version', 'fixture', 'platform', 'executed_at', 'operator_role', 'source_identity', 'renderer', 'artifacts', 'checks', 'manual_checks'], 'evaluation');
    validateCommonEvaluation(evaluation, platform, LEGACY_ARTIFACT_KEYS, 1);
    if (MANUAL_CHECK_KEYS.some((key) => evaluation.manual_checks[key])) throw new Error('legacy manual_checks cannot be true without a human receipt');
  } else {
    assertExactKeys(evaluation, ['schema_id', 'schema_version', 'fixture', 'platform', 'executed_at', 'operator_role', 'run_identity', 'source_identity', 'renderer', 'artifacts', 'checks', 'manual_checks', 'human_receipt'], 'evaluation');
    validateCommonEvaluation(evaluation, platform, (v3 || v4) ? V3_ARTIFACT_KEYS : V2_ARTIFACT_KEYS, v4 ? 4 : v3 ? 3 : 2);
    assertExactKeys(evaluation.run_identity, ['run_id', 'evaluation_id'], 'run_identity');
    if (!IDENTIFIER.test(evaluation.run_identity.run_id) || !IDENTIFIER.test(evaluation.run_identity.evaluation_id)) throw new Error('run or evaluation identity is invalid');
  }
  if (v3 && MANUAL_CHECK_KEYS.some((key) => evaluation.manual_checks[key])) {
    throw new Error('legacy v3 provenance cannot derive GO without a verified collector receipt and live source/WPS identities');
  }

  let collectorValidation = null;
  let liveSuperwriterSnapshot = null;
  let liveWpscomposerSnapshot = null;
  if (v4) {
    if (![collectorReceiptPath, superwriterRoot, wpscomposerRoot].every((value) => value && isAbsolute(value))) {
      throw new Error('trusted v4 provenance requires an absolute collector receipt and live SuperWriter/WPSComposer source roots');
    }
    const collectorBytes = readStableRegularFileSync(collectorReceiptPath, MAX_EVIDENCE_BYTES);
    const collectorExecutable = resolve(dirname(fileURLToPath(import.meta.url)), 'record-writer-evaluation.mjs');
    const collectorExecutableBytes = readStableRegularFileSync(collectorExecutable, MAX_EVIDENCE_BYTES);
    collectorValidation = validateWriterCollectorReceiptBytes(collectorBytes, {
      fixture: FIXTURE_ID, platform, run_identity: evaluation.run_identity,
      collector_executable_sha256: sha256(collectorExecutableBytes), evaluation_sha256: sha256(evaluationBytes),
    }, loadWriterCollectorTrustConfig());
    liveSuperwriterSnapshot = readCleanDetachedGitSnapshot(superwriterRoot, 'SuperWriter');
    liveWpscomposerSnapshot = readCleanDetachedGitSnapshot(wpscomposerRoot, 'WPSComposer');
    const sourcePairs = [
      ['superwriter_commit', liveSuperwriterSnapshot.commit], ['superwriter_tree', liveSuperwriterSnapshot.tree],
      ['wpscomposer_commit', liveWpscomposerSnapshot.commit], ['wpscomposer_tree', liveWpscomposerSnapshot.tree],
    ];
    for (const [key, value] of sourcePairs) if (evaluation.source_identity[key] !== value || collectorValidation.receipt[key] !== value) throw new Error(`Writer collector/source snapshot ${key} binding mismatch`);
  }

  const evaluationRoot = dirname(evaluationResult);
  const artifactReceipts = {};
  const artifactBytes = {};
  for (const key of legacy ? LEGACY_ARTIFACT_KEYS : (v3 || v4) ? V3_ARTIFACT_KEYS : V2_ARTIFACT_KEYS) {
    const entry = evaluation.artifacts[key];
    const source = containedArtifact(evaluationRoot, entry, `artifact ${key}`);
    const bytes = readStableRegularFileSync(source, MAX_EVIDENCE_BYTES);
    const actualHash = sha256(bytes);
    if (actualHash !== entry.sha256) throw new Error(`artifact ${key} hash mismatch`);
    artifactBytes[key] = bytes;
    const extension = basename(entry.path).includes('.') ? `.${basename(entry.path).split('.').at(-1)}` : '';
    const destination = resolve(publicationArtifactsDir, `${key}${extension}`);
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
    artifactReceipts[key] = { sha256: actualHash, bytes: bytes.length, file: basename(destination) };
  }

  let generationValidation = null;
  let observationValidation = null;
  if (v3 || v4) {
    generationValidation = validateGenerationReceiptBytes(artifactBytes.generation_receipt, {
      fixture: FIXTURE_ID, platform,
      superwriter: { commit: evaluation.source_identity.superwriter_commit, tree: evaluation.source_identity.superwriter_tree, status: 'clean', snapshot: 'detached' },
      wpscomposer: { commit: evaluation.source_identity.wpscomposer_commit, tree: evaluation.source_identity.wpscomposer_tree, status: 'clean', snapshot: 'detached' },
      artifacts: {
        source_md_sha256: artifactReceipts.source_md.sha256, canonical_docx_sha256: artifactReceipts.docx.sha256,
        restart_docx_sha256: artifactReceipts.restart_docx.sha256, pdf_sha256: artifactReceipts.pdf.sha256,
      },
    });
    if (generationValidation.receiptSha256 !== evaluation.source_identity.generation_receipt_sha256
      || generationValidation.receipt.generation_id !== evaluation.source_identity.generation_id) throw new Error('generation provenance receipt identity binding mismatch');
    const screenshotKeys = { opened: 'opened_screenshot', edited: 'edited_screenshot', restored: 'restored_screenshot', discard_prompt: 'discard_prompt_screenshot' };
    const screenshots = Object.fromEntries(Object.entries(screenshotKeys).map(([key, artifactKey]) => [key, {
      sha256: artifactReceipts[artifactKey].sha256, ...inspectImageBytes(artifactBytes[artifactKey], `${key} WPS screenshot`,
        key === 'discard_prompt' ? { minWidth: 300, minHeight: 100 } : { minWidth: 640, minHeight: 480 }),
    }]));
    observationValidation = validateWpsAutomationObservationBytes(artifactBytes.automation_observation, {
      fixture: FIXTURE_ID, platform, run_id: evaluation.run_identity.run_id,
      restart_docx_sha256: artifactReceipts.restart_docx.sha256, screenshots,
    });
    const renderer = observationValidation.observation.renderer_identity;
    const rendererPairs = {
      application: renderer.application, version: renderer.version, build: renderer.build,
      bundle_id: renderer.bundle_id, team_identifier: renderer.team_identifier,
      executable_sha256: renderer.executable_sha256, identity_sha256: observationValidation.rendererIdentitySha256,
      session_id: observationValidation.sessionId,
    };
    for (const [key, wanted] of Object.entries(rendererPairs)) if (evaluation.renderer[key] !== wanted) throw new Error(`WPS renderer ${key} observation binding mismatch`);
    if (v4) {
      if (generationValidation.receipt.schema_version !== 2) throw new Error('trusted v4 provenance requires generation receipt v2 executable closure');
      verifyGenerationExecutableClosure(generationValidation.receipt, {
        superwriter: { root: superwriterRoot, snapshot: liveSuperwriterSnapshot },
        wpscomposer: { root: wpscomposerRoot, snapshot: liveWpscomposerSnapshot },
      });
      verifyInstalledWpsRendererIdentity(renderer);
      const collectorPairs = {
        automation_observation_sha256: artifactReceipts.automation_observation.sha256,
        generation_receipt_sha256: generationValidation.receiptSha256,
        renderer_identity_sha256: observationValidation.rendererIdentitySha256,
        wps_session_id: observationValidation.sessionId,
      };
      for (const [key, value] of Object.entries(collectorPairs)) if (collectorValidation.receipt[key] !== value) throw new Error(`Writer collector receipt ${key} binding mismatch`);
      writeFileSync(resolve(publicationArtifactsDir, 'collector-receipt.json'), collectorValidation.receiptBytes, { flag: 'wx', mode: 0o600 });
    }
  }

  let humanReceiptValidation = null;
  let derivedManual = Object.fromEntries(MANUAL_CHECK_KEYS.map((key) => [key, false]));
  if ((v2 || v3 || v4) && evaluation.human_receipt !== null) {
    assertExactKeys(evaluation.human_receipt, ['path', 'sha256', 'summary'], 'human_receipt');
    assertExactKeys(evaluation.human_receipt.summary, ['run_id', 'evaluation_id', 'stage_receipts', 'human_gate_receipts', 'visual_pages_reviewed', 'lifecycle_confirmations'], 'human_receipt summary');
    const receiptPath = containedArtifact(evaluationRoot, { path: evaluation.human_receipt.path, sha256: evaluation.human_receipt.sha256 }, 'human receipt');
    humanReceiptValidation = readAndValidateWriterHumanReceipt(receiptPath, {
      fixture: FIXTURE_ID, platform,
      run_id: evaluation.run_identity.run_id, evaluation_id: evaluation.run_identity.evaluation_id,
      operator_role: evaluation.operator_role,
      source_md_sha256: artifactReceipts.source_md.sha256,
      canonical_docx_sha256: artifactReceipts.docx.sha256,
      restart_docx_sha256: artifactReceipts.restart_docx.sha256,
      pdf_sha256: artifactReceipts.pdf.sha256,
      automation_observation_sha256: artifactReceipts.automation_observation.sha256,
      superwriter_commit: evaluation.source_identity.superwriter_commit,
      wpscomposer_commit: evaluation.source_identity.wpscomposer_commit,
      wps_version: evaluation.renderer.version,
      pdf_page_count: evaluation.renderer.page_count,
      ...((v3 || v4) ? {
        generation_receipt_sha256: generationValidation.receiptSha256,
        renderer_identity_sha256: observationValidation.rendererIdentitySha256,
        wps_session_id: observationValidation.sessionId,
      } : {}),
    });
    if (humanReceiptValidation.receiptSha256 !== evaluation.human_receipt.sha256) throw new Error('human receipt hash mismatch');
    if (JSON.stringify(humanReceiptValidation.summary) !== JSON.stringify(evaluation.human_receipt.summary)) throw new Error('human receipt structured summary mismatch');
    derivedManual = humanReceiptValidation.facts;
    if (v2 && MANUAL_CHECK_KEYS.some((key) => derivedManual[key])) throw new Error('legacy receipt cannot manufacture GO without generation provenance and a bound WPS observation');
    if ((v3 || v4) && humanReceiptValidation.receipt.schema_version !== 2) throw new Error('trusted evaluation requires the WPS-bound human receipt v2');
    const receiptTarget = resolve(publicationArtifactsDir, 'human-receipt.json');
    writeFileSync(receiptTarget, humanReceiptValidation.receiptBytes, { flag: 'wx', mode: 0o600 });
    const receiptEvidenceDir = resolve(publicationArtifactsDir, 'human-receipt-evidence');
    mkdirSync(receiptEvidenceDir);
    for (const [index, evidence] of humanReceiptValidation.evidenceFiles.entries()) {
      writeFileSync(resolve(receiptEvidenceDir, `${String(index + 1).padStart(2, '0')}-${evidence.name}`), evidence.bytes, { flag: 'wx', mode: 0o600 });
    }
  } else if ((v2 || v3 || v4) && MANUAL_CHECK_KEYS.some((key) => evaluation.manual_checks[key])) {
    throw new Error('manual_checks cannot be true without a human receipt');
  }
  if ((v2 || v3 || v4) && MANUAL_CHECK_KEYS.some((key) => evaluation.manual_checks[key] !== derivedManual[key])) throw new Error('manual_checks do not match independently derived human receipt facts');
  if (v4) {
    if (collectorValidation.receipt.human_receipt_sha256 !== (humanReceiptValidation?.receiptSha256 ?? null)) throw new Error('Writer collector receipt human receipt hash binding mismatch');
    const finalSuperwriter = readCleanDetachedGitSnapshot(superwriterRoot, 'SuperWriter');
    const finalWpscomposer = readCleanDetachedGitSnapshot(wpscomposerRoot, 'WPSComposer');
    if (JSON.stringify(finalSuperwriter) !== JSON.stringify(liveSuperwriterSnapshot)
      || JSON.stringify(finalWpscomposer) !== JSON.stringify(liveWpscomposerSnapshot)) throw new Error('Writer source snapshot changed during final gate validation');
  }

  const coreArtifactSetSha256 = sha256(Buffer.from(JSON.stringify(artifactReceipts)));
  const evaluationSha256 = sha256(evaluationBytes);
  const humanReceiptSha256 = humanReceiptValidation?.receiptSha256 ?? null;
  writeFileSync(resolve(publicationArtifactsDir, 'evaluation-receipt.json'), `${JSON.stringify({
    schema_id: v4 ? 'superwagie.g3-writer-evaluation-receipt.v4' : v3 ? 'superwagie.g3-writer-evaluation-receipt.v3' : 'superwagie.g3-writer-evaluation-receipt.v2', schema_version: v4 ? 4 : v3 ? 3 : 2,
    fixture: FIXTURE_ID, evaluation_sha256: evaluationSha256, platform,
    run_identity: (v2 || v3 || v4) ? evaluation.run_identity : null,
    source_identity: evaluation.source_identity, renderer: evaluation.renderer,
    human_receipt_sha256: humanReceiptSha256,
    human_receipt_summary: humanReceiptValidation?.summary ?? null,
    artifact_set_sha256: coreArtifactSetSha256, artifacts: artifactReceipts,
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const publishedArtifacts = publishedArtifactManifest(publicationArtifactsDir, artifactsDir);
  const evidenceBinding = {
    evaluation_sha256: evaluationSha256,
    human_receipt_sha256: humanReceiptSha256,
    artifact_set_sha256: sha256(Buffer.from(JSON.stringify(publishedArtifacts))),
    artifacts: publishedArtifacts,
    ...((v3 || v4) ? {
      generation_receipt_sha256: generationValidation.receiptSha256,
      wps_renderer_identity_sha256: observationValidation.rendererIdentitySha256,
      wps_session_id: observationValidation.sessionId,
      collector_authenticated: v4 ? collectorValidation.authenticated : false,
      collector_signer_id: v4 ? collectorValidation.signerId : null,
    } : {}),
  };

  const automatedPassed = AUTOMATED_CHECK_KEYS.filter((key) => evaluation.checks[key]).length;
  const manualPassed = MANUAL_CHECK_KEYS.filter((key) => derivedManual[key]).length;
  const failedAutomated = AUTOMATED_CHECK_KEYS.filter((key) => !evaluation.checks[key]);
  const missingManual = MANUAL_CHECK_KEYS.filter((key) => !derivedManual[key]);
  const metrics = {
    automated_checks_total: AUTOMATED_CHECK_KEYS.length, automated_checks_passed: automatedPassed,
    manual_checks_total: MANUAL_CHECK_KEYS.length, manual_checks_passed: manualPassed,
    host_skill_mirror_status: evaluation.source_identity.host_skill_mirror_status,
    ...(v4 ? { collector_authenticated: collectorValidation.authenticated } : {}),
  };
  if (failedAutomated.length > 0) {
    outputs.publish(resultDocument({ decision: 'NO_GO', reasons: ['AUTOMATED_WRITER_CHECK_FAILED', ...failedAutomated.map((key) => `FAILED_${key.toUpperCase()}`)], limitations: [], metrics, evidenceBinding, startedAt }));
    console.error(`FAIL ${FIXTURE_ID}: ${failedAutomated.join(', ')}`);
    process.exit(1);
  }
  const missingTrustedCollector = v4 && !collectorValidation.authenticated;
  const decision = missingManual.length > 0 || missingTrustedCollector ? 'CONDITIONAL_GO' : 'GO';
  const limitations = [
    ...missingManual.map((key) => MANUAL_LIMITATIONS[key]),
    ...(missingTrustedCollector ? ['A trusted gate-authorized collector signature is required before Writer evidence can be admitted as GO.'] : []),
  ];
  outputs.publish(resultDocument({ decision, reasons: [], limitations, metrics, evidenceBinding, startedAt }));
  console.log(`${decision} ${FIXTURE_ID}: automated=${automatedPassed}/${AUTOMATED_CHECK_KEYS.length} manual=${manualPassed}/${MANUAL_CHECK_KEYS.length}`);
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    outputs.discardStagedArtifacts();
    outputs.publish(resultDocument({ decision: 'NO_GO', reasons: ['WRITER_EVALUATION_INVALID'], limitations: [message], startedAt }));
  } catch (publicationError) {
    outputs.abandon();
    console.error(`Writer output publication failed: ${publicationError instanceof Error ? publicationError.message : String(publicationError)}`);
  }
  console.error(`INVALID ${FIXTURE_ID}: ${message}`);
  process.exit(1);
}
