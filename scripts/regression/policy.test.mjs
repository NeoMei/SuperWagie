import assert from 'node:assert/strict';
import test from 'node:test';

import * as policy from './policy.mjs';
const requirements = { scope: 'editor', checks: ['cursor', 'save'] };
const proof = () => ({ scope: 'editor', regression_run_id: 'current', checks: { cursor: true, save: true }, admission_effect: 'none' });

test('toolbar behavior can join the registry without weakening existing requirements', () => {
  const base = { schema_version: 1, protected_paths: ['tests/'], features: [{ id: 'live', suite: 'live-preview', checks: ['cursor'] }] };
  const current = { ...base, features: [...base.features, { id: 'toolbar', suite: 'format-toolbar', checks: ['selection'] }] };
  assert.doesNotThrow(() => policy.validateRegistry(current));
  assert.doesNotThrow(() => policy.validateBaseline(base, current));
});

test('accepts only a complete proof from this run', () => {
  assert.equal(typeof policy.validateProof, 'function', 'Regression proof validation must exist');
  assert.doesNotThrow(() => policy.validateProof(proof(), requirements, 'current'));
});
for (const [name, change] of [
  ['missing required check', (p) => { delete p.checks.cursor; }],
  ['failed required check', (p) => { p.checks.cursor = false; }],
  ['truthy string instead of a pass', (p) => { p.checks.cursor = 'true'; }],
  ['failure outside the minimum check list', (p) => { p.checks.new_check = false; }],
  ['stale run receipt', (p) => { p.regression_run_id = 'old'; }],
  ['wrong suite scope', (p) => { p.scope = 'different'; }],
]) {
  test(`rejects ${name}`, () => {
    assert.equal(typeof policy.validateProof, 'function');
    const value = proof(); change(value);
    assert.throws(() => policy.validateProof(value, requirements, 'current'));
  });
}
test('test summaries cannot pass through missing tests or skipped tests', () => {
  assert.equal(typeof policy.validateTestOutput, 'function');
  const tap = '# tests 14\n# pass 14\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n';
  assert.doesNotThrow(() => policy.validateTestOutput(tap, 'tap', 14));
  assert.throws(() => policy.validateTestOutput('', 'tap', 14));
  assert.throws(() => policy.validateTestOutput(tap.replace('# skipped 0', '# skipped 1'), 'tap', 14));
  assert.throws(() => policy.validateTestOutput(tap.replace('# tests 14', '# tests 0'), 'tap', 14));
  const rust = 'test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1s';
  assert.doesNotThrow(() => policy.validateTestOutput(rust, 'rust', 40));
  assert.throws(() => policy.validateTestOutput(rust.replace('0 ignored', '1 ignored'), 'rust', 40));
});
test('a baseline comparison detects deleted features and weakened required checks', () => {
  assert.equal(typeof policy.validateBaseline, 'function');
  const base = { features: [{ id: 'live', suite: 'editor', checks: ['cursor', 'save'] }] };
  assert.doesNotThrow(() => policy.validateBaseline(base, base));
  assert.throws(() => policy.validateBaseline(base, { features: [] }));
  assert.throws(() => policy.validateBaseline(base, { features: [{ id: 'live', suite: 'editor', checks: ['save'] }] }));
  assert.throws(() => policy.validateBaseline(base, { features: [{ id: 'live', suite: 'other', checks: ['cursor', 'save'] }] }));
  assert.throws(() => policy.validateBaseline({ ...base, protected_paths: ['tests/'] }, { ...base, protected_paths: [] }));
});
