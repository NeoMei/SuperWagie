#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
export const REQUIRED_HISTORICAL_PATHS = Object.freeze([
  'docs/superpowers/plans/2026-08-30-independent-office-reviewer-poc.md',
  'docs/技术可行性/编码前技术验证收口报告-2026-09-01.md',
  'fixtures/gate-3/G3-REVIEW-001/README.md',
  'fixtures/gate-3/G3-REVIEW-002/README.md'
]);

export function auditViewerHistoryFiles(files) {
  const errors = [];
  for (const filePath of REQUIRED_HISTORICAL_PATHS) {
    const text = files.get(filePath);
    if (typeof text !== 'string') errors.push(`HISTORICAL_FILE_MISSING ${filePath}`);
    else if (!text.includes('superseded-for-current-architecture')) errors.push(`HISTORICAL_MARKER_MISSING ${filePath}`);
  }
  return { errors };
}

export function auditViewerHistory(root = repoRoot) {
  const files = new Map(REQUIRED_HISTORICAL_PATHS.map(filePath => {
    const absolute = path.join(root, filePath);
    return [filePath, fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : undefined];
  }));
  return auditViewerHistoryFiles(files);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditViewerHistory();
  if (result.errors.length) {
    result.errors.forEach(error => console.error(`FAIL ${error}`));
    process.exit(1);
  }
  console.log(`PASS viewer history markers=${REQUIRED_HISTORICAL_PATHS.length}`);
}
