import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createIntegratePublisher } from './integrate-publish.js';
import { abortIntegrate, computeIntegratePlan, continueIntegrate, integrateWorktreeCommits, isCherryPickInProgress } from './service.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text);
const read = (cwd, file) => fs.readFileSync(path.join(cwd, file), 'utf8');
const commit = (cwd, file, text) => {
  write(cwd, file, text);
  git(cwd, 'add', '--', file);
  git(cwd, 'commit', '-qm', file);
};
let root, repo, source;
const integrate = async (targetBranch = 'main') =>
  integrateWorktreeCommits(await computeIntegratePlan({ repoRoot: repo, sourceBranch: 'task', targetBranch }));

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-git-integrate-')));
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  vi.stubEnv('GIT_CONFIG_GLOBAL', os.devNull);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_EDITOR', 'true');
  repo = path.join(root, 'repo');
  source = path.join(root, 'source');
  vi.stubEnv('INTEGRATE_TEST_TARGET', repo);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  commit(repo, 'shared', 'base');
  commit(repo, 'other', 'base');
  git(repo, 'worktree', 'add', '-qb', 'task', source);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

// The hook runs in the cherry-pick checkout after the initial target inspection.
const afterPick = (script) => {
  const file = path.join(repo, '.git', 'hooks', 'post-commit');
  fs.writeFileSync(file, '#!/bin/sh\n' + script + '\n', { mode: 0o755 });
};

it('keeps the staged and unstaged versions of a later unrelated edit when publishing', async () => {
  commit(source, 'shared', 'incoming');
  afterPick('cd "$INTEGRATE_TEST_TARGET" && unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE && printf staged > other && git add -- other && printf working > other');
  expect(await integrate()).toEqual({ kind: 'success', moved: 1 });
  expect(read(repo, 'shared')).toBe('incoming');
  expect(git(repo, 'show', ':other')).toBe('staged');
  expect(read(repo, 'other')).toBe('working');
});

it('keeps a conflicting later edit and leaves the picked result on a recovery branch', async () => {
  commit(source, 'shared', 'incoming');
  const original = git(repo, 'rev-parse', 'HEAD');
  afterPick('printf mine > "$INTEGRATE_TEST_TARGET/shared"');
  await expect(integrate()).rejects.toThrow(/openchamber\/integrate-recovery-/);
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(original);
  expect(read(repo, 'shared')).toBe('mine');
  const recovery = git(repo, 'branch', '--list', '--format=%(refname:short)', 'openchamber/integrate-recovery-*');
  expect(git(repo, 'show', recovery + ':shared')).toBe('incoming');
});

it.each(['staged', 'untracked', 'ignored'])('preserves a later %s collision, including the index', async (kind) => {
  const file = kind === 'staged' ? 'shared' : 'new';
  commit(source, file, 'incoming');
  if (kind === 'ignored') write(repo, '.git/info/exclude', 'new\n');
  git(repo, 'config', 'merge.autoStash', 'true');
  git(repo, 'config', 'branch.main.mergeOptions', '--autostash --squash');
  afterPick(kind === 'staged'
    ? 'cd "$INTEGRATE_TEST_TARGET" && unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE && printf staged > shared && git add -- shared && printf mine > shared'
    : 'printf mine > "$INTEGRATE_TEST_TARGET/new"');
  const original = git(repo, 'rev-parse', 'main');
  await expect(integrate()).rejects.toThrow(/openchamber\/integrate-recovery-/);
  expect(read(repo, file)).toBe('mine');
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(original);
  if (kind === 'staged') expect(git(repo, 'show', ':shared')).toBe('staged');
  else expect(git(repo, 'ls-files', '--', file)).toBe('');
  expect(git(repo, 'stash', 'list')).toBe('');
});

