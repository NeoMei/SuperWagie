import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const workflowPath = path.join(repo, '.github/workflows/office-reviewer-windows-contract.yml');

const CURRENT_ACTIONS = [
  'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'
];

test('checked-in Windows job proves solution B review fixtures fail closed without invoking legacy Tauri', async () => {
  const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.equal(workflow.name, 'Office Reviewer Solution B Blocker Contract');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(workflow.on.workflow_dispatch !== undefined);
  const job = workflow.jobs.office_reviewer_solution_b_blocker;
  assert.equal(job['runs-on'], 'windows-2022');
  assert.equal(job['timeout-minutes'], 15);
  assert.equal(job.environment, undefined);

  assert.deepEqual(job.steps.filter((step) => step.uses).map((step) => step.uses), CURRENT_ACTIONS);
  assert.match(job.steps[0].name, /checkout v4\.2\.2/i);
  assert.match(job.steps[1].name, /setup-node v4\.4\.0/i);
  assert.equal(job.steps[1].with['node-version'], '24.18.0');

  const commands = job.steps.filter((step) => step.run).map((step) => step.run).join('\n');
  const installIndex = commands.indexOf('npm ci --prefix scripts/poc/gate-3');
  const buildIndex = commands.indexOf('npm run build:ui --prefix scripts/poc/gate-3');
  const contractIndex = commands.indexOf('node scripts/poc/gate-3/windows-contract-check.mjs');
  assert.ok(installIndex >= 0, 'Windows CI must install the locked Gate 3 frontend dependencies');
  assert.ok(buildIndex > installIndex, 'Windows CI must build reviewer-ui/dist after npm ci');
  assert.ok(contractIndex > buildIndex, 'Windows CI must build reviewer-ui/dist before Rust cargo check');
  assert.match(commands, /windows-contract-check\.mjs/);
  assert.match(commands, /environment-gate\.test\.mjs/);
  assert.match(commands, /run-gate\.sh gate-3[\s\S]*G3-REVIEW-001/);
  assert.match(commands, /run-gate\.sh gate-3[\s\S]*G3-REVIEW-002/);
  assert.match(commands, /decision_hint[^\n]*BLOCKED_ENVIRONMENT/);
  assert.match(commands, /evidence_revision[^\n]*solution-b-v1/);
  assert.match(commands, /test "\$rc" -eq 2/);
  assert.ok(job.steps.filter((step) => /run-gate\.sh/.test(step.run ?? '')).every((step) => step.shell === 'bash'));
  assert.doesNotMatch(commands, /review-gate\.mjs|review-isolation-gate\.mjs|cargo build|cargo test|setup-fake-wps/i);

  const upload = job.steps.at(-1);
  assert.equal(upload.with.name, 'office-reviewer-solution-b-blocker-evidence');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.deepEqual(upload.with.path.split('\n'), [
    '${{ env.G3_REVIEW_001_ROOT }}',
    '${{ env.G3_REVIEW_002_ROOT }}'
  ]);
  const workflowText = JSON.stringify(workflow);
  assert.doesNotMatch(workflowText, /secrets\.|\/Users\/|CODEX_HOME|deploy|publish|npm publish|cargo publish/i);
  assert.doesNotMatch(upload.with.path, /evidence\/gate-3\/\*\*/);
});

