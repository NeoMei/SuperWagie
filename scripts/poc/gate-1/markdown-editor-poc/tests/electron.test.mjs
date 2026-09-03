import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const pocRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(pocRoot, '../../../..');
const fixtureRoot = resolve(repoRoot, 'fixtures/gate-1/G1-MARKDOWN-001/fixtures');
const electron = join(pocRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

test('real Electron surface edits and reads Markdown in all three modes', { timeout: 120_000 }, async () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'superwagie-markdown-ui-'));
  const vault = join(runRoot, 'vault');
  await mkdir(join(vault, '.obsidian'), { recursive: true });
  await cp(fixtureRoot, vault, { recursive: true });
  await writeFile(join(vault, '核心内容.md'), '# 核心内容\n\n## 小节\n\n嵌入正文。\n\n块目标。 ^block-anchor\n');

  const resultPath = join(runRoot, 'result.json');
  const screenshotRoot = join(runRoot, 'screenshots');
  const run = spawnSync(electron, [join(pocRoot, 'src/main.mjs'), '--self-test', '--vault', vault,
    '--obsidian-vault-root', vault, '--file', 'torture.md', '--output', resultPath, '--screenshots', screenshotRoot], {
    cwd: pocRoot,
    encoding: 'utf8',
    timeout: 110_000,
    env: { ...process.env, SUPERWAGIE_MARKDOWN_POC: '1' },
  });

  assert.equal(run.status, 0, `Electron test must exit 0\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.runtime.electron, '44.1.0');
  assert.equal(result.runtime.sandbox, true);
  assert.equal(result.runtime.realObsidianVault, true);
  assert.equal(result.ui.codeMirror6, true);
  assert.deepEqual(result.ui.modes, ['live', 'reading', 'source']);
  assert.equal(result.ui.readingVisible, true);
  assert.equal(result.ui.livePreviewPresentation, true);
  assert.equal(result.ui.chineseComposition, true);
  assert.equal(result.ui.imageLoaded, true);
  assert.equal(result.ui.documentEmbed, true);
  assert.equal(result.ui.excalidrawEmbed, true);
  assert.equal(result.ui.wikilinkNavigation, true);
  assert.equal(result.persistence.savedAndReopened, true);
  assert.equal(result.persistence.unknownSyntaxPreserved, true);
  assert.equal(result.persistence.externalEditDetected, true);
  assert.equal(result.persistence.staleSaveRejected, true);
  assert.equal(result.persistence.atomicWrite, true);
  assert.equal(result.console.errors.length, 0);
  assert.equal(result.console.warnings.length, 0);
  for (const mode of ['live', 'reading', 'source']) {
    assert.ok(existsSync(join(screenshotRoot, `${mode}.png`)), `${mode} screenshot missing`);
  }
});