// Both branches start at the same commit, so a tip comparison alone cannot
// detect the switch. Interleave real Git commands at the publication boundary.
it.each(['before locking', 'before merge'])('binds publication to the target when another client switches %s', async (when) => {
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'unrelated');
  const holder = path.join(root, 'holder');
  git(repo, 'worktree', 'add', '-qb', 'target', holder);
  commit(source, 'shared', 'incoming');
  const result = git(source, 'rev-parse', 'HEAD');
  let switched;
  const runGit = async (cwd, args, env) => {
    if (cwd === holder && args[0] === (when === 'before locking' ? 'status' : 'merge') && switched === undefined) {
      try { git(holder, 'switch', '-q', 'unrelated'); switched = true; }
      catch (error) { expect(error.stderr).toContain('index.lock'); switched = false; }
    }
    try {
      const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      return { success: true, stdout };
    } catch (error) {
      return { success: false, exitCode: error.status, stderr: error.stderr };
    }
  };
  const publisher = createIntegratePublisher({ runGit, runGitOrThrow: async (...args) => {
    const response = await runGit(...args);
    if (!response.success) throw new Error(response.stderr);
    return response;
  } });
  const publish = publisher.publish(repo, 'target', base, source, result);
  if (when === 'before locking') {
    await expect(publish).rejects.toThrow(/switched branches/);
    expect(switched).toBe(true);
    expect(git(holder, 'branch', '--show-current')).toBe('unrelated');
    expect(git(repo, 'rev-parse', 'target')).toBe(base);
    expect(read(holder, 'shared')).toBe('base');
  } else {
    await publish;
    expect(switched).toBe(false);
    expect(git(holder, 'branch', '--show-current')).toBe('target');
    expect(git(repo, 'rev-parse', 'target')).toBe(result);
    expect(read(holder, 'shared')).toBe('incoming');
  }
  expect(git(repo, 'rev-parse', 'unrelated')).toBe(base);
  expect(git(holder, 'status', '--porcelain')).toBe('');
  git(holder, 'switch', '-q', 'unrelated');
});

