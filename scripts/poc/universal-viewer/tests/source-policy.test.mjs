import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { auditSourcePolicy } from '../source-policy-audit.mjs';

function fixture(t, files, entries = ['src/entry.ts']) {
  const root = mkdtempSync(path.join(tmpdir(), 'viewer-source-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return { root, entries };
}

test('rejects forbidden host, process, and shell-wrapper imports in admitted modules', (t) => {
  for (const [specifier, statement] of [
    ['obsidian', "import value from 'obsidian'; export { value };"],
    ['electron', "import value from 'electron'; export { value };"],
    ['node:child_process', "import value from 'node:child_process'; export { value };"],
    ['cross-spawn', "import value from 'cross-spawn'; export { value };"],
    ['electron', "export const load = () => import('electron' as string);"],
  ]) {
    const candidate = fixture(t, { 'src/entry.ts': `${statement}\n` });
    const result = auditSourcePolicy({ candidateRoot: candidate.root, selectedSources: candidate.entries });
    assert.equal(result.decision, 'NO_GO');
    assert.ok(result.violations.some((item) => item.rule === 'forbidden_import' && item.evidence === specifier));
  }
});

test('rejects forbidden host/write/network/process identifiers and endpoints', (t) => {
  const mutations = [
    'const launch = "soffice";',
    'const launch = "libreoffice";',
    'const launch = "Microsoft Office";',
    'const launch = "WPS";',
    'shell.openExternal("https://example.invalid");',
    'saveFile("x", bytes);',
    'writeback(bytes);',
    'pickFile();',
    'const endpoint = "https://example.invalid/upload";',
    'fetch("/share");',
    'new XMLHttpRequest();',
    'new WebSocket("wss://example.invalid");',
  ];
  for (const mutation of mutations) {
    const candidate = fixture(t, { 'src/entry.ts': `${mutation}\nexport {};\n` });
    const result = auditSourcePolicy({ candidateRoot: candidate.root, selectedSources: candidate.entries });
    assert.equal(result.decision, 'NO_GO', mutation);
    assert.ok(result.violations.length > 0, mutation);
  }
});

test('does not admit forbidden code merely because it exists outside the selected source slice', (t) => {
  const candidate = fixture(t, {
    'src/entry.ts': 'export const safe = 1;\n',
    'src/obsidian-adapter.ts': 'import { shell } from "electron"; fetch("https://example.invalid/upload");\n',
  });
  const result = auditSourcePolicy({ candidateRoot: candidate.root, selectedSources: candidate.entries });
  assert.equal(result.decision, 'GO');
  assert.deepEqual(result.audited_sources, ['src/entry.ts']);
});

test('permits only an exact audited non-network URI literal exception', (t) => {
  const candidate = fixture(t, {
    'src/entry.ts': 'export const ns = "http://www.w3.org/2000/svg";\n',
  });
  const result = auditSourcePolicy({
    candidateRoot: candidate.root,
    selectedSources: candidate.entries,
    policy: {
      forbidden_import_fragments: ['obsidian', 'electron', 'child_process'],
      shell_wrapper_import_pattern: '(?:^|[/_-])(?:shell|execa|cross-spawn)(?:$|[/_-])',
      forbidden_runtime_patterns: ['\\bfetch\\b'],
      forbidden_url_pattern: 'https?://',
      audited_literal_exceptions: [{
        source: 'src/entry.ts',
        literal: 'http://www.w3.org/2000/svg',
        reason: 'DOM namespace identifier passed only to createElementNS',
      }],
    },
  });
  assert.equal(result.decision, 'GO');
  assert.equal(result.exceptions_used.length, 1);
});

test('permits an exact audited non-call fetch word inside a dependency-error string only', (t) => {
  const safe = fixture(t, { 'src/entry.ts': 'const message = "failed to fetch dynamically imported module";\n' });
  const policy = {
    forbidden_import_fragments: [],
    shell_wrapper_import_pattern: 'a^',
    forbidden_runtime_patterns: ['\\bfetch\\b'],
    audited_literal_exceptions: [],
    audited_runtime_exceptions: [{
      source: 'src/entry.ts',
      evidence: 'fetch',
      containing_literal: 'failed to fetch dynamically imported module',
      reason: 'classification text only; no call expression exists',
    }],
  };
  assert.equal(auditSourcePolicy({ candidateRoot: safe.root, selectedSources: safe.entries, policy }).decision, 'GO');

  const unsafe = fixture(t, { 'src/entry.ts': 'fetch("/upload");\n' });
  assert.equal(auditSourcePolicy({ candidateRoot: unsafe.root, selectedSources: unsafe.entries, policy }).decision, 'NO_GO');
});

test('permits an exact audited non-call fetch word inside a dependency-error regex only', (t) => {
  const candidate = fixture(t, { 'src/entry.ts': 'const dependencyError = /failed to fetch dynamically imported module/i.test(message);\n' });
  const result = auditSourcePolicy({
    candidateRoot: candidate.root,
    selectedSources: candidate.entries,
    policy: {
      forbidden_import_fragments: [],
      shell_wrapper_import_pattern: 'a^',
      forbidden_runtime_patterns: ['\\bfetch\\b'],
      audited_literal_exceptions: [],
      audited_runtime_exceptions: [{
        source: 'src/entry.ts',
        evidence: 'fetch',
        containing_regex: 'failed to fetch dynamically imported module',
        reason: 'classification regex only; no call expression exists',
      }],
    },
  });
  assert.equal(result.decision, 'GO');
});
