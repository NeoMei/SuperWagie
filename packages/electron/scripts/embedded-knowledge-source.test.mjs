import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyWindowsKnowledgePatch } from './embedded-knowledge-windows.mjs';
import { assertCleanKnowledgeSource, assertNoKnowledgeSymlinks, assertSafeKnowledgeStaging } from './embedded-knowledge-source.mjs';

const source = fileURLToPath(new URL('./test-fixtures/embedded-knowledge/', import.meta.url));
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-source-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(source, root, { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n');
  git(root, 'init', '--quiet'); git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  return root;
}
test('source verification accepts a clean checkout and rejects tracked or untracked changes without modifying them', (t) => {
  const root = fixture(t);
  assert.doesNotThrow(() => assertCleanKnowledgeSource(root, 'darwin'));
  const tracked = path.join(root, 'README.md'); fs.appendFileSync(tracked, '\nuser change\n');
  assert.throws(() => assertCleanKnowledgeSource(root, 'darwin'), /local changes/);
  assert.match(fs.readFileSync(tracked, 'utf8'), /user change/);
  git(root, 'checkout', '--', 'README.md');
  const unknown = path.join(root, 'unknown.go'); fs.writeFileSync(unknown, 'user source');
  assert.throws(() => assertCleanKnowledgeSource(root, 'darwin'), /local changes/);
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'user source');
});
test('source verification refuses ignored build and patched crate data without deleting it', (t) => {
  const root = fixture(t); fs.mkdirSync(path.join(root, 'build')); fs.writeFileSync(path.join(root, 'build', 'cached.a'), 'unknown');
  assert.throws(() => assertCleanKnowledgeSource(root, 'linux'), /local changes/);
  assert.equal(fs.readFileSync(path.join(root, 'build', 'cached.a'), 'utf8'), 'unknown');
});
test('source verification rejects index flags that hide tracked changes without changing the index', (t) => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const root = fixture(t); const tracked = path.join(root, 'README.md');
    git(root, 'update-index', flag, 'README.md');
    fs.appendFileSync(tracked, '\nhidden change\n');
    assert.throws(() => assertCleanKnowledgeSource(root, 'darwin'), /index|flag/i);
    assert.match(fs.readFileSync(tracked, 'utf8'), /hidden change/);
    const index = execFileSync('git', ['ls-files', '-v', '--', 'README.md'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(index[0], 'H');
  }
});
test('source verification refuses linked Git metadata and worktree pointers without changing them', (t) => {
  const root = fixture(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-git-link-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const linked = path.join(other, 'linked');
  fs.cpSync(source, linked, { recursive: true });
  fs.writeFileSync(path.join(linked, '.gitignore'), 'build/\n');
  fs.symlinkSync(path.join(root, '.git'), path.join(linked, '.git'), 'dir');
  const worktree = path.join(other, 'worktree');
  git(root, 'worktree', 'add', '--quiet', '--detach', worktree);
  const pointer = fs.readFileSync(path.join(worktree, '.git'), 'utf8');
  assert.throws(() => assertCleanKnowledgeSource(linked, 'darwin'), /git.*directory/i);
  assert.throws(() => assertCleanKnowledgeSource(worktree, 'darwin'), /git.*directory/i);
  assert.ok(fs.lstatSync(path.join(linked, '.git')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(worktree, '.git'), 'utf8'), pointer);
  assert.ok(fs.existsSync(path.join(root, '.git', 'config')));
});
test('source verification refuses Git metadata redirected to external worktree or common directory', (t) => {
  for (const redirect of ['worktree', 'commondir']) {
    const root = fixture(t); const outside = fixture(t);
    const config = path.join(root, '.git', 'config');
    const outsideConfig = fs.readFileSync(path.join(outside, '.git', 'config'));
    if (redirect === 'worktree') {
      git(root, 'config', 'core.worktree', outside);
      fs.appendFileSync(path.join(root, 'README.md'), '\nhidden local edit\n');
    }
    else fs.writeFileSync(path.join(root, '.git', 'commondir'), path.join(outside, '.git') + '\n');
    const localConfig = fs.readFileSync(config);
    assert.throws(() => assertCleanKnowledgeSource(root, 'darwin'), /git metadata/i);
    assert.deepEqual(fs.readFileSync(config), localConfig);
    assert.deepEqual(fs.readFileSync(path.join(outside, '.git', 'config')), outsideConfig);
  }
});
test('source verification does not trust inherited Git redirection environment', (t) => {
  const root = fixture(t); const outside = fixture(t);
  fs.appendFileSync(path.join(root, 'README.md'), '\nlocal edit\n');
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.GIT_DIR = path.join(outside, '.git');
  process.env.GIT_WORK_TREE = outside;
  process.env.GIT_COMMON_DIR = path.join(outside, '.git');
  process.env.GIT_INDEX_FILE = path.join(outside, '.git', 'index');
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'core.worktree';
  process.env.GIT_CONFIG_VALUE_0 = outside;
  assert.throws(() => assertCleanKnowledgeSource(root, 'darwin'), /local changes/);
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /local edit/);
});
test('source verification detects files from a Git replacement object', (t) => {
  const root = fixture(t);
  const original = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const readme = path.join(root, 'README.md');
  fs.writeFileSync(readme, 'replacement contents\n');
  git(root, 'add', 'README.md');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'replacement');
  const replacement = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  git(root, 'replace', original, replacement);
  git(root, 'checkout', '--quiet', '--detach', original);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), original);
  assert.equal(fs.readFileSync(readme, 'utf8'), 'replacement contents\n');
  assert.throws(() => assertCleanKnowledgeSource(root, 'darwin'), /local changes/);
  assert.equal(fs.readFileSync(readme, 'utf8'), 'replacement contents\n');
});
test('only the exact verified Windows patch may remain in a clean source checkout', (t) => {
  const root = fixture(t); const commit = 'a4fa836171c3baee081c13ee23ec6b13f527097f';
  applyWindowsKnowledgePatch(root, commit, 'win32');
  assert.doesNotThrow(() => assertCleanKnowledgeSource(root, 'win32'));
  fs.appendFileSync(path.join(root, 'third_party/anydoc-go/anydoc.go'), '\n// user edit\n');
  assert.throws(() => assertCleanKnowledgeSource(root, 'win32'), /local changes/);
  assert.match(fs.readFileSync(path.join(root, 'third_party/anydoc-go/anydoc.go'), 'utf8'), /user edit/);
});

