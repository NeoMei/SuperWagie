import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { verifyEvidenceArtifactBindings } from '../validation-status-audit.mjs';

const EXECUTOR = resolve('scripts/poc/gate-3/writer-gate.mjs');
const PLATFORM = 'macos-15-arm64';
const STAGE_IDS = ['writer.content_ready', 'writer.requirements', 'writer.top_outline', 'writer.chapter_writing', 'writer.illustrations', 'writer.wps_composition', 'writer.rendered_review'];
const HUMAN_GATE_IDS = ['writer.content_ready', 'writer.requirements', 'writer.top_outline'];
const ARTIFACT_NAMES = ['source_md', 'docx', 'pdf', 'restart_docx', 'automation_observation', 'opened_screenshot', 'edited_screenshot', 'restored_screenshot', 'discard_prompt_screenshot'];
const VALID_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function writeReceiptFile(root, name, bytes) {
  const receiptRoot = join(root, 'inputs', 'human-receipt');
  mkdirSync(receiptRoot, { recursive: true });
  writeFileSync(join(receiptRoot, name), bytes);
  return { path: name, sha256: sha256(bytes) };
}

function completeHumanReceipt(root, evaluation) {
  const stageArtifacts = STAGE_IDS.map((stageId, index) => writeReceiptFile(root, `stage-${index + 1}.json`, Buffer.from(`stage ${index + 1} ${stageId}\n`)));
  const pageEvidence = [1, 2, 3].map((page) => writeReceiptFile(root, `wps-page-${page}.png`, VALID_PNG));
  const controlledCopy = writeReceiptFile(root, 'controlled-copy.docx', readFileSync(join(root, evaluation.artifacts.restart_docx.path)));
  return {
    schema_id: 'superwagie.g3-writer-human-receipt.v1', schema_version: 1,
    fixture: 'G3-WRITER-001', platform: PLATFORM,
    run_id: evaluation.run_identity.run_id, evaluation_id: evaluation.run_identity.evaluation_id,
    executed_at: '2026-09-01T12:00:00.000Z',
    operator: { role: 'technical-validation-operator', actor_id: 'human-operator-1' },
    bindings: {
      source_md_sha256: evaluation.artifacts.source_md.sha256,
      canonical_docx_sha256: evaluation.artifacts.docx.sha256,
      restart_docx_sha256: evaluation.artifacts.restart_docx.sha256,
      pdf_sha256: evaluation.artifacts.pdf.sha256,
      automation_observation_sha256: evaluation.artifacts.automation_observation.sha256,
      superwriter_commit: evaluation.source_identity.superwriter_commit,
      wpscomposer_commit: evaluation.source_identity.wpscomposer_commit,
    },
    stages: STAGE_IDS.map((stageId, index) => ({
      stage_id: stageId, checkpoint_id: `checkpoint-${index + 1}`, revision: index + 1,
      artifact: stageArtifacts[index], completed_at: `2026-09-01T12:0${index}:00.000Z`,
    })),
    human_gates: HUMAN_GATE_IDS.map((gateId, index) => ({
      gate_id: gateId, interaction_id: `interaction-${index + 1}`, revision: index + 1,
      decision: 'approved', executed_at: `2026-09-01T12:1${index}:00.000Z`,
    })),
    visual_review: {
      renderer: { application: 'WPS Office', version: '12.1.28492' },
      page_count: 3, conclusion: 'approved', reviewed_at: '2026-09-01T12:20:00.000Z',
      pages: pageEvidence.map((evidence, index) => ({ page_number: index + 1, conclusion: 'approved', evidence })),
    },
    wps_lifecycle: {
      controlled_copy: controlledCopy, discard_confirmed: true, close_confirmed: true,
      reopen_confirmed: true, reopened_sha256: controlledCopy.sha256,
      confirmed_at: '2026-09-01T12:30:00.000Z',
    },
  };
}

function incompleteHumanReceipt(root, evaluation) {
  const receipt = completeHumanReceipt(root, evaluation);
  receipt.stages = receipt.stages.slice(0, 6);
  receipt.human_gates = receipt.human_gates.slice(0, 2);
  receipt.visual_review.pages = receipt.visual_review.pages.slice(0, 2);
  receipt.visual_review.conclusion = 'pending';
  receipt.visual_review.reviewed_at = null;
  receipt.wps_lifecycle.reopen_confirmed = false;
  receipt.wps_lifecycle.confirmed_at = null;
  return receipt;
}