it('preserves the checkout squash message and split index during publication', async () => {
  git(repo, 'update-index', '--split-index');
  write(repo, '.git/SQUASH_MSG', 'earlier squash');
  commit(source, 'shared', 'incoming');
  expect(await integrate()).toEqual({ kind: 'success', moved: 1 });
  expect(read(repo, '.git/SQUASH_MSG')).toBe('earlier squash');
  expect(git(repo, 'show', ':shared')).toBe('incoming');
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

it('preserves a target branch that received another commit during the picks', async () => {
  commit(source, 'shared', 'incoming');
  afterPick('case "$PWD" in */oc-integrate-*) cd "$INTEGRATE_TEST_TARGET" && unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE && printf concurrent > other && git add other && git commit -qm concurrent;; esac');
  await expect(integrate()).rejects.toThrow(/main moved.*recovery branch/s);
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('concurrent');
  expect(git(repo, 'show', 'HEAD:other')).toBe('concurrent');
  expect(read(repo, 'shared')).toBe('base');
});

it('fast-forwards a free local target through its existing local upstream and leaves the main checkout alone', async () => {
  git(repo, 'branch', 'free');
  commit(repo, 'other', 'upstream');
  git(repo, 'branch', '--set-upstream-to=main', 'free');
  commit(source, 'shared', 'incoming');
  const main = git(repo, 'rev-parse', 'HEAD');
  expect(await integrate('free')).toEqual({ kind: 'success', moved: 1 });
  expect(git(repo, 'rev-parse', 'free^')).toBe(main);
  expect(git(repo, 'show', 'free:shared')).toBe('incoming');
  expect(read(repo, 'shared')).toBe('base');
  expect((await integrate('free')).kind).toBe('noop');
});

const conflict = async () => {
  commit(source, 'first', 'one');
  commit(source, 'shared', 'incoming');
  commit(repo, 'shared', 'target');
  const original = git(repo, 'rev-parse', 'HEAD');
  const result = await integrate();
  expect(result.kind).toBe('conflict');
  expect(result.details.unmergedFiles).toEqual(['shared']);
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(original);
  expect(fs.existsSync(path.join(repo, 'first'))).toBe(false);
  return result.state;
};

it('aborts a conflict without publishing the preceding picks or changing later local edits', async () => {
  const state = await conflict();
  write(repo, 'shared', 'mine');
  expect(await abortIntegrate(state)).toEqual({ success: true });
  expect(await abortIntegrate(state)).toEqual({ success: true });
  expect(read(repo, 'shared')).toBe('mine');
  expect(fs.existsSync(state.tempWorktreePath)).toBe(false);
  expect(fs.existsSync(path.join(repo, 'first'))).toBe(false);
});

it('retries a refused conflict resolution without losing it or replaying a pick', async () => {
  const state = await conflict();
  const original = git(repo, 'rev-parse', 'HEAD');
  write(state.tempWorktreePath, 'shared', 'resolved');
  git(state.tempWorktreePath, 'add', '--', 'shared');
  write(repo, 'shared', 'mine');
  await expect(continueIntegrate(state)).rejects.toThrow(/recovery branch/);
  expect(await isCherryPickInProgress(state.tempWorktreePath)).toEqual({ inProgress: true });
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(original);
  expect(read(repo, 'shared')).toBe('mine');
  const resolved = git(state.tempWorktreePath, 'rev-parse', 'HEAD');
  git(repo, 'stash', 'push', '-qm', 'local edit');
  expect(await continueIntegrate(state)).toEqual({ kind: 'success', moved: state.remainingCommits.length });
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(resolved);
  expect(read(repo, 'shared')).toBe('resolved');
  expect(git(repo, 'show', 'stash:shared')).toBe('mine');
  expect(fs.existsSync(state.tempWorktreePath)).toBe(false);
});

const oldConflict = () => {
  commit(source, 'shared', 'incoming');
  commit(repo, 'shared', 'target');
  const parent = path.join(root, '.config', 'openchamber', 'tmp');
  fs.mkdirSync(parent, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(parent, 'oc-integrate-'));
  git(repo, 'worktree', 'add', '-q', '--force', tmp, 'main');
  const sha = git(source, 'rev-parse', 'HEAD');
  expect(() => git(tmp, 'cherry-pick', sha)).toThrow();
  write(tmp, 'shared', 'resolved');
  git(tmp, 'add', 'shared');
  return { repoRoot: repo, tempWorktreePath: tmp, sourceBranch: 'task', targetBranch: 'main',
    cleanTargetWorktrees: [repo], remainingCommits: [sha], currentCommit: sha };
};

it('leaves an old conflict checkout intact if the target advanced concurrently', async () => {
  const state = oldConflict();
  commit(repo, 'other', 'later commit');
  const newer = git(repo, 'rev-parse', 'main');
  await expect(continueIntegrate(state)).rejects.toThrow();
  expect(git(repo, 'rev-parse', 'main')).toBe(newer);
  expect(git(state.tempWorktreePath, 'show', ':shared')).toBe('resolved');
  expect(await abortIntegrate(state)).toEqual({ success: true });
  expect(git(repo, 'rev-parse', 'main')).toBe(newer);
});

it('continues an older attached conflict without resetting any formerly clean checkout', async () => {
  const state = oldConflict();
  write(repo, 'other', 'mine');
  expect(await continueIntegrate(state)).toEqual({ kind: 'success', moved: 1 });
  expect(read(repo, 'other')).toBe('mine');
  expect(read(repo, 'shared')).toBe('resolved');
});

it('keeps the detached result when Git cannot create the recovery branch', async () => {
  git(repo, 'branch', 'openchamber');
  commit(source, 'shared', 'incoming');
  write(repo, 'shared', 'mine');
  await expect(integrate()).rejects.toThrow(/kept in .*oc-integrate-.*Could not create recovery branch/s);
  const tmp = fs.readdirSync(path.join(root, '.config', 'openchamber', 'tmp'))[0];
  expect(git(path.join(root, '.config', 'openchamber', 'tmp', tmp), 'show', 'HEAD:shared')).toBe('incoming');
  expect(read(repo, 'shared')).toBe('mine');
});

it('reports a partial fast-forward when Git updates the index before a locked branch ref', async () => {
  commit(source, 'shared', 'incoming');
  const original = git(repo, 'rev-parse', 'HEAD');
  const lock = path.join(repo, '.git', 'refs', 'heads', 'main.lock');
  fs.writeFileSync(lock, '');
  await expect(integrate()).rejects.toThrow(/stopped partway.*recovery branch/s);
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(original);
  expect(git(repo, 'show', ':shared')).toBe('incoming');
  fs.unlinkSync(lock);
  expect(await integrate()).toEqual({ kind: 'success', moved: 1 });
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

it.each(['alias', 'two holders'])('refuses an ambiguous target (%s) without moving either checkout', async (kind) => {
  commit(source, 'shared', 'incoming');
  const original = git(repo, 'rev-parse', 'HEAD');
  if (kind === 'alias') git(repo, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
  else git(repo, 'worktree', 'add', '-q', '--force', path.join(root, 'second'), 'main');
  await expect(integrate(kind === 'alias' ? 'alias' : 'main')).rejects.toThrow(/alias of|multiple worktrees/);
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(original);
  expect(read(repo, 'shared')).toBe('base');
});
