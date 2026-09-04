function hasExactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function evaluateMaliciousAggregate({
  behaviorPass,
  forbiddenRuntimeEdgeThreshold,
  admissionEvidence,
  builtSourcePolicyEvidence
} = {}) {
  const admissionKeys = [
    'schema_id',
    'decision',
    'candidate_commit',
    'patches',
    'forbidden_runtime_edges',
    'moderate_or_higher',
    'office_smoke_non_placeholder',
    'chunks'
  ];
  if (
    !hasExactKeys(admissionEvidence, admissionKeys)
    || admissionEvidence.schema_id !== 'superwagie.viewer-candidate-admission-decision.v1'
    || !['GO', 'NO_GO'].includes(admissionEvidence.decision)
    || !/^[0-9a-f]{40}$/u.test(admissionEvidence.candidate_commit)
    || !Number.isInteger(admissionEvidence.patches)
    || admissionEvidence.patches < 0
    || !Number.isInteger(admissionEvidence.moderate_or_higher)
    || admissionEvidence.moderate_or_higher < 0
    || typeof admissionEvidence.office_smoke_non_placeholder !== 'boolean'
    || !['GO', 'NO_GO'].includes(admissionEvidence.chunks)
  ) {
    throw new Error('Frozen Core admission evidence is structurally invalid');
  }
  const builtPolicyKeys = [
    'schema_id',
    'decision',
    'audited_sources',
    'forbidden_runtime_edges',
    'violations',
    'exceptions_used'
  ];
  if (
    !hasExactKeys(builtSourcePolicyEvidence, builtPolicyKeys)
    || builtSourcePolicyEvidence.schema_id !== 'superwagie.viewer-source-policy-audit.v1'
    || !['GO', 'NO_GO'].includes(builtSourcePolicyEvidence.decision)
    || !Array.isArray(builtSourcePolicyEvidence.audited_sources)
    || builtSourcePolicyEvidence.audited_sources.some((source) => typeof source !== 'string')
    || !Array.isArray(builtSourcePolicyEvidence.violations)
    || !Array.isArray(builtSourcePolicyEvidence.exceptions_used)
  ) {
    throw new Error('Frozen Core built source policy evidence is structurally invalid');
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
  const builtPolicyDecision = builtSourcePolicyEvidence.forbidden_runtime_edges === 0
    && builtSourcePolicyEvidence.violations.length === 0
    ? 'GO'
    : 'NO_GO';
  if (
    builtSourcePolicyEvidence.forbidden_runtime_edges !== builtSourcePolicyEvidence.violations.length
    || builtSourcePolicyEvidence.decision !== builtPolicyDecision
  ) {
    throw new Error('Frozen Core built source policy decision is incoherent');
  }
  if (
    admissionEvidence.decision === 'GO'
    && (
      admissionEvidence.patches !== 0
      || admissionEvidence.forbidden_runtime_edges !== forbiddenRuntimeEdgeThreshold
      || admissionEvidence.moderate_or_higher !== 0
      || admissionEvidence.office_smoke_non_placeholder !== true
      || admissionEvidence.chunks !== 'GO'
      || builtSourcePolicyEvidence.decision !== 'GO'
    )
  ) {
    throw new Error('Frozen Core GO admission is incoherent with its admission evidence');
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
