#!/usr/bin/env node
// 发版前挡住功能倒退：只核对 package.json 的版本号不够。
//
// 2026-11-13 的 2.7.92 被两条发布线用过：credits-only 线在功能分支上发版、从未合 main，
// 另一条从 2.7.91 直出的线顺延成 2.7.93 并成了 Latest，于是 main 上没有的改动被"新版本"顶掉。
// 两条断言能当场拦住它：
//   1. 本版 tag 若已存在，必须是 HEAD 的祖先（一个版本号只能对应一条线）。
//   2. 小于本版的最大 tag 必须是 HEAD 的祖先（本版包含上一版的全部内容）。
//
// 用法：bun run release:preflight（RELEASE_PREFLIGHT_SKIP=1 可临时跳过）
// 打 tag 前加 --require-main：本版提交必须已进 origin/main，拦住"在旁支发版"。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

export const parseReleaseTag = (tag) => {
  const match = VERSION_TAG.exec(tag);
  return match ? { tag, version: [Number(match[1]), Number(match[2]), Number(match[3])] } : null;
};

const compareVersion = (left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

export const versionOf = (tag) => parseReleaseTag(`v${String(tag).replace(/^v/, '')}`)?.version ?? null;

// 返回需要核对的 tag：本版 tag（可能不存在）与小于本版的最大 tag。
export const releaseTagsToCheck = (version, tags) => {
  const target = versionOf(version);
  if (!target) return { own: null, previous: null };
  const parsed = tags.map(parseReleaseTag).filter(Boolean);
  const own = parsed.find((entry) => compareVersion(entry.version, target) === 0)?.tag ?? null;
  const previous = parsed
    .filter((entry) => compareVersion(entry.version, target) < 0)
    .sort((left, right) => compareVersion(right.version, left.version))[0]?.tag ?? null;
  return { own, previous };
};

export const checkRelease = ({ version, tags, isAncestor }) => {
  const { own, previous } = releaseTagsToCheck(version, tags);
  const problems = [];
  if (own && !isAncestor(own)) {
    problems.push(`v${version} 已被另一条发布线占用且不在当前提交里。换一个未使用的版本号，或先把它并入。`);
  }
  if (previous && !isAncestor(previous)) {
    problems.push(`上一版 ${previous} 不是当前提交的祖先：本版会丢掉它包含的功能。先合入 ${previous} 所在的线。`);
  }
  if (problems.length) {
    const lines = previous ? [`当前提交不含的上一版提交：`, `  git log --oneline ${previous}..HEAD`] : [];
    return [...problems, ...lines];
  }
  return [];
};

export const checkMainLine = (headOnMain) => headOnMain
  ? []
  : ['当前提交还没进 origin/main：先在 main 上合并再打 tag。旁支上发的版会在下一次从 main 发版时整条丢掉。'];

const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const run = () => {
  if (process.env.RELEASE_PREFLIGHT_SKIP === '1') {
    console.warn('release:preflight 已按 RELEASE_PREFLIGHT_SKIP=1 跳过');
    return;
  }
  let version;
  try {
    version = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    console.warn('release:preflight：读不到 package.json 版本，跳过');
    return;
  }
  let tags;
  let isAncestor;
  let headOnMain = () => true;
  try {
    tags = git(['tag', '-l']).split('\n').filter(Boolean);
    isAncestor = (tag) => {
      try {
        git(['merge-base', '--is-ancestor', tag, 'HEAD']);
        return true;
      } catch {
        return false;
      }
    };
    headOnMain = () => {
      try {
        git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
        return true;
      } catch {
        return false;
      }
    };
  } catch {
    console.warn('release:preflight：当前目录不是 git 仓库，跳过');
    return;
  }
  const problems = checkRelease({ version, tags, isAncestor });
  if (process.argv.includes('--require-main')) problems.push(...checkMainLine(headOnMain()));
  if (problems.length) {
    console.error(`release:preflight 未通过（版本 ${version}）：`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`release:preflight 通过（版本 ${version}）`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
