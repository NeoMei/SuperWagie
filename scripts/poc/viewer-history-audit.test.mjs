import test from 'node:test';
import assert from 'node:assert/strict';
import { auditViewerHistoryFiles, REQUIRED_HISTORICAL_PATHS } from './viewer-history-audit.mjs';

const marker = '> **superseded-for-current-architecture (2026-09-04):** This file preserves evidence for the retired WPS-authoritative Office Review path.';

test('requires the exact superseded marker in every historical Viewer document', () => {
  const files = new Map(REQUIRED_HISTORICAL_PATHS.map(path => [path, `${marker}\nold result remains` ]));
  files.set(REQUIRED_HISTORICAL_PATHS[0], 'old result remains');
  const result = auditViewerHistoryFiles(files);
  assert.match(result.errors.join('\n'), /HISTORICAL_MARKER_MISSING/);
});

test('accepts all two historical documents and two G3 Review READMEs when marked', () => {
  assert.equal(REQUIRED_HISTORICAL_PATHS.length, 4);
  const files = new Map(REQUIRED_HISTORICAL_PATHS.map(path => [path, `${marker}\nold result remains` ]));
  assert.deepEqual(auditViewerHistoryFiles(files).errors, []);
});

test('does not accept a misspelled compatibility marker', () => {
  const files = new Map(REQUIRED_HISTORICAL_PATHS.map(path => [path, `${marker}\nold result remains` ]));
  files.set(REQUIRED_HISTORICAL_PATHS[1], '> superseded_for_current_architecture\nold result remains');
  const result = auditViewerHistoryFiles(files);
  assert.match(result.errors.join('\n'), /HISTORICAL_MARKER_MISSING/);
});
