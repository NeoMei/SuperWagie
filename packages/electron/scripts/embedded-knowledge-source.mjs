import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isVerifiedWindowsKnowledgePatch } from './embedded-knowledge-windows.mjs';
import { knowledgeGitEnv } from './embedded-knowledge-git-env.mjs';

export function hasLocalKnowledgeGitDirectory(directory) {
  let info;
  try { info = fs.lstatSync(path.join(directory, '.git')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Embedded knowledge Git metadata must be a real local directory');
  }
  const gitDir = path.join(directory, '.git');
  try {
    fs.lstatSync(path.join(gitDir, 'commondir'));
    throw new Error('Embedded knowledge Git metadata must not use a common directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = path.join(gitDir, 'config');
  const configInfo = fs.lstatSync(config);
  if (!configInfo.isFile() || configInfo.isSymbolicLink()) throw new Error('Embedded knowledge Git metadata config must be a local file');
  const env = knowledgeGitEnv();
  const settings = spawnSync('git', ['config', '--no-includes', '--file', config, '--name-only', '--list', '-z'], {
    cwd: directory, encoding: 'buffer', env, windowsHide: true,
  });
  if (settings.error || settings.status !== 0) throw new Error('Unable to verify embedded knowledge Git metadata config');
  if (settings.stdout.toString('utf8').split('\0').some((name) => /^(core\.worktree|include\.|includeif\.|extensions\.worktreeconfig)/i.test(name))) {
    throw new Error('Embedded knowledge Git metadata contains a redirected worktree or config include');
  }
  const identity = spawnSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], {
    cwd: directory, encoding: 'utf8', env, windowsHide: true,
  });
  if (identity.error || identity.status !== 0) throw new Error('Unable to verify embedded knowledge Git metadata identity');
  const paths = identity.stdout.trim().split(/\r?\n/);
  const expected = [directory, gitDir, gitDir].map((item) => fs.realpathSync(item));
  if (paths.length !== 3 || paths.some((item, index) => {
    try { return fs.realpathSync(item) !== expected[index]; } catch { return true; }
  })) throw new Error('Embedded knowledge Git metadata resolves outside the local checkout');
  return true;
}

// Even ignored files can participate in the Go/Rust build. Reusing a checkout
// with unknown generated source or archives is unsafe; preserve it for review.
export function assertCleanKnowledgeSource(directory, platform) {
  if (!hasLocalKnowledgeGitDirectory(directory)) throw new Error('Embedded knowledge Git metadata directory is missing');
  const flags = spawnSync('git', ['ls-files', '-v', '-z'], {
    cwd: directory, encoding: 'buffer', env: knowledgeGitEnv(), windowsHide: true,
  });
  if (flags.error || flags.status !== 0) throw new Error('Unable to verify embedded knowledge source index flags');
  if (flags.stdout.toString('utf8').split('\0').filter(Boolean).some((entry) => !entry.startsWith('H '))) {
    throw new Error('Embedded knowledge source index has flags that can hide changes; preserve it and review before building');
  }
  const result = spawnSync('git', ['status', '--porcelain=v1', '--ignored=matching', '--untracked-files=normal', '-z'], {
    cwd: directory, encoding: 'buffer', env: knowledgeGitEnv(), windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('Unable to verify embedded knowledge source cleanliness');
  const entries = result.stdout.toString('utf8').split('\0').filter(Boolean);
  const patchedFiles = new Set(['scripts/build-anydoc-lib.sh', 'third_party/anydoc-go/anydoc.go']);
  const exactWindowsPatch = platform === 'win32' && entries.length === 2
    && entries.every((entry) => entry.slice(0, 3) === ' M ' && patchedFiles.has(entry.slice(3)))
    && new Set(entries.map((entry) => entry.slice(3))).size === 2
    && isVerifiedWindowsKnowledgePatch(directory);
  if (entries.length && !exactWindowsPatch) throw new Error('Embedded knowledge source has local changes or ignored build data; preserve it and review before building');
}

export function assertNoKnowledgeSymlinks(directory, boundary) {
  const relative = path.relative(boundary, directory);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Embedded knowledge path is outside its trusted workspace');
  }
  let current = boundary;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let info;
    try { info = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error(`Embedded knowledge path contains a symbolic link: ${current}`);
    if (!info.isDirectory()) throw new Error(`Embedded knowledge path is not a directory: ${current}`);
  }
}

export function assertSafeKnowledgeStaging(directory, boundary = path.dirname(directory)) {
  assertNoKnowledgeSymlinks(directory, boundary);
  if (!fs.existsSync(directory)) return;
  const entries = fs.readdirSync(directory);
  if (entries.length === 0) return;
  if (entries.length === 1 && entries[0] === '.gitkeep') {
    const file = path.join(directory, '.gitkeep');
    const info = fs.lstatSync(file);
    if (info.isFile() && !info.isSymbolicLink() && info.size === 0) return;
  }
  throw new Error('Existing embedded knowledge staging differs; preserve it and review before rebuilding');
}