function createEvaluation(root, options = {}) {
  mkdirSync(join(root, 'inputs'), { recursive: true });
  const artifacts = {};
  for (const name of ARTIFACT_NAMES) {
    const extension = name.includes('screenshot') ? 'png' : name === 'source_md' ? 'md' : name === 'automation_observation' ? 'json' : name === 'pdf' ? 'pdf' : 'docx';
    const bytes = Buffer.from(`fixed ${name} evidence\n`);
    const relativePath = `inputs/${name}.${extension}`;
    writeFileSync(join(root, relativePath), bytes);
    artifacts[name] = { path: relativePath, sha256: sha256(bytes) };
  }
  const runId = basename(root).replace(/[^A-Za-z0-9._:-]/g, '-');
  const evaluation = {
    schema_id: 'superwagie.g3-writer-evaluation.v2', schema_version: 2,
    fixture: 'G3-WRITER-001', platform: PLATFORM, executed_at: '2026-09-01T12:31:00.000Z',
    operator_role: 'technical-validation-operator',
    run_identity: { run_id: runId, evaluation_id: `writer-evaluation-${runId}` },
    source_identity: {
      superwriter_commit: 'a'.repeat(40), wpscomposer_commit: '54cd721437c774373f7a6215b5b09d742d11b884',
      wpscomposer_snapshot: 'clean-detached-snapshot', host_skill_mirror_status: 'drift-detected',
    },
    renderer: { application: 'WPS Office', version: '12.1.28492', pdf_creator: 'WPS 文字', page_count: 3 },
    artifacts,
    checks: {
      superwriter_acceptance_example: true, wpscomposer_clean_preflight: true, docx_structure: true,
      pdf_structure: true, required_content_coverage: true, kill_preserved_existing_output: true,
      restart_semantically_equal: true, embedded_image_hash_equal: true, wps_opened_real_document: true,
      wps_edit_entered_dirty_state: true, wps_undo_restored_original_text: true, canonical_hash_unchanged: true,
    },
    manual_checks: {
      seven_stage_receipts_complete: false, three_human_gates_complete: false,
      human_visual_review_approved: false, wps_discard_close_reopen_confirmed: false,
    },
    human_receipt: null,
  };
  if ((options.receipt ?? 'none') !== 'none') {
    const receipt = options.receipt === 'complete' ? completeHumanReceipt(root, evaluation) : incompleteHumanReceipt(root, evaluation);
    if (options.validPageEvidence) {
      for (const page of receipt.visual_review.pages) {
        writeFileSync(join(root, 'inputs', 'human-receipt', page.evidence.path), VALID_PNG);
        page.evidence.sha256 = sha256(VALID_PNG);
      }
    }
    options.mutateReceipt?.(receipt, root, evaluation);
    const receiptPath = join(root, 'inputs', 'human-receipt', 'receipt.json');
    const receiptBytes = options.receiptBytes?.(receipt) ?? Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    writeFileSync(receiptPath, receiptBytes);
    evaluation.human_receipt = {
      path: 'inputs/human-receipt/receipt.json', sha256: sha256(receiptBytes),
      summary: {
        run_id: receipt.run_id, evaluation_id: receipt.evaluation_id, stage_receipts: receipt.stages.length,
        human_gate_receipts: receipt.human_gates.length, visual_pages_reviewed: receipt.visual_review.pages.length,
        lifecycle_confirmations: [receipt.wps_lifecycle.discard_confirmed, receipt.wps_lifecycle.close_confirmed, receipt.wps_lifecycle.reopen_confirmed].filter(Boolean).length,
      },
    };
    const complete = options.receipt === 'complete';
    for (const key of Object.keys(evaluation.manual_checks)) evaluation.manual_checks[key] = complete;
  }
  options.mutateEvaluation?.(evaluation, root);
  const evaluationPath = join(root, 'evaluation.json');
  writeFileSync(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);
  return { evaluationPath, evaluation };
}

