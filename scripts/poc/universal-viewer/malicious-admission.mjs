export function evaluateMaliciousAggregate({
  behaviorPass,
  forbiddenRuntimeEdgeThreshold,
  admissionEvidence,
  builtSourcePolicyEvidence
} = {}) {
  if (
    !admissionEvidence
    || Array.isArray(admissionEvidence)
    || admissionEvidence.schema_id !== 'superwagie.viewer-candidate-admission-decision.v1'
    || !['GO', 'NO_GO'].includes(admissionEvidence.decision)
  ) {
    throw new Error('Frozen Core admission evidence is structurally invalid');
  }
  for (const [value, label] of [
    [forbiddenRuntimeEdgeThreshold, 'acceptance threshold'],
    [admissionEvidence.forbidden_runtime_edges, 'admission evidence'],
    [builtSourcePolicyEvidence?.forbidden_runtime_edges, 'built source policy evidence']
  ]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${label} forbidden runtime edge count must be a non-negative integer`);
    }
  }
  if (admissionEvidence.forbidden_runtime_edges !== builtSourcePolicyEvidence.forbidden_runtime_edges) {
    throw new Error('Frozen Core admission and built source policy edge counts differ');
  }
  if (
    admissionEvidence.decision === 'GO'
    && admissionEvidence.forbidden_runtime_edges !== forbiddenRuntimeEdgeThreshold
  ) {
    throw new Error('Frozen Core GO admission is incoherent with the declared edge threshold');
  }

  const admissionPass = admissionEvidence.decision === 'GO'
    && admissionEvidence.forbidden_runtime_edges === forbiddenRuntimeEdgeThreshold;
  const aggregatePass = behaviorPass === true && admissionPass;
  return {
    admissionPass,
    aggregatePass,
    decision: aggregatePass ? 'GO' : 'NO_GO',
    status: aggregatePass ? 'passed' : 'failed',
    reasons: [
      ...(behaviorPass === true ? [] : ['MALICIOUS_CORPUS_BEHAVIOR_FAILED']),
      ...(admissionPass ? [] : ['FROZEN_CORE_ADMISSION_NOT_GO'])
    ]
  };
}
