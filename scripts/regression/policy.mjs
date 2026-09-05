export function validateProof(proof, requirement, runId) {
  if (proof?.scope !== requirement.scope || proof.regression_run_id !== runId
    || proof.admission_effect !== 'none') throw new Error('Missing, stale, or wrong-scope regression proof');
  if (!proof.checks || !requirement.checks.length) throw new Error('Empty regression checklist');
  for (const check of requirement.checks) {
    if (proof.checks[check] !== true) throw new Error(`Required check did not pass: ${check}`);
  }
  for (const [check, passed] of Object.entries(proof.checks)) {
    if (passed !== true) throw new Error(`Reported check did not pass: ${check}`);
  }
}

export function validateTestOutput(output, format, minimum) {
  if (format === 'tap') {
    const number = (key) => {
      const values = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
      if (values.length !== 1) throw new Error(`Missing or ambiguous TAP ${key}`);
      return Number(values[0][1]);
    };
    if (number('tests') < minimum || number('pass') !== number('tests')
      || ['fail', 'skipped', 'todo', 'cancelled'].some((key) => number(key) !== 0)) {
      throw new Error('Incomplete, failed, or skipped test suite');
    }
  } else if (format === 'rust') {
    const results = [...output.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/g)];
    if (!results.length || results.some((r) => r[1] !== 'ok' || r.slice(3).some((v) => Number(v) !== 0))
      || results.reduce((count, r) => count + Number(r[2]), 0) < minimum) {
      throw new Error('Incomplete, failed, ignored, or filtered Rust suite');
    }
  } else throw new Error(`Unknown test output format: ${format}`);
}

export function validateRegistry(registry) {
  if (registry?.schema_version !== 1 || !Array.isArray(registry.features) || !registry.features.length
    || !Array.isArray(registry.protected_paths) || !registry.protected_paths.length) throw new Error('Invalid acceptance registry');
  const ids = new Set();
  for (const feature of registry.features) {
    if (!feature.id || ids.has(feature.id) || !['lifecycle', 'live-preview', 'format-toolbar'].includes(feature.suite)
      || !Array.isArray(feature.checks) || !feature.checks.length || feature.checks.some((key) => typeof key !== 'string' || !key)
      || new Set(feature.checks).size !== feature.checks.length) throw new Error('Invalid or duplicate accepted feature/check');
    ids.add(feature.id);
  }
}

export function validateBaseline(base, current) {
  for (const before of base.features) {
    const after = current.features.find((feature) => feature.id === before.id);
    if (!after || after.suite !== before.suite || before.checks.some((check) => !after.checks.includes(check))) {
      throw new Error(`Accepted regression coverage was removed or weakened: ${before.id}`);
    }
  }
  for (const path of base.protected_paths ?? []) {
    if (!current.protected_paths?.includes(path)) throw new Error(`Protected path removed: ${path}`);
  }
}