function createLegacyEvaluation(root) {
  const { evaluationPath, evaluation } = createEvaluation(root);
  evaluation.schema_id = 'superwagie.g3-writer-evaluation.v1'; evaluation.schema_version = 1;
  delete evaluation.run_identity; delete evaluation.human_receipt; delete evaluation.artifacts.automation_observation;
  delete evaluation.renderer.page_count;
  writeFileSync(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);
  return evaluationPath;
}

function createTrustedEvaluation(root, options = {}) {
  const { evaluation } = createEvaluation(root);
  for (const key of ['opened_screenshot', 'edited_screenshot', 'restored_screenshot', 'discard_prompt_screenshot']) {
    writeFileSync(join(root, evaluation.artifacts[key].path), VALID_PNG);
    evaluation.artifacts[key].sha256 = sha256(VALID_PNG);
  }
  const superwriter = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), status: 'clean', snapshot: 'detached' };
  const wpscomposer = { commit: '5'.repeat(40), tree: '6'.repeat(40), status: 'clean', snapshot: 'detached' };
  const generation = {
    schema_id: 'superwagie.g3-writer-generation-receipt.v1', schema_version: 1,
    fixture: 'G3-WRITER-001', platform: PLATFORM, generation_id: `generation-${evaluation.run_identity.run_id}`, generated_at: '2026-09-01T11:55:00.000Z',
    sources: { superwriter, wpscomposer },
    invocation: { capability_id: 'superwriter.writer', capability_version: '1.2.3', executable_source_path: 'scripts/generate.py', executable_sha256: 'e'.repeat(64), arguments_sha256: 'f'.repeat(64) },
    artifacts: {
      source_md_sha256: evaluation.artifacts.source_md.sha256, canonical_docx_sha256: evaluation.artifacts.docx.sha256,
      restart_docx_sha256: evaluation.artifacts.restart_docx.sha256, pdf_sha256: evaluation.artifacts.pdf.sha256,
    },
  };
  options.mutateGeneration?.(generation);
  const generationBytes = Buffer.from(`${JSON.stringify(generation, null, 2)}\n`);
  const generationPath = 'inputs/generation-receipt.json'; writeFileSync(join(root, generationPath), generationBytes);
  evaluation.artifacts.generation_receipt = { path: generationPath, sha256: sha256(generationBytes) };

  const rendererIdentity = {
    application: 'WPS Office', application_path: '/Applications/wpsoffice.app', bundle_id: 'com.kingsoft.wpsoffice.mac',
    version: '12.1.28492', build: '1001', executable_path: '/Applications/wpsoffice.app/Contents/MacOS/wpsoffice',
    executable_sha256: '7'.repeat(64), codesign_identifier: 'com.kingsoft.wpsoffice.mac', team_identifier: 'YK4WKE5WAM',
  };
  const screenshot = { sha256: sha256(VALID_PNG), media_type: 'image/png', width: 1, height: 1, session_id: 'wps-session-1' };
  const observation = {
    schema_id: 'superwagie.g3-writer-wps-automation-observation.v2', schema_version: 2,
    fixture: 'G3-WRITER-001', platform: PLATFORM, executed_at: '2026-09-01T12:20:00.000Z', operator_role: evaluation.operator_role,
    session: { session_id: 'wps-session-1', run_id: evaluation.run_identity.run_id, started_at: '2026-09-01T12:10:00.000Z', finished_at: '2026-09-01T12:20:00.000Z' },
    renderer_identity: rendererIdentity, document: 'writer-restarted.docx', document_sha256_after_automation: evaluation.artifacts.restart_docx.sha256,
    observations: { wps_opened_real_document: true, wps_edit_entered_dirty_state: true, wps_undo_restored_original_text: true, canonical_hash_unchanged: true, wps_discard_close_reopen_confirmed: false },
    screenshots: { opened: { ...screenshot }, edited: { ...screenshot }, restored: { ...screenshot }, discard_prompt: { ...screenshot } }, note: 'synthetic schema test only',
  };
  options.mutateObservation?.(observation);
  const observationBytes = Buffer.from(`${JSON.stringify(observation, null, 2)}\n`);
  writeFileSync(join(root, evaluation.artifacts.automation_observation.path), observationBytes);
  evaluation.artifacts.automation_observation.sha256 = sha256(observationBytes);
  const rendererIdentitySha256 = sha256(Buffer.from(JSON.stringify(rendererIdentity)));

  evaluation.schema_id = 'superwagie.g3-writer-evaluation.v3'; evaluation.schema_version = 3;
  evaluation.source_identity = {
    superwriter_commit: superwriter.commit, superwriter_tree: superwriter.tree, superwriter_snapshot: 'clean-detached-snapshot',
    wpscomposer_commit: wpscomposer.commit, wpscomposer_tree: wpscomposer.tree, wpscomposer_snapshot: 'clean-detached-snapshot',
    generation_id: generation.generation_id, generation_receipt_sha256: evaluation.artifacts.generation_receipt.sha256,
    host_skill_mirror_status: 'drift-detected',
  };
  evaluation.renderer = {
    application: 'WPS Office', version: rendererIdentity.version, build: rendererIdentity.build,
    bundle_id: rendererIdentity.bundle_id, team_identifier: rendererIdentity.team_identifier,
    executable_sha256: rendererIdentity.executable_sha256, identity_sha256: rendererIdentitySha256,
    session_id: observation.session.session_id, pdf_creator: 'WPS 文字', page_count: 3,
  };
  const receipt = completeHumanReceipt(root, evaluation);
  receipt.schema_id = 'superwagie.g3-writer-human-receipt.v2'; receipt.schema_version = 2;
  Object.assign(receipt.bindings, {
    generation_receipt_sha256: evaluation.artifacts.generation_receipt.sha256,
    renderer_identity_sha256: rendererIdentitySha256, wps_session_id: observation.session.session_id,
  });
  Object.assign(receipt.visual_review.renderer, { identity_sha256: rendererIdentitySha256, session_id: observation.session.session_id });
  for (const page of receipt.visual_review.pages) {
    writeFileSync(join(root, 'inputs', 'human-receipt', page.evidence.path), VALID_PNG);
    Object.assign(page.evidence, { sha256: sha256(VALID_PNG), media_type: 'image/png', width: 1, height: 1, session_id: observation.session.session_id });
  }
  options.mutateReceipt?.(receipt);
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(join(root, 'inputs', 'human-receipt', 'receipt.json'), receiptBytes);
  evaluation.human_receipt = { path: 'inputs/human-receipt/receipt.json', sha256: sha256(receiptBytes), summary: {
    run_id: receipt.run_id, evaluation_id: receipt.evaluation_id, stage_receipts: 7, human_gate_receipts: 3, visual_pages_reviewed: 3, lifecycle_confirmations: 3,
  } };
  for (const key of Object.keys(evaluation.manual_checks)) evaluation.manual_checks[key] = true;
  options.mutateEvaluation?.(evaluation);
  const evaluationPath = join(root, 'evaluation.json'); writeFileSync(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);
  return { evaluationPath, evaluation };
}

