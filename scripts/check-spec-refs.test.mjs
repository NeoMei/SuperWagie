import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const checkerSource = readFileSync(new URL('./check-spec-refs.mjs', import.meta.url), 'utf8');

function createFixture({
  alias = 'WD',
  documentSection = '1',
  lineEnding = '\n',
  referencedSection = '1',
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'superwagie-spec-refs-'));
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'rules'), { recursive: true });
  mkdirSync(path.join(root, 'docs', '技术可行性'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'specs'), { recursive: true });

  writeFileSync(path.join(root, 'scripts', 'check-spec-refs.mjs'), checkerSource);
  writeFileSync(
    path.join(root, 'rules', 'README.md'),
    ['# 规则包', `- ${alias} = docs/specs/workspace.md`, ''].join(lineEnding),
  );
  writeFileSync(
    path.join(root, 'rules', 'quality-scope.md'),
    ['# 验收规则', `- 保持跨平台一致。[${alias} §${referencedSection}] [TEST-01]`, ''].join(lineEnding),
  );
  writeFileSync(
    path.join(root, 'docs', 'specs', 'workspace.md'),
    ['# Workspace', `## ${documentSection}. 验收`, ''].join(lineEnding),
  );
  writeFileSync(
    path.join(root, 'docs', '技术可行性', '技术要求矩阵.md'),
    ['| ID | 要求 |', '|---|---|', '| TEST-01 | 跨平台 |', ''].join(lineEnding),
  );

  return root;
}

test('accepts CRLF-formatted alias tables on Windows checkouts', () => {
  const root = createFixture({ lineEnding: '\r\n' });
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-spec-refs.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /别名: 1 个/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validates anchors whose alias contains digits', () => {
  const root = createFixture({ alias: 'V1RS', documentSection: '1', referencedSection: '2' });
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-spec-refs.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /别名: 1 个/);
    assert.match(result.stderr, /\[V1RS §2\].*无对应章节标题/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