test('preserves existing staging rather than deleting a mismatched or damaged worker', (t) => {
  const root = fixture(t); const staging = path.join(root, 'stage');
  assert.doesNotThrow(() => assertSafeKnowledgeStaging(staging));
  fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, '.gitkeep'), '');
  assert.doesNotThrow(() => assertSafeKnowledgeStaging(staging));
  fs.writeFileSync(path.join(staging, 'embedded-knowledge-server'), 'old worker');
  assert.throws(() => assertSafeKnowledgeStaging(staging), /preserve/i);
  assert.equal(fs.readFileSync(path.join(staging, 'embedded-knowledge-server'), 'utf8'), 'old worker');
});

test('rejects a staging symlink and intermediate symlink without writing to their targets', (t) => {
  const root = fixture(t); const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  const direct = path.join(root, 'stage-link'); fs.symlinkSync(outside, direct, 'dir');
  assert.throws(() => assertSafeKnowledgeStaging(direct, root), /symlink|symbolic/i);
  assert.throws(() => assertNoKnowledgeSymlinks(direct, root), /symlink|symbolic/i);
  const nested = path.join(root, 'nested'); fs.mkdirSync(nested);
  fs.symlinkSync(outside, path.join(nested, 'link'), 'dir');
  assert.throws(() => assertSafeKnowledgeStaging(path.join(nested, 'link', 'worker'), root), /symlink|symbolic/i);
  assert.throws(() => assertNoKnowledgeSymlinks(path.join(nested, 'link', 'src'), root), /symlink|symbolic/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});