function runGate(evaluation, root, env = {}) {
  const nonce = `${Date.now()}-${Math.random()}`;
  const results = join(root, `results-${nonce}.json`);
  const artifacts = join(root, `gate-artifacts-${nonce}`);
  const run = spawnSync(process.execPath, [EXECUTOR, '--fixture', 'G3-WRITER-001', '--platform', PLATFORM,
    '--results-json', results, '--artifacts-dir', artifacts, ...(evaluation ? ['--evaluation-result', evaluation] : [])],
  { encoding: 'utf8', env: { ...process.env, ...env } });
  return { run, results, artifacts, document: JSON.parse(readFileSync(results, 'utf8')) };
}

function runGateAt(evaluation, results, artifacts, env = {}) {
  return spawnSync(process.execPath, [EXECUTOR, '--fixture', 'G3-WRITER-001', '--platform', PLATFORM,
    '--results-json', results, '--artifacts-dir', artifacts, ...(evaluation ? ['--evaluation-result', evaluation] : [])],
  { encoding: 'utf8', env: { ...process.env, ...env } });
}

function spawnGateAt(evaluation, results, artifacts) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [EXECUTOR, '--fixture', 'G3-WRITER-001', '--platform', PLATFORM,
      '--results-json', results, '--artifacts-dir', artifacts, ...(evaluation ? ['--evaluation-result', evaluation] : [])],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

function expectInvalid(actual, pattern = /invalid/i) {
  assert.equal(actual.run.status, 1, actual.run.stderr || actual.run.stdout);
  assert.equal(actual.document.decision_hint, 'NO_GO');
  assert.deepEqual(actual.document.reasons, ['WRITER_EVALUATION_INVALID']);
  assert.match(actual.document.limitations[0], pattern);
}

