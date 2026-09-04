import assert from 'node:assert/strict';
import test from 'node:test';

async function loadEvaluator() {
  try {
    return (await import('../malicious-admission.mjs')).evaluateMaliciousAggregate;
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

const COMMIT = 'f'.repeat(40);

function builtPolicy(edges = 0) {
  return {
    schema_id: 'superwagie.viewer-source-policy-audit.v1',
    decision: edges === 0 ? 'GO' : 'NO_GO',
    audited_sources: ['src/registry/container.ts'],
    forbidden_runtime_edges: edges,
    violations: Array.from({ length: edges }, (_, index) => ({ rule: 'forbidden_runtime', evidence: `edge-${index}` })),
    exceptions_used: []
  };
}

function admission(overrides = {}) {
  return {
    schema_id: 'superwagie.viewer-candidate-admission-decision.v1',
    decision: 'GO',
    candidate_commit: COMMIT,
    patches: 0,
    forbidden_runtime_edges: 0,
    moderate_or_higher: 0,
    office_smoke_non_placeholder: true,
    chunks: 'GO',
    ...overrides
  };
}

test('synthetic admission fixtures propagate GO zero-edge and NO_GO nonzero-edge outcomes', async () => {
  const evaluate = await loadEvaluator();
  const common = {
    behaviorPass: true,
    forbiddenRuntimeEdgeThreshold: 0,
    builtSourcePolicyEvidence: builtPolicy()
  };
  const accepted = evaluate?.({
    ...common,
    admissionEvidence: admission()
  });
  assert.deepEqual(accepted, {
    admissionPass: true,
    aggregatePass: true,
    decision: 'GO',
    status: 'passed',
    reasons: []
  });

  const rejected = evaluate?.({
    ...common,
    builtSourcePolicyEvidence: builtPolicy(2),
    admissionEvidence: admission({ decision: 'NO_GO', forbidden_runtime_edges: 2 })
  });
  assert.deepEqual(rejected, {
    admissionPass: false,
    aggregatePass: false,
    decision: 'NO_GO',
    status: 'failed',
    reasons: ['FROZEN_CORE_ADMISSION_NOT_GO']
  });
});

test('synthetic admission fixtures reject malformed, invalid, mismatched, and incoherent edge evidence', async () => {
  const evaluate = await loadEvaluator();
  const valid = {
    behaviorPass: true,
    forbiddenRuntimeEdgeThreshold: 0,
    builtSourcePolicyEvidence: builtPolicy(),
    admissionEvidence: admission()
  };
  for (const [label, mutate, expected] of [
    ['malformed admission', (input) => { input.admissionEvidence = null; }, /structurally invalid/],
    ['negative admission edges', (input) => { input.admissionEvidence.forbidden_runtime_edges = -1; }, /non-negative integer/],
    ['fractional policy edges', (input) => { input.builtSourcePolicyEvidence.forbidden_runtime_edges = 0.5; }, /non-negative integer/],
    ['mismatched evidence', (input) => { input.builtSourcePolicyEvidence.forbidden_runtime_edges = 1; }, /edge counts differ/],
    ['incoherent GO', (input) => {
      input.admissionEvidence.forbidden_runtime_edges = 1;
      input.builtSourcePolicyEvidence.forbidden_runtime_edges = 1;
      input.builtSourcePolicyEvidence.decision = 'NO_GO';
      input.builtSourcePolicyEvidence.violations = [{ rule: 'forbidden_runtime' }];
    }, /incoherent/],
    ['wrong policy schema', (input) => { input.builtSourcePolicyEvidence.schema_id = 'wrong'; }, /structurally invalid/],
    ['contradictory policy decision', (input) => { input.builtSourcePolicyEvidence.decision = 'NO_GO'; }, /decision is incoherent/],
    ['GO with a vulnerability', (input) => { input.admissionEvidence.moderate_or_higher = 1; }, /GO admission is incoherent/],
    ['GO with a patch', (input) => { input.admissionEvidence.patches = 1; }, /GO admission is incoherent/],
    ['GO with failed Office smoke', (input) => { input.admissionEvidence.office_smoke_non_placeholder = false; }, /GO admission is incoherent/],
    ['GO with rejected chunks', (input) => { input.admissionEvidence.chunks = 'NO_GO'; }, /GO admission is incoherent/]
  ]) {
    const input = structuredClone(valid);
    mutate(input);
    assert.throws(() => evaluate?.(input), expected, label);
  }
});

test('synthetic behavior failure cannot be admitted even with coherent GO evidence', async () => {
  const evaluate = await loadEvaluator();
  assert.deepEqual(evaluate?.({
    behaviorPass: false,
    forbiddenRuntimeEdgeThreshold: 0,
    admissionEvidence: admission(),
    builtSourcePolicyEvidence: builtPolicy()
  }), {
    admissionPass: true,
    aggregatePass: false,
    decision: 'NO_GO',
    status: 'failed',
    reasons: ['MALICIOUS_CORPUS_BEHAVIOR_FAILED']
  });
});
