import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, join, resolve } from 'node:path';
import {
  validateCandidateClosure, runIsolationMatrix, runBoundaryAttacks, runExtensionLifecycle,
} from './task5-lib.mjs';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const ChildRunners = Object.freeze({
  G0_DEPS_001_MACOS_CANDIDATE: {
    gate: 'gate-0', fixture: 'G0-DEPS-001-MACOS-CANDIDATE',
    run: async ({ candidateRoot, workRoot }) => validateCandidateClosure({ candidateRoot, workRoot, exerciseAttacks: true }),
  },
  G0_ISOLATION_001_MACOS_ZERO_DIFF: {
    gate: 'gate-0', fixture: 'G0-ISOLATION-001-MACOS-ZERO-DIFF',
    run: async ({ candidateRoot, workRoot }) => runIsolationMatrix({ candidateRoot, workRoot }),
  },
  G5_ATTACK_001_MACOS_ACTUAL_BOUNDARY: {
    gate: 'gate-5', fixture: 'G5-ATTACK-001-MACOS-ACTUAL-BOUNDARY',
    run: async ({ candidateRoot, workRoot, actualResultPath }) => runBoundaryAttacks({ candidateRoot, workRoot, actualResultPath }),
  },
  G5_EXT_001_MACOS_WORKER: {
    gate: 'gate-5', fixture: 'G5-EXT-001-MACOS-WORKER',
    run: async ({ candidateRoot, workRoot }) => runExtensionLifecycle({ candidateRoot, workRoot }),
  },
});

function sanitize(value, replacements) {
  if (typeof value === 'string') {
    let output = value;
    for (const [needle, label] of replacements) output = output.split(needle).join(label);
    return output;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, replacements)]));
  }
  return value;
}

function writeFileExclusive(root, relative, bytes, mode = 0o600) {
  const path = join(root, relative);
  writeFileSync(path, bytes, { flag: 'wx', mode });
  return { path, sha256: sha256(bytes), bytes: bytes.length };
}

function decisionDocument({ key, fixture, pass, digest, contextDigest, generatedAt }) {
  return `# Task 5 child evidence decision

- fixture: ${fixture}
- evidence_revision: solution-b-task5-v1
- platform: macos-15-arm64
- parent_fixture: ${fixture.replace('-MACOS-CANDIDATE', '').replace('-MACOS-ZERO-DIFF', '').replace('-MACOS-ACTUAL-BOUNDARY', '').replace('-MACOS-WORKER', '')}
- admission_effect: none
- generated_at: ${generatedAt}
- runner: ${key}
- execution: ${pass ? 'PASS' : 'FAIL'}
- results_sha256: ${digest}
- execution_context_sha256: ${contextDigest}

\`\`\`text
draft decision: ${pass ? 'CONDITIONAL_GO' : 'NO_GO'}
reason: disposable macOS child evidence only; it cannot sign the parent fixture or Production Implementation Admission
evidence_sha256: ${digest}
\`\`\`

No Owner role or signing time is present. This file is unsigned.
`;
}

export async function buildTask5Evidence({
  candidateRoot,
  evidenceBase,
  runId,
  runners = {},
  actualResultPath,
}) {
  if (!candidateRoot || !evidenceBase || !runId) throw new Error('TASK5_EVIDENCE_INPUT_REQUIRED');
  const selectedRunners = Object.fromEntries(Object.entries(ChildRunners).map(([key, definition]) => [
    key, { ...definition, run: runners[key] ?? definition.run },
  ]));
  const generatedAt = new Date().toISOString();
  const manifestBytes = readFileSync(join(candidateRoot, 'runtime-manifest.json'));
  const manifestSha256 = sha256(manifestBytes);
  const runs = {};
  for (const [key, definition] of Object.entries(selectedRunners)) {
    const workRoot = mkdtempSync(join(tmpdir(), `superwagie-task5-${key.toLowerCase()}-`));
    const raw = await definition.run({ candidateRoot, workRoot, actualResultPath });
    const replacements = [
      [candidateRoot, '<candidate>'], [workRoot, '<work>'], [tmpdir(), '<tmp>'],
      [resolve(candidateRoot, '../../..'), '<repo>'], [process.env.HOME, '<home>'],
    ].filter(([needle]) => typeof needle === 'string' && needle.length > 0);
    const result = sanitize({
      schema_id: 'superwagie.solution-b-task5-child-result.v1', schema_version: 1,
      generated_at: generatedAt, runner: key, gate: definition.gate, fixture: definition.fixture,
      platform: 'macos-15-arm64', evidence_revision: 'solution-b-task5-v1', admission_effect: 'none',
      candidate_manifest_sha256: manifestSha256, execution: raw,
    }, replacements);
    const gateDirectory = join(evidenceBase, definition.gate);
    mkdirSync(gateDirectory, { recursive: true, mode: 0o700 });
    const root = join(gateDirectory, `${definition.fixture}-${runId}`);
    try { mkdirSync(root, { recursive: false, mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw new Error(`TASK5_EVIDENCE_ROOT_EXISTS:${root}`); throw error; }
    const artifactsDirectory = join(root, 'artifacts');
    mkdirSync(artifactsDirectory, { recursive: false, mode: 0o700 });
    const context = `${JSON.stringify({
      schema_id: 'superwagie.solution-b-task5-execution-context.v1', runner: key,
      generated_at: generatedAt, candidate_manifest_sha256: manifestSha256,
      sanitized_labels: ['<candidate>', '<work>', '<tmp>', '<repo>', '<home>'],
    }, null, 2)}\n`;
    const contextReceipt = writeFileExclusive(root, 'artifacts/execution-context.json', Buffer.from(context));
    const resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
    const resultReceipt = writeFileExclusive(root, 'results.json', resultBytes);
    if (raw.scenarios?.length) {
      raw.scenarios.forEach((scenario, index) => {
        if (scenario.actual_result_path) {
          const actualBytes = readFileSync(scenario.actual_result_path);
          const sanitizedActual = sanitize(JSON.parse(actualBytes.toString('utf8')), replacements);
          writeFileExclusive(root, `artifacts/isolation-scenario-${index}-actual.json`,
            Buffer.from(`${JSON.stringify(sanitizedActual, null, 2)}\n`));
        }
      });
    }
    const decision = decisionDocument({
      key, fixture: definition.fixture, pass: raw.pass === true, digest: resultReceipt.sha256,
      contextDigest: contextReceipt.sha256, generatedAt,
    });
    const decisionReceipt = writeFileExclusive(root, 'decision.md', Buffer.from(decision));
    runs[key] = { key, fixture: definition.fixture, gate: definition.gate, root, pass: raw.pass === true,
      results_sha256: resultReceipt.sha256, decision_sha256: decisionReceipt.sha256,
      artifacts: [basename(contextReceipt.path)] };
  }
  return { schema_id: 'superwagie.solution-b-task5-publication.v1', run_id: runId,
    generated_at: generatedAt, candidate_manifest_sha256: manifestSha256, runs };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const repositoryRoot = resolve(import.meta.dirname, '../../../..');
  const candidate = join(repositoryRoot, 'evidence/gate-0/solution-b-v1-ac43a9a9bf75/candidate-root');
  const actual = join(repositoryRoot, 'evidence/gate-0/solution-b-v1-ac43a9a9bf75/raw-run/actual-electron-result.json');
  const runId = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${process.pid}`;
  const publication = await buildTask5Evidence({
    candidateRoot: candidate, evidenceBase: join(repositoryRoot, 'evidence'), runId, actualResultPath: actual,
  });
  process.stdout.write(`${JSON.stringify(publication, null, 2)}\n`);
}