function expectForcedTermination(run) {
  if (process.platform === 'win32') {
    assert.equal(run.signal, null);
    assert.notEqual(run.status, 0);
  } else {
    assert.equal(run.signal, 'SIGKILL');
  }
}

test('parallel synthetic fixtures use unique run and evaluation identities', () => {
  const leftRoot = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const rightRoot = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const left = createEvaluation(leftRoot).evaluation.run_identity;
  const right = createEvaluation(rightRoot).evaluation.run_identity;
  assert.notEqual(left.run_id, right.run_id);
  assert.notEqual(left.evaluation_id, right.evaluation_id);
});

test('missing real Writer evaluation is blocked rather than guessed', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const actual = runGate('', root);
  assert.equal(actual.run.status, 2);
  assert.equal(actual.document.decision_hint, 'BLOCKED_ENVIRONMENT');
});

test('published Writer results and artifact destinations are immutable', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const results = join(root, 'results.json'); const artifacts = join(root, 'artifacts');
  const first = runGateAt('', results, artifacts);
  assert.equal(first.status, 2, first.stderr);
  const original = readFileSync(results);
  const second = runGateAt('', results, artifacts);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists|reserved|immutable/i);
  assert.deepEqual(readFileSync(results), original);
});

test('concurrent Writer publishers have exactly one output reservation winner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const results = join(root, 'results.json'); const artifacts = join(root, 'artifacts');
  const runs = await Promise.all([spawnGateAt('', results, artifacts), spawnGateAt('', results, artifacts)]);
  assert.equal(runs.filter((run) => /reserved|already exists|immutable/i.test(run.stderr)).length, 1,
    JSON.stringify(runs));
  assert.equal(runs.filter((run) => run.status === 2 && !/reserved|already exists|immutable/i.test(run.stderr)).length, 1,
    JSON.stringify(runs));
  assert.equal(JSON.parse(readFileSync(results, 'utf8')).decision_hint, 'BLOCKED_ENVIRONMENT');
});

test('Writer output reservation rejects nonempty or symlink artifact destinations without touching them', () => {
  for (const attack of ['nonempty', 'symlink']) {
    const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
    const results = join(root, 'results.json'); const artifacts = join(root, 'artifacts');
    if (attack === 'nonempty') {
      mkdirSync(artifacts); writeFileSync(join(artifacts, 'historical.txt'), 'preserve me\n');
    } else {
      const real = join(root, 'real-artifacts'); mkdirSync(real); symlinkSync(real, artifacts);
    }
    const actual = runGateAt('', results, artifacts);
    assert.equal(actual.status, 1); assert.equal(existsSync(results), false);
    assert.match(actual.stderr, /real directory|not empty|immutable/i);
    if (attack === 'nonempty') assert.equal(readFileSync(join(artifacts, 'historical.txt'), 'utf8'), 'preserve me\n');
  }
});

test('invalid evaluations publish an empty artifact set rather than recognizable half-products', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const { evaluationPath, evaluation } = createEvaluation(root);
  evaluation.artifacts.pdf.sha256 = '0'.repeat(64);
  writeFileSync(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);
  const actual = runGate(evaluationPath, root);
  expectInvalid(actual, /artifact pdf hash mismatch/i);
  assert.equal(existsSync(actual.artifacts), true);
  assert.deepEqual(readdirSync(actual.artifacts).filter((entry) => entry !== '.writer-transaction.json'), []);
});

test('legacy evidence and v2 evaluation without a receipt remain conditional', () => {
  for (const legacy of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
    const evaluation = legacy ? createLegacyEvaluation(root) : createEvaluation(root).evaluationPath;
    const actual = runGate(evaluation, root);
    assert.equal(actual.run.status, 0, actual.run.stderr);
    assert.equal(actual.document.decision_hint, 'CONDITIONAL_GO');
    assert.equal(actual.document.metrics.manual_checks_passed, 0);
    assert.equal(actual.document.limitations.length, 4);
    assert.equal(verifyEvidenceArtifactBindings(actual.results).valid, true);
  }
});

