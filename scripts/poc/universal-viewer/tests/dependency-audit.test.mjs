import assert from 'node:assert/strict';
import test from 'node:test';

import { auditDependencyData } from '../dependency-audit.mjs';

const policy = {
  allowed_licenses: ['MIT', 'Apache-2.0'],
  blocked_license_families: ['GPL', 'AGPL', 'UNKNOWN'],
  license_decisions: [],
  vulnerability_exceptions: [],
};

function lockEntry(overrides = {}) {
  return {
    name: 'fixture',
    version: '1.2.3',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0', license: 'MIT', dependencies: { dep: '1.2.3' } },
      'node_modules/dep': {
        version: '1.2.3',
        resolved: 'https://registry.npmjs.org/dep/-/dep-1.2.3.tgz',
        integrity: 'sha512-fixture',
        license: 'MIT',
        ...overrides,
      },
    },
  };
}

const cleanAudit = {
  auditReportVersion: 2,
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
  vulnerabilities: {},
};

test('rejects dependency ranges in resolved lock identities', () => {
  const result = auditDependencyData({ lock: lockEntry({ version: '^1.2.3' }), audit: cleanAudit, policy });
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.violations.some((item) => item.rule === 'non_exact_identity'));
});

test('requires an explicit blocked decision for GPL, AGPL, and unknown licenses', () => {
  for (const license of ['GPL-3.0-only', 'AGPL-3.0-only', undefined]) {
    const result = auditDependencyData({ lock: lockEntry({ license }), audit: cleanAudit, policy });
    assert.equal(result.decision, 'NO_GO', String(license));
    assert.ok(result.violations.some((item) => item.rule === 'license_not_admitted'));
  }
});

test('rejects moderate, high, and critical production vulnerabilities without an unexpired exception', () => {
  for (const severity of ['moderate', 'high', 'critical']) {
    const audit = structuredClone(cleanAudit);
    audit.metadata.vulnerabilities[severity] = 1;
    audit.metadata.vulnerabilities.total = 1;
    audit.vulnerabilities.dep = { name: 'dep', severity, isDirect: true, via: [], effects: [], range: '1.2.3', nodes: ['node_modules/dep'], fixAvailable: false };
    const result = auditDependencyData({ lock: lockEntry(), audit, policy, now: '2026-09-04T00:00:00.000Z' });
    assert.equal(result.decision, 'NO_GO', severity);
    assert.equal(result.moderate_or_higher, 1);
  }
});

test('accepts exact identities, admitted licenses, and a zero-vulnerability audit', () => {
  const result = auditDependencyData({ lock: lockEntry(), audit: cleanAudit, policy });
  assert.equal(result.decision, 'GO');
  assert.equal(result.moderate_or_higher, 0);
  assert.equal(result.dependencies.length, 1);
});
