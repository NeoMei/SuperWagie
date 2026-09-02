import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './task7-worker-protocol.mjs';

const sha = (bytes) => 'sha256:' + sha256(bytes);

function writeExclusive(root, relative, content) {
  const path = join(root, relative);
  const bytes = Buffer.from(content);
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return { path, sha256: sha(bytes), bytes: bytes.length };
}

function decisionDocument({ fixture, parentFixture, digest, contextDigest, generatedAt, runNonce }) {
  return [
    '# Task 7 child evidence decision',
    '',
    '- fixture: ' + fixture,
    '- evidence_revision: solution-b-task7-v1',
    '- platform: macos-15-arm64',
    '- parent_fixture: ' + parentFixture,
    '- admission_effect: none',
    '- generated_at: ' + generatedAt,
    '- runner: review-shell-host',
    '- run_nonce: ' + runNonce,
    '- execution: PASS',
    '- results_sha256: ' + digest,
    '- execution_context_sha256: ' + contextDigest,
    '',
    'draft decision: CONDITIONAL_GO',
    'reason: disposable macOS child evidence only; it cannot sign the parent fixture or Production Implementation Admission',
    'evidence_sha256: ' + digest,
    '',
    'No Owner role or signing time is present. This file is unsigned.',
    '',
  ].join('\n');
}

function runReviewHost({ repositoryRoot, candidateRoot, workRoot, runNonce }) {
  const electron = join(candidateRoot, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  const hostScript = join(repositoryRoot, 'scripts/poc/solution-b-task7/src/review-shell-host.mjs');
  const outputPath = join(workRoot, 'results.json');
  return new Promise((resolveRun) => {
    const child = spawn(electron, [
      hostScript,
      '--output', outputPath,
      '--repo-root', repositoryRoot,
      '--candidate-root', candidateRoot,
      '--run-root', workRoot,
      '--run-nonce', runNonce,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolveRun({ ok: false, error: error.message, stdout, stderr }));
    child.once('exit', (code, signal) => resolveRun({
      ok: code === 0 && signal === null, code, signal, stdout, stderr, outputPath,
    }));
  });
}

export async function buildTask7Evidence({ repositoryRoot, candidateRoot, evidenceBase, runId, runNonce }) {
  const generatedAt = new Date().toISOString();
  const manifestSha256 = sha(readFileSync(join(candidateRoot, 'runtime-manifest.json')));
  const workRoot = join(evidenceBase, '.task7-work', runId);
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });

  const run = await runReviewHost({ repositoryRoot, candidateRoot, workRoot, runNonce });
  if (!run.ok) throw new Error('TASK7_HOST_RUN_FAILED: ' + run.code + ' ' + run.stderr.slice(-2000));

  const resultsBytes = readFileSync(run.outputPath);
  const resultsDigest = sha(resultsBytes);
  const children = [];
  const fixtures = [
    { fixture: 'G3-REVIEW-001-MACOS-SPIKE', parent: 'G3-REVIEW-001' },
    { fixture: 'G3-REVIEW-002-MACOS-RECOVERY', parent: 'G3-REVIEW-002' },
  ];
  for (const { fixture, parent } of fixtures) {
    const root = join(evidenceBase, 'gate-3', fixture + '-' + runId);
    try {
      mkdirSync(root, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('TASK7_EVIDENCE_ROOT_EXISTS:' + root);
      throw error;
    }
    const artifacts = join(root, 'artifacts');
    mkdirSync(artifacts, { recursive: false, mode: 0o700 });
    const context = {
      schema_id: 'superwagie.solution-b-task7-execution-context.v1',
      generated_at: generatedAt,
      run_nonce: runNonce,
      candidate_manifest_sha256: manifestSha256,
      parent_fixture: parent,
      child_fixture: fixture,
      admission_effect: 'none',
    };
    const contextReceipt = writeExclusive(root, 'artifacts/execution-context.json',
      JSON.stringify(context, null, 2) + '\n');
    const resultsReceipt = writeExclusive(root, 'results.json', resultsBytes);
    const decision = decisionDocument({
      fixture, parentFixture: parent, digest: resultsReceipt.sha256,
      contextDigest: contextReceipt.sha256, generatedAt, runNonce,
    });
    const decisionReceipt = writeExclusive(root, 'decision.md', decision);
    const manifest = {
      schema_id: 'superwagie.solution-b-task7-manifest.v1',
      generated_at: generatedAt,
      run_nonce: runNonce,
      results_sha256: resultsReceipt.sha256,
      decision_sha256: decisionReceipt.sha256,
      context_sha256: contextReceipt.sha256,
      artifacts: ['execution-context.json'],
    };
    writeExclusive(root, 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    children.push({ fixture, parent, root, results_sha256: resultsReceipt.sha256, decision_sha256: decisionReceipt.sha256 });
  }
  return {
    schema_id: 'superwagie.solution-b-task7-publication.v1',
    run_id: runId,
    run_nonce: runNonce,
    generated_at: generatedAt,
    candidate_manifest_sha256: manifestSha256,
    children,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const repositoryRoot = resolve(process.env.SUPERWAGIE_REPO_ROOT ?? process.cwd());
  const candidateRoot = resolve(process.env.SUPERWAGIE_CANDIDATE_ROOT
    ?? join(repositoryRoot, 'evidence/gate-0/solution-b-v1-ac43a9a9bf75/candidate-root'));
  const runId = (process.env.SUPERWAGIE_RUN_ID ?? new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)) + '-' + process.pid;
  const runNonce = process.env.SUPERWAGIE_RUN_NONCE ?? createHash('sha256').update(runId).digest('hex').slice(0, 32);
  const publication = await buildTask7Evidence({
    repositoryRoot, candidateRoot,
    evidenceBase: join(repositoryRoot, 'evidence'),
    runId, runNonce,
  });
  process.stdout.write(JSON.stringify(publication, null, 2) + '\n');
}