test('manual booleans cannot manufacture GO without a receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const { evaluationPath } = createEvaluation(root, { mutateEvaluation(document) { for (const key of Object.keys(document.manual_checks)) document.manual_checks[key] = true; } });
  expectInvalid(runGate(evaluationPath, root), /manual_checks.*receipt/i);
});

test('legacy receipt cannot manufacture GO without generation provenance and bound WPS observation', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const { evaluationPath } = createEvaluation(root, { receipt: 'complete', validPageEvidence: true });
  expectInvalid(runGate(evaluationPath, root), /generation provenance|WPS observation|legacy receipt/i);
});

test('text masquerading as PNG cannot satisfy page-by-page visual evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const { evaluationPath } = createEvaluation(root, { receipt: 'complete', mutateReceipt(receipt) {
    for (const page of receipt.visual_review.pages) {
      const bytes = Buffer.from(`text pretending to be page ${page.page_number}\n`);
      writeFileSync(join(root, 'inputs', 'human-receipt', page.evidence.path), bytes);
      page.evidence.sha256 = sha256(bytes);
    }
  } });
  expectInvalid(runGate(evaluationPath, root), /PNG|image|media/i);
});

test('hand-written synthetic v3 provenance cannot derive Writer GO', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const { evaluationPath } = createTrustedEvaluation(root);
  const actual = runGate(evaluationPath, root);
  expectInvalid(actual, /collector|source snapshot|generation provenance|legacy v3/i);
});

test('v4 evaluation cannot reach GO without its collector receipt and live source roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const { evaluationPath, evaluation } = createTrustedEvaluation(root);
  evaluation.schema_id = 'superwagie.g3-writer-evaluation.v4'; evaluation.schema_version = 4;
  writeFileSync(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);
  expectInvalid(runGate(evaluationPath, root), /collector receipt|source root|provenance/i);
});

test('legacy v3 cannot bypass collector provenance with subsidiary binding changes', () => {
  for (const create of [
    (root) => createTrustedEvaluation(root, { mutateGeneration(generation) { generation.artifacts.pdf_sha256 = '9'.repeat(64); } }),
    (root) => createTrustedEvaluation(root, { mutateReceipt(receipt) { receipt.visual_review.pages[0].evidence.session_id = 'other-session'; } }),
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
    const { evaluationPath } = create(root);
    expectInvalid(runGate(evaluationPath, root), /legacy v3|collector receipt|provenance/i);
  }
});

test('receipt exact schemas reject top-level and nested extras including forged owner_signed', () => {
  const cases = [
    (r) => { r.owner_signed = true; }, (r) => { r.operator.owner_signed = true; },
    (r) => { r.bindings.extra = 'x'; }, (r) => { r.stages[0].extra = true; },
    (r) => { r.stages[0].artifact.extra = true; }, (r) => { r.human_gates[0].owner_signed = true; },
    (r) => { r.visual_review.owner_signed = true; }, (r) => { r.visual_review.renderer.extra = true; },
    (r) => { r.visual_review.pages[0].extra = true; }, (r) => { r.wps_lifecycle.owner_signed = true; },
  ];
  for (const mutateReceipt of cases) {
    const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
    const { evaluationPath } = createEvaluation(root, { receipt: 'complete', mutateReceipt });
    expectInvalid(runGate(evaluationPath, root), /keys.*exact|undeclared|invalid/i);
  }
});

test('duplicate JSON keys are rejected before JSON.parse can collapse them', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const { evaluationPath } = createEvaluation(root, { receipt: 'complete', receiptBytes(receipt) {
    return Buffer.from(`${JSON.stringify(receipt, null, 2).replace('"schema_version": 1,', '"schema_version": 1,\n  "schema_version": 1,')}\n`);
  } });
  expectInvalid(runGate(evaluationPath, root), /duplicate JSON key/i);
});

test('receipt identity and binding mismatches fail closed', () => {
  const mutations = [
    (r) => { r.fixture = 'G3-WRITER-OTHER'; }, (r) => { r.platform = 'windows-11-x64'; },
    (r) => { r.run_id = 'other-run'; }, (r) => { r.evaluation_id = 'other-evaluation'; },
    (r) => { r.bindings.restart_docx_sha256 = '0'.repeat(64); },
    (r) => { r.bindings.automation_observation_sha256 = '1'.repeat(64); },
    (r) => { r.bindings.superwriter_commit = 'b'.repeat(40); },
    (r) => { r.operator.role = 'owner'; },
  ];
  for (const mutateReceipt of mutations) {
    const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
    const { evaluationPath } = createEvaluation(root, { receipt: 'complete', mutateReceipt });
    expectInvalid(runGate(evaluationPath, root), /mismatch|binding/i);
  }
});

