import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { rmSync, symlinkSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gitApi from '@/lib/gitApi';
import * as projectResolver from '@/lib/worktreeSessionCreator';
import * as treeMove from './sessionWorktreeMove';
import * as actions from '@/sync/session-actions';
import * as runtime from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import { moveWorktreeSessionsThenRemove, readWorktreeSessions } from './worktreeRetention';

const session = (id: string, directory: string, parentID?: string): Session => ({
  id, directory, parentID, title: id, projectID: 'project', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});
let fixture: string;
let checkout: string;
let project: string;
let alias: string;
let records: Session[];
let current: boolean;
let removals: number;
let pageReads: number;
let placementReads: number;
let beforeRescan: (() => void) | undefined;
let beforeMove: ((id: string) => void) | undefined;
let beforeRemovalGuard: (() => void) | undefined;
let nativeQueue: Array<() => void>;
const restoreSpies: Array<() => void> = [];

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'c04-retain-'));
  checkout = join(fixture, 'checkout');
  project = join(fixture, 'project');
  alias = join(fixture, 'alias');
  await mkdir(checkout);
  await mkdir(join(checkout, 'sub'));
  await mkdir(project);
  await symlink(checkout, alias);
  checkout = await realpath(checkout);
  project = await realpath(project);
  records = [session('parent', alias), session('child', alias, 'parent'), session('second', join(checkout, 'sub'))];
  current = true; removals = 0; pageReads = 0; placementReads = 0; nativeQueue = [];
  beforeRescan = undefined; beforeMove = undefined; beforeRemovalGuard = undefined;
  const pathSpy = spyOn(gitApi, 'validateWorktreeDirectory').mockImplementation(async (directory, root) => {
    try {
      const cwd = await realpath(directory);
      const worktree = await realpath(root);
      return { valid: (await stat(cwd)).isDirectory(), insideWorktreeRoot: cwd === worktree || cwd.startsWith(`${worktree}/`), resolvedCwd: cwd, resolvedWorktreeRoot: worktree };
    } catch {
      return { valid: false, insideWorktreeRoot: false, resolvedCwd: null, resolvedWorktreeRoot: null };
    }
  });
  const primarySpy = spyOn(gitApi, 'resolveGitPrimaryRoot').mockImplementation(async () => project);
  const runtimeSpy = spyOn(runtime, 'captureRuntimeInstance').mockImplementation(() => () => current);
  const listSpy = spyOn(opencodeClient, 'listSessionsPage').mockImplementation(async (options) => {
    expect(options?.global).toBe(true);
    pageReads += 1;
    if (!options?.cursor && placementReads > 0) beforeRescan?.();
    const offset = Number(options?.cursor ?? 0);
    return { sessions: records.slice(offset, offset + 1), cursor: offset + 1 < records.length ? { next: String(offset + 1) } : {} };
  });
  const projectSpy = spyOn(projectResolver, 'resolveFolderProjectRef').mockImplementation(async () => ({ id: 'project', path: project }));
  const activitySpy = spyOn(actions, 'readSessionsLiveActivity').mockImplementation(async () => 'idle');
  const moveSpy = spyOn(treeMove, 'moveSessionTreeToProject').mockImplementation(async (tree) => {
    beforeMove?.(tree.root.id);
    // The command answers before the native inbox applies it.
    nativeQueue.push(() => {
      const ids = new Set([tree.root.id, ...tree.descendants.map((item) => item.id)]);
      records = records.map((item) => ids.has(item.id) ? { ...item, directory: tree.projectDirectory } : item);
    });
    return tree.projectDirectory;
  });
  const readSpy = spyOn(opencodeClient, 'getSession').mockImplementation(async (id) => {
    placementReads += 1;
    if (placementReads % 2 === 0) nativeQueue.splice(0).forEach((apply) => apply());
    const item = records.find((record) => record.id === id);
    if (!item) throw new Error('missing session');
    return item;
  });
  restoreSpies.push(...[pathSpy, primarySpy, runtimeSpy, listSpy, projectSpy, activitySpy, moveSpy, readSpy].map((spy) => () => spy.mockRestore()));
});
afterEach(async () => {
  restoreSpies.splice(0).reverse().forEach((restore) => restore());
  await rm(fixture, { recursive: true, force: true });
});
const run = () => moveWorktreeSessionsThenRemove({
  worktreePath: checkout, projectDirectory: project,
  removeWorktree: async (guard) => {
    beforeRemovalGuard?.();
    await guard.beforeRemove();
    expect(guard.isCurrent()).toBe(true);
    expect(records.every((item) => item.directory === project)).toBe(true);
    removals += 1;
    await rm(checkout, { recursive: true });
    return true;
  },
});

