import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkExistingOwnTag, checkMainLine, checkRelease, releaseTagsToCheck } from './release-preflight.mjs';

const ancestors = (list) => (tag) => list.includes(tag);

test('打 tag 前的 --require-main 拦住旁支发版', () => {
  assert.deepEqual(checkMainLine(true), []);
  assert.match(checkMainLine(false)[0], /还没进 origin\/main/);
});

test('2.7.93 那种情况被拦下：上一版 2.7.92 不在当前提交里', () => {
  const problems = checkRelease({
    version: '2.7.93',
    tags: ['v2.7.91', 'v2.7.92'],
    isAncestor: ancestors(['v2.7.91']),
  });
  assert.match(problems[0], /上一版 v2\.7\.92 不是当前提交的祖先/);
});

test('一个版本号被两条发布线占用时被拦下', () => {
  const problems = checkRelease({
    version: '2.7.92',
    tags: ['v2.7.91', 'v2.7.92'],
    isAncestor: ancestors(['v2.7.91']),
  });
  assert.match(problems[0], /v2\.7\.92 已被另一条发布线占用/);
});

test('上一版是祖先就通过，包括本版 tag 已存在的重跑', () => {
  assert.deepEqual(
    checkRelease({ version: '2.7.91', tags: ['v2.7.90', 'v2.7.91'], isAncestor: ancestors(['v2.7.90', 'v2.7.91']) }),
    [],
  );
  assert.deepEqual(checkRelease({ version: '2.7.94', tags: ['v2.7.93'], isAncestor: ancestors(['v2.7.93']) }), []);
});

test('an off-main historic tag does not poison a complete later release', () => {
  assert.deepEqual(checkRelease({ version: '2.7.95', tags: ['v2.7.92', 'v2.7.93', 'v2.7.94'], isAncestor: ancestors(['v2.7.93', 'v2.7.94']) }), []);
});

test('an existing version tag must point at this exact release commit', () => {
  const tags = ['v2.7.94'];
  const tagCommit = () => 'aaaaaaaaa';
  assert.equal(checkExistingOwnTag({ version: '2.7.94', tags, tagCommit, headCommit: 'bbbbbbbbb' })[0].includes('不能改指另一条提交'), true);
  assert.deepEqual(checkExistingOwnTag({ version: '2.7.94', tags, tagCommit: () => 'bbbbbbbbb', headCommit: 'bbbbbbbbb' }), []);
});

test('首个版本与无 tag 仓库放行', () => {
  assert.deepEqual(checkRelease({ version: '1.0.0', tags: [], isAncestor: () => false }), []);
});

test('上一版取小于本版的最大 tag，走版本号比较而不是字符串排序', () => {
  const { previous, own } = releaseTagsToCheck('2.7.94', ['v2.7.9', 'v2.7.90', 'v2.7.100', 'v2.7.93'], () => true);
  assert.equal(previous, 'v2.7.93');
  assert.equal(own, null);
});