test('toolchain identity is path-free, exact, canonical, lock-bound, and rejects schema or version drift', async () => {
  const { buildToolchainIdentity, validateToolchainIdentity } = await import('./windows-toolchain-identity.mjs');
  const packageLockSha256 = '1'.repeat(64);
  const cargoLockSha256 = '2'.repeat(64);
  const identityWithoutDigest = {
    arch: 'x64',
    lockfiles: {
      cargo: { path: 'scripts/poc/gate-3/reviewer-shell/Cargo.lock', sha256: cargoLockSha256 },
      npm: { path: 'scripts/poc/gate-3/package-lock.json', sha256: packageLockSha256 }
    },
    platform: 'windows-11-x64',
    schema_id: 'superwagie.office-reviewer-toolchain-identity.v1',
    schema_version: 1,
    tools: {
      cargo: {
        commit_date: '2026-06-30',
        commit_hash: 'c980f4866141969fab6254a680546a277789d6f0',
        host: 'x86_64-pc-windows-msvc',
        release: '1.97.1',
        version: 'cargo 1.97.1 (c980f4866 2026-06-30)'
      },
      node: { version: 'v24.18.0' },
      npm: { version: '12.0.1' },
      python: { version: 'Python 3.13.7' },
      rustc: {
        commit_date: '2026-07-14',
        commit_hash: '8bab26f4f68e0e26f0bb7960be334d5b520ea452',
        host: 'x86_64-pc-windows-msvc',
        release: '1.97.1',
        version: 'rustc 1.97.1 (8bab26f4f 2026-07-14)'
      }
    }
  };
  const expectedCanonical = JSON.stringify(identityWithoutDigest);
  const expectedDigest = createHash('sha256').update(expectedCanonical).digest('hex');
  const identity = buildToolchainIdentity({
    platform: 'win32', arch: 'x64', packageLockSha256, cargoLockSha256,
    versions: {
      node: identityWithoutDigest.tools.node.version,
      npm: identityWithoutDigest.tools.npm.version,
      python: identityWithoutDigest.tools.python.version,
      rustc: `${identityWithoutDigest.tools.rustc.version}\nbinary: rustc\ncommit-hash: ${identityWithoutDigest.tools.rustc.commit_hash}\ncommit-date: ${identityWithoutDigest.tools.rustc.commit_date}\nhost: ${identityWithoutDigest.tools.rustc.host}\nrelease: ${identityWithoutDigest.tools.rustc.release}\nLLVM version: 22.1.6`,
      cargo: `${identityWithoutDigest.tools.cargo.version}\nrelease: ${identityWithoutDigest.tools.cargo.release}\ncommit-hash: ${identityWithoutDigest.tools.cargo.commit_hash}\ncommit-date: ${identityWithoutDigest.tools.cargo.commit_date}\nhost: ${identityWithoutDigest.tools.cargo.host}\nlibgit2: 1.9.2`
    }
  });
  assert.deepEqual(identity, { ...identityWithoutDigest, canonical_sha256: expectedDigest });
  assert.deepEqual(validateToolchainIdentity(identity), identity);
  assert.doesNotMatch(JSON.stringify(identity), /[A-Za-z]:\\|\/Users\/|file:\/\//);
  assert.throws(() => validateToolchainIdentity({ ...identity, extra: true }), /schema/i);
  assert.throws(() => validateToolchainIdentity({ ...identity, tools: { ...identity.tools, node: { version: 'v24.8.0' } } }), /node/i);
  assert.throws(() => validateToolchainIdentity({ ...identity, tools: { ...identity.tools, npm: { version: '11.6.0' } } }), /npm/i);
  assert.throws(() => validateToolchainIdentity({ ...identity, tools: {
    ...identity.tools,
    rustc: {
      ...identity.tools.rustc,
      release: '1.91.0',
      version: 'rustc 1.91.0 (8bab26f4f 2026-07-14)'
    }
  } }), /rustc/i);
  assert.throws(() => validateToolchainIdentity({ ...identity, tools: { ...identity.tools, cargo: { ...identity.tools.cargo, release: '1.91.0' } } }), /cargo/i);
});

test('Windows report binds the validated toolchain identity and its file digest', async () => {
  const { buildWindowsContractReport } = await import('./windows-ci-report.mjs');
  const { buildToolchainIdentity } = await import('./windows-toolchain-identity.mjs');
  const toolchainIdentity = buildToolchainIdentity({
    platform: 'win32', arch: 'x64', packageLockSha256: '1'.repeat(64), cargoLockSha256: '2'.repeat(64),
    versions: {
      node: 'v24.18.0', npm: '12.0.1', python: 'Python 3.13.7',
      rustc: 'rustc 1.97.1 (8bab26f4f 2026-07-14)\nbinary: rustc\ncommit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452\ncommit-date: 2026-07-14\nhost: x86_64-pc-windows-msvc\nrelease: 1.97.1\nLLVM version: 22.1.6',
      cargo: 'cargo 1.97.1 (c980f4866 2026-06-30)\nrelease: 1.97.1\ncommit-hash: c980f4866141969fab6254a680546a277789d6f0\ncommit-date: 2026-06-30\nhost: x86_64-pc-windows-msvc\nlibgit2: 1.9.2'
    }
  });
  const reviewEvidenceBinding = {
    schema_id: 'superwagie.standard-review-evidence-binding.v2', schema_version: 2,
    result: { decision: 'CONDITIONAL_GO' },
    trusted_expected: {
      fixture_manifest_sha256: '9'.repeat(64),
      renderer_environment_sha256: 'a'.repeat(64),
      renderer_provenance_sha256: 'b'.repeat(64)
    },
    files: {
      result_sha256: '3'.repeat(64), metrics_sha256: '7'.repeat(64),
      completion_sha256: '5'.repeat(64), renderer_provenance_sha256: 'b'.repeat(64)
    },
    canonical_sha256: '8'.repeat(64)
  };
  const report = buildWindowsContractReport({
    reviewDecision: 'CONDITIONAL_GO', reviewResultsSha256: '3'.repeat(64),
    reviewMetricsSha256: '7'.repeat(64), reviewEvidenceBinding,
    reviewRendererProvenanceSha256: 'b'.repeat(64),
    fixtureManifestSha256: '9'.repeat(64), verifiedRendererEnvironmentSha256: 'a'.repeat(64),
    isolationDecision: 'GO', isolationResultsSha256: '4'.repeat(64), peakRssBytes: 1234,
    completionSha256: '5'.repeat(64), toolchainIdentity, toolchainIdentityFileSha256: '6'.repeat(64)
  });
  assert.equal(report.schema_version, 4);
  assert.deepEqual(report.toolchain_identity, toolchainIdentity);
  assert.equal(report.toolchain_identity_file_sha256, '6'.repeat(64));
  assert.equal(report.standard_review_executor.results_sha256, '3'.repeat(64));
  assert.equal(report.standard_review_executor.metrics_sha256, '7'.repeat(64));
  assert.equal(report.standard_review_executor.renderer_provenance_sha256, 'b'.repeat(64));
  assert.equal(report.standard_review_executor.fixture_manifest_sha256, '9'.repeat(64));
  assert.equal(report.standard_review_executor.verified_renderer_environment_sha256, 'a'.repeat(64));
  assert.deepEqual(report.standard_review_executor.evidence_binding, reviewEvidenceBinding);
  assert.equal(report.standard_isolation_executor.results_sha256, '4'.repeat(64));
  assert.equal(report.trusted_completion.completion_sha256, '5'.repeat(64));
});

test('historical Windows evidence libraries remain checked in but are not the current public workflow', async () => {
  for (const relative of [
    'scripts/poc/gate-3/windows-ci-fixture/setup-fake-wps.ps1',
    'scripts/poc/gate-3/windows-ci-fixture/write-contract-inputs.mjs',
    'scripts/poc/gate-3/windows-ci-fixture/skills/WPSComposer/__init__.py',
    'scripts/poc/gate-3/windows-ci-report.mjs',
    'scripts/poc/gate-3/windows-toolchain-identity.mjs'
  ]) await readFile(path.join(repo, relative));

  const workflowText = await readFile(workflowPath, 'utf8');
  assert.doesNotMatch(workflowText, /setup-fake-wps|windows-ci-report|windows-toolchain-identity|review-gate\.mjs|review-isolation-gate\.mjs/);
});
