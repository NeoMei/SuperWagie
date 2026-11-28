import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeGitOutputPath, resolveGitOutputPath } from './output-path.js';

// The cherry-picks finish in a detached checkout. Git performs the only write
// to the target checkout and checks its index and working files as it does so.
export const createIntegratePublisher = ({ runGit, runGitOrThrow }) => {
  const branchTip = async (repo, branch) =>
    (await runGitOrThrow(repo, ['rev-parse', '--verify', `refs/heads/${branch}`], 'Target branch not found')).stdout.trim();

  const holderOf = async (repo, branch) => {
    const ref = `refs/heads/${branch}`;
    const alias = await runGit(repo, ['symbolic-ref', '--quiet', ref]);
    if (alias.success) throw new Error(`Target ${branch} is an alias of ${alias.stdout.trim()}`);
    if (alias.exitCode !== 1) throw new Error(alias.message || 'Failed to inspect target branch');

    const list = await runGitOrThrow(repo, ['worktree', 'list', '--porcelain', '-z'], 'Failed to list target worktrees');
    const holders = [];
    for (const record of list.stdout.split('\0\0')) {
      const fields = record.split('\0');
      if (fields.includes(`branch ${ref}`)) holders.push(normalizeGitOutputPath(fields[0].slice('worktree '.length)));
    }
    if (holders.length > 1) throw new Error(`Branch ${branch} is checked out in multiple worktrees: ${holders.join(', ')}`);
    return holders[0];
  };

  const publishCheckout = async (holder, branch, base, result) => {
    const ref = `refs/heads/${branch}`;
    const gitPath = async (name) => {
      const output = await runGitOrThrow(holder, ['rev-parse', '--git-path', name], 'Failed to locate the checkout metadata');
      return resolveGitOutputPath(holder, output.stdout.trim());
    };
    const index = await gitPath('index');
    const squashMessage = await gitPath('SQUASH_MSG');
    // Git switch/checkout must take this same lock. Hold it from before the
    // identity check until both the real index and the named ref are published.
    const lockPath = index + '.lock';
    const lock = await fs.open(lockPath, 'wx');
    let scratch;
    try {
      await lock.close();
      const checkHead = async () => {
        const head = await runGitOrThrow(holder, ['symbolic-ref', '--quiet', 'HEAD'], 'Failed to identify the target checkout');
        if (head.stdout.trim() !== ref) throw new Error(`The checkout at ${holder} switched branches`);
      };
      await checkHead();
      if (await branchTip(holder, branch) !== base) throw new Error(`Branch ${branch} moved during integration`);
      // merge --ff-only can also report "already up to date" for an older
      // result. A named-ref update must never turn that into a rewind.
      await runGitOrThrow(holder, ['merge-base', '--is-ancestor', base, result], 'Integration is not a fast-forward');
      scratch = await fs.mkdtemp(path.join(path.dirname(index), 'integrate-index-'));
      const nextIndex = path.join(scratch, 'index');
      try {
        await fs.copyFile(index, nextIndex);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const savedMessage = path.join(scratch, 'SQUASH_MSG');
      let hadMessage = true;
      try {
        await fs.rename(squashMessage, savedMessage);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        hadMessage = false;
      }
      try {
        // Let Git carry local edits and reject collisions, without allowing
        // the merge to choose a ref to advance through the checkout's HEAD.
        const merged = await runGit(holder, ['merge', '--ff-only', '--squash', '--no-autostash', '--no-overwrite-ignore', result], { GIT_INDEX_FILE: nextIndex });
        if (!merged.success) return merged;
      } finally {
        if (hadMessage) {
          try {
            await fs.rename(savedMessage, squashMessage);
          } catch (error) {
            // Keep the original file for recovery if the OS refuses the rename.
            scratch = undefined;
            throw new Error(`Could not restore ${squashMessage}; the original remains at ${savedMessage}`, { cause: error });
          }
        } else {
          await fs.rm(squashMessage, { force: true });
        }
      }
      await checkHead();
      await fs.rename(nextIndex, index);
      return await runGit(holder, ['update-ref', '--no-deref', '-m', 'integrate: fast-forward', ref, result, base]);
    } finally {
      try { if (scratch) await fs.rm(scratch, { recursive: true, force: true }); }
      finally { await fs.unlink(lockPath); }
    }
  };

  const publish = async (repo, branch, base, checkout, result) => {
    const holder = await holderOf(repo, branch);
    const current = await branchTip(repo, branch);
    if (current === result) return;
    if (current !== base) throw new Error(`Branch ${branch} moved during integration`);
    let update;
    let before;
    if (holder) {
      before = await runGitOrThrow(holder, ['status', '--porcelain', '-z'], 'Failed to inspect the target checkout');
      update = await publishCheckout(holder, branch, base, result);
    } else {
      // Local fetch refuses a non-fast-forward and a target being checked out,
      // rebased or bisected. It needs no remote or network request.
      update = await runGit(checkout, ['fetch', '--no-tags', '--no-prune', '--no-recurse-submodules', '--no-write-fetch-head', '.', `${result}:refs/heads/${branch}`]);
    }
    if (await branchTip(repo, branch) === result) return;
    const reason = (update.stderr || update.message || 'Check the target branch and index.').trim();
    if (holder) {
      const after = await runGit(holder, ['status', '--porcelain', '-z']);
      if (after.success && after.stdout !== before.stdout) {
        throw new Error(`Update of ${branch} stopped partway in ${holder}. Inspect the checkout and index before retrying. ${reason}`);
      }
    }
    throw new Error(`Could not update ${branch}${holder ? ` in ${holder}` : ''}. ${reason}`);
  };
  return { branchTip, holderOf, publish };
};