test('stage and gate omissions cannot be promoted by manual boolean claims', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const { evaluationPath } = createEvaluation(root, { receipt: 'incomplete', mutateEvaluation(evaluation) {
    for (const key of Object.keys(evaluation.manual_checks)) evaluation.manual_checks[key] = true;
  } });
  expectInvalid(runGate(evaluationPath, root), /manual_checks.*derived/i);
});

test('duplicate, missing, and out-of-order stage or gate IDs are rejected', () => {
  const mutations = [
    (r) => { r.stages[1].stage_id = r.stages[0].stage_id; }, (r) => { r.stages.splice(3, 1); },
    (r) => { [r.stages[1], r.stages[2]] = [r.stages[2], r.stages[1]]; },
    (r) => { r.human_gates[1].gate_id = r.human_gates[0].gate_id; }, (r) => { r.human_gates.splice(1, 1); },
    (r) => { [r.human_gates[0], r.human_gates[1]] = [r.human_gates[1], r.human_gates[0]]; },
  ];
  for (const mutateReceipt of mutations) {
    const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
    const { evaluationPath } = createEvaluation(root, { receipt: 'complete', mutateReceipt });
    expectInvalid(runGate(evaluationPath, root), /stage|gate|order|missing|duplicate/i);
  }
});

test('visual approval requires real WPS, exact page coverage, and approved per-page conclusions', () => {
  const mutations = [
    (r) => { r.visual_review.renderer.application = 'LibreOffice'; }, (r) => { r.visual_review.page_count = 4; },
    (r) => { r.visual_review.pages[1].page_number = 1; }, (r) => { r.visual_review.pages[1].conclusion = 'rejected'; },
  ];
  for (const mutateReceipt of mutations) {
    const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
    const { evaluationPath } = createEvaluation(root, { receipt: 'complete', mutateReceipt });
    expectInvalid(runGate(evaluationPath, root), /WPS|page|visual|renderer/i);
  }
});

test('receipt and referenced evidence reject symlink, directory, escape, and oversized files', () => {
  const attacks = [
    (root, evaluationPath) => { const e = JSON.parse(readFileSync(evaluationPath)); const receipt = join(root, e.human_receipt.path); const real = join(root, 'real-receipt.json'); writeFileSync(real, readFileSync(receipt)); symlinkSync(real, join(root, 'receipt-link.json')); e.human_receipt.path = 'receipt-link.json'; e.human_receipt.sha256 = sha256(readFileSync(real)); writeFileSync(evaluationPath, `${JSON.stringify(e, null, 2)}\n`); },
    (root, evaluationPath) => { const e = JSON.parse(readFileSync(evaluationPath)); e.human_receipt.path = 'inputs/human-receipt'; writeFileSync(evaluationPath, `${JSON.stringify(e, null, 2)}\n`); },
    (root, evaluationPath) => { const e = JSON.parse(readFileSync(evaluationPath)); e.human_receipt.path = '../outside.json'; writeFileSync(evaluationPath, `${JSON.stringify(e, null, 2)}\n`); },
    (root, evaluationPath) => { const e = JSON.parse(readFileSync(evaluationPath)); const p = join(root, e.human_receipt.path); const r = JSON.parse(readFileSync(p)); r.stages[0].artifact.path = '../escape.json'; const b = Buffer.from(`${JSON.stringify(r, null, 2)}\n`); writeFileSync(p, b); e.human_receipt.sha256 = sha256(b); writeFileSync(evaluationPath, `${JSON.stringify(e, null, 2)}\n`); },
    (root, evaluationPath) => { const e = JSON.parse(readFileSync(evaluationPath)); const p = join(root, e.human_receipt.path); writeFileSync(p, Buffer.alloc(1024 * 1024 + 1, 0x20)); e.human_receipt.sha256 = sha256(readFileSync(p)); writeFileSync(evaluationPath, `${JSON.stringify(e, null, 2)}\n`); },
  ];
  for (const attack of attacks) {
    const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
    const { evaluationPath } = createEvaluation(root, { receipt: 'complete' }); attack(root, evaluationPath);
    expectInvalid(runGate(evaluationPath, root), /regular|symlink|path|escape|size|limit|hash/i);
  }
});