describe('C04 runtime adapter with temporary directories', () => {
  test('complete pagination finds symlinked parent and child plus subfolder sessions', async () => {
    expect((await readWorktreeSessions(checkout)).map((item) => item.id)).toEqual(['parent', 'child', 'second']);
    expect(pageReads).toBe(3);
  });
  test('waits for native queued placements, rescans all pages, then removes only fixture checkout', async () => {
    expect(await run()).toEqual({ removed: true, movedIds: ['child', 'parent', 'second'] });
    expect(removals).toBe(1);
    expect(placementReads).toBeGreaterThan(3);
    expect(pageReads).toBe(9);
  });
  test('a stored path under checkout that resolves outside blocks both listing and removal', async () => {
    const linked = join(checkout, 'linked');
    await symlink(project, linked);
    records = [session('outward', linked)];
    await expect(readWorktreeSessions(checkout)).rejects.toMatchObject({ reason: 'source' });
    await expect(run()).rejects.toMatchObject({ reason: 'source', movedIds: [] });
    expect(nativeQueue).toHaveLength(0);
    expect(removals).toBe(0);
    expect((await stat(checkout)).isDirectory()).toBe(true);
  });
  test('the final manager scan rejects a new raw checkout path with an outward alias', async () => {
    const linked = join(checkout, 'linked');
    await symlink(project, linked);
    beforeRemovalGuard = () => { records.push(session('late', linked)); };
    await expect(run()).rejects.toMatchObject({ reason: 'source', movedIds: ['child', 'parent', 'second'] });
    expect(removals).toBe(0);
    expect((await stat(checkout)).isDirectory()).toBe(true);
  });
  test('retargeting a source alias during migration cannot hide a remaining session', async () => {
    const linked = join(checkout, 'linked');
    await symlink(join(checkout, 'sub'), linked);
    beforeRescan = () => {
      rmSync(linked);
      symlinkSync(project, linked);
      records.push(session('retargeted', linked));
      beforeRescan = undefined;
    };
    await expect(run()).rejects.toMatchObject({ reason: 'source', movedIds: ['child', 'parent', 'second'] });
    expect(removals).toBe(0);
  });
  test('a nested foreign primary is rejected before moving into a registered subfolder', async () => {
    const target = join(project, 'tools');
    await mkdir(target);
    const primary = spyOn(gitApi, 'resolveGitPrimaryRoot').mockImplementation(async (directory) => directory === target ? target : project);
    const resolver = spyOn(projectResolver, 'resolveFolderProjectRef').mockResolvedValue({ id: 'tools', path: target });
    restoreSpies.push(() => primary.mockRestore(), () => resolver.mockRestore());
    await expect(run()).rejects.toMatchObject({ reason: 'destination', movedIds: [] });
    expect(nativeQueue).toHaveLength(0);
    expect(removals).toBe(0);
  });
  test('a same-repository subfolder remains a valid destination', async () => {
    const target = join(project, 'tools');
    await mkdir(target);
    const resolver = spyOn(projectResolver, 'resolveFolderProjectRef').mockResolvedValue({ id: 'tools', path: target });
    restoreSpies.push(() => resolver.mockRestore());
    const result = await moveWorktreeSessionsThenRemove({ worktreePath: checkout, projectDirectory: project, removeWorktree: async (guard) => {
      await guard.beforeRemove();
      expect(records.every((item) => item.directory === target)).toBe(true);
      removals += 1;
      return true;
    } });
    expect(result).toEqual({ removed: true, movedIds: ['child', 'parent', 'second'] });
    expect(removals).toBe(1);
  });
  test('a destination that becomes a nested repository after placement blocks the final guard', async () => {
    const target = join(project, 'tools');
    await mkdir(target);
    let foreign = false;
    const primary = spyOn(gitApi, 'resolveGitPrimaryRoot').mockImplementation(async (directory) => foreign && directory === target ? target : project);
    const resolver = spyOn(projectResolver, 'resolveFolderProjectRef').mockResolvedValue({ id: 'tools', path: target });
    restoreSpies.push(() => primary.mockRestore(), () => resolver.mockRestore());
    beforeRemovalGuard = () => { foreign = true; };
    await expect(run()).rejects.toMatchObject({ reason: 'destination', movedIds: ['child', 'parent', 'second'] });
    expect(removals).toBe(0);
  });
  test('a symlinked target inside checkout is rejected before migration', async () => {
    project = alias;
    await expect(run()).rejects.toMatchObject({ reason: 'destination', movedIds: [] });
    expect(nativeQueue).toHaveLength(0);
    expect(removals).toBe(0);
  });
  test('second group failure preserves first group at the project and retains checkout', async () => {
    beforeMove = (id) => { if (id === 'second') throw new Error('migration rejected'); };
    await expect(run()).rejects.toMatchObject({ reason: 'moveFailed', movedIds: ['child', 'parent'] });
    expect(records.filter((item) => item.directory === project).map((item) => item.id)).toEqual(['parent', 'child']);
    expect(removals).toBe(0);
    expect((await stat(checkout)).isDirectory()).toBe(true);
  });
  test('a session created during migration stops the final deletion', async () => {
    beforeRescan = () => { records.push(session('new', checkout)); beforeRescan = undefined; };
    await expect(run()).rejects.toMatchObject({ reason: 'added' });
    expect(removals).toBe(0);
  });
  test('instance change after queued move stops placement reads and deletion', async () => {
    beforeMove = () => { current = false; };
    await expect(run()).rejects.toMatchObject({ reason: 'switched' });
    expect(placementReads).toBe(0);
    expect(removals).toBe(0);
  });
  test('external directory loss before final validation blocks removal callback', async () => {
    beforeRescan = () => { rmSync(project, { recursive: true }); beforeRescan = undefined; };
    await expect(run()).rejects.toThrow();
    expect(removals).toBe(0);
  });
});
