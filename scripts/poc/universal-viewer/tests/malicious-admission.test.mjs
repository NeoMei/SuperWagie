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

test('synthetic admission fixtures propagate GO zero-edge and NO_GO nonzero-edge outcomes', async () => {
  const evaluate = await loadEvaluator();
  const common = {
    behaviorPass: true,
    forbiddenRuntimeEdgeThreshold: 0,
    builtSourcePolicyEvidence: { forbidden_runtime_edges: 0 }
  };
  const accepted = evaluate?.({
    ...common,
    admissionEvidence: {
      schema_id: 'superwagie.viewer-candidate-admission-decision.v1',
      decision: 'GO',
      forbidden_runtime_edges: 0
    }
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
    builtSourcePolicyEvidence: { forbidden_runtime_edges: 2 },
    admissionEvidence: {
      schema_id: 'superwagie.viewer-candidate-admission-decision.v1',
      decision: 'NO_GO',
      forbidden_runtime_edges: 2
    }
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
    builtSourcePolicyEvidence: { forbidden_runtime_edges: 0 },
    admissionEvidence: {
      schema_id: 'superwagie.viewer-candidate-admission-decision.v1',
      decision: 'GO',
      forbidden_runtime_edges: 0
    }
  };
  for (const [label, mutate, expected] of [
    ['malformed admission', (input) => { input.admissionEvidence = null; }, /structurally invalid/],
    ['negative admission edges', (input) => { input.admissionEvidence.forbidden_runtime_edges = -1; }, /non-negative integer/],
    ['fractional policy edges', (input) => { input.builtSourcePolicyEvidence.forbidden_runtime_edges = 0.5; }, /non-negative integer/],
    ['mismatched evidence', (input) => { input.builtSourcePolicyEvidence.forbidden_runtime_edges = 1; }, /edge counts differ/],
    ['incoherent GO', (input) => {
      input.admissionEvidence.forbidden_runtime_edges = 1;
      input.builtSourcePolicyEvidence.forbidden_runtime_edges = 1;
    }, /incoherent/]
  ]) {
    const input = structuredClone(valid);
    mutate(input);
    assert.throws(() => evaluate?.(input), expected, label);
  }
});