test('receipt evidence and artifact tampering invalidate a later audit run', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-'));
  const { evaluationPath, evaluation } = createEvaluation(root);
  const first = runGate(evaluationPath, root); assert.equal(first.run.status, 0, first.run.stderr);
  const artifact = join(root, evaluation.artifacts.source_md.path);
  writeFileSync(artifact, readFileSync(artifact).toString().replace('fixed', 'other'));
  expectInvalid(runGate(evaluationPath, root), /hash mismatch/i);
});

test('artifact hash mismatch and artifact symlinks invalidate the evaluation', () => {
  for (const attack of ['hash', 'symlink']) {
    const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-')); const { evaluationPath, evaluation } = createEvaluation(root);
    if (attack === 'hash') evaluation.artifacts.docx.sha256 = '0'.repeat(64);
    else { const real = join(root, 'real.docx'); const link = join(root, 'inputs', 'linked.docx'); const bytes = Buffer.from('linked bytes\n'); writeFileSync(real, bytes); symlinkSync(real, link); evaluation.artifacts.docx = { path: 'inputs/linked.docx', sha256: sha256(bytes) }; }
    writeFileSync(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);
    expectInvalid(runGate(evaluationPath, root), /hash mismatch|non-symlink|regular/i);
  }
});

test('same-inode same-size receipt rewrite during validation is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-')); const { evaluationPath } = createEvaluation(root, { receipt: 'complete' });
  const e = JSON.parse(readFileSync(evaluationPath)); const receiptPath = join(root, e.human_receipt.path); const before = readFileSync(receiptPath);
  const replacement = Buffer.from(before.toString().replace('human-operator-1', 'human-operator-2')); assert.equal(replacement.length, before.length);
  const actual = runGate(evaluationPath, root, { SUPERWAGIE_TEST_REWRITE_RECEIPT: receiptPath, SUPERWAGIE_TEST_REWRITE_RECEIPT_BASE64: replacement.toString('base64') });
  expectInvalid(actual, /changed|stable|metadata|bytes/i);
});

test('power-loss before artifact rename is recoverable and cannot publish evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-crash-'));
  const results = join(root, 'results.json'); const artifacts = join(root, 'artifacts');
  const crashed = runGateAt('', results, artifacts, { SUPERWAGIE_TEST_CRASH_POINT: 'before-artifact-rename' });
  expectForcedTermination(crashed);
  assert.equal(existsSync(results), false);
  const recovered = runGateAt('', results, artifacts);
  assert.equal(recovered.status, 2, recovered.stderr);
  assert.equal(JSON.parse(readFileSync(results, 'utf8')).decision_hint, 'BLOCKED_ENVIRONMENT');
});

test('power-loss after artifact rename leaves an unauditable orphan that the next reservation recovers', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-crash-'));
  const results = join(root, 'results.json'); const artifacts = join(root, 'artifacts');
  const crashed = runGateAt('', results, artifacts, { SUPERWAGIE_TEST_CRASH_POINT: 'after-artifact-rename' });
  expectForcedTermination(crashed);
  assert.equal(existsSync(results), false);
  assert.equal(existsSync(artifacts), true);
  const recovered = runGateAt('', results, artifacts);
  assert.equal(recovered.status, 2, recovered.stderr);
  assert.equal(JSON.parse(readFileSync(results, 'utf8')).decision_hint, 'BLOCKED_ENVIRONMENT');
});

test('power-loss after the result commit preserves a complete immutable publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-writer-crash-'));
  const results = join(root, 'results.json'); const artifacts = join(root, 'artifacts');
  const crashed = runGateAt('', results, artifacts, { SUPERWAGIE_TEST_CRASH_POINT: 'after-result-commit' });
  expectForcedTermination(crashed);
  assert.equal(JSON.parse(readFileSync(results, 'utf8')).decision_hint, 'BLOCKED_ENVIRONMENT');
  const repeated = runGateAt('', results, artifacts);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /already exists|reserved|immutable/i);
});
