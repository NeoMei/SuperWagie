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
      if (fields.includes(`branch ${ref}`)) holders.push(fields[0].slice('worktree '.length));
    }
    if (holders.length > 1) throw new Error(`Branch ${branch} is checked out in multiple worktrees: ${holders.join(', ')}`);
    return holders[0];
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
      const head = await runGitOrThrow(holder, ['symbolic-ref', '--quiet', 'HEAD'], 'Failed to identify the target checkout');
      if (head.stdout.trim() !== `refs/heads/${branch}`) throw new Error(`The checkout at ${holder} switched branches`);
      update = await runGit(holder, ['merge', '--ff-only', '--no-squash', '--no-autostash', '--no-overwrite-ignore', result]);
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
