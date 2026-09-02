import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const COLLECTOR = resolve('scripts/poc/gate-3/record-writer-evaluation.mjs');

test('collector accepts the receipt path option as evidence input', () => {
  const result = spawnSync(process.execPath, [COLLECTOR, '--human-receipt', '/tmp/receipt.json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing argument: outputDir/);
  assert.doesNotMatch(result.stderr, /invalid argument: --human-receipt/);
});

test('collector requires a generation receipt instead of trusting a CLI WPS version', () => {
  const generation = spawnSync(process.execPath, [COLLECTOR, '--generation-receipt', '/tmp/generation.json'], { encoding: 'utf8' });
  assert.equal(generation.status, 1);
  assert.match(generation.stderr, /missing argument: outputDir/);
  assert.doesNotMatch(generation.stderr, /invalid argument: --generation-receipt/);

  const claimedVersion = spawnSync(process.execPath, [COLLECTOR, '--wps-version', '12.1.0'], { encoding: 'utf8' });
  assert.equal(claimedVersion.status, 1);
  assert.match(claimedVersion.stderr, /invalid argument: --wps-version/);
});

test('collector rejects command-line manual fact and owner signature switches', () => {
  for (const option of ['--seven-stage-receipts-complete', '--three-human-gates-complete', '--human-visual-review-approved', '--wps-discard-close-reopen-confirmed', '--owner-signed']) {
    const result = spawnSync(process.execPath, [COLLECTOR, option, 'true'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`invalid argument: ${option}`));
  }
});
