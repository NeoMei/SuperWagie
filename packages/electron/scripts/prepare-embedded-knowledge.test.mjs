import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { applyMemoryIndexOverlay, memoryIndexOverlayDigest } from './embedded-knowledge-memory/apply.mjs';
import { knowledgeGitEnv } from './embedded-knowledge-git-env.mjs';
import knowledgePins from './embedded-knowledge-pin.cjs';
import { windowsPatchIdentity } from './embedded-knowledge-windows.mjs';

test('memory overlay builds use an independent copy and preserve the verified source checkout', async (t) => {
  const { prepareMemoryIndexBuildSource } = await import('./prepare-embedded-knowledge.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory build source '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, 'source');
  fs.mkdirSync(sourceDirectory);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: sourceDirectory, env: knowledgeGitEnv(), encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  const files = {
    '.gitignore': 'ignored-build-data\n',
    'go.mod': 'module github.com/Tencent/WeKnora\n',
    'internal/router/router.go': 'package router\nimport (\n "github.com/Tencent/WeKnora/internal/handler"\n)\ntype Params struct {\n KBHandler *handler.KnowledgeBaseHandler\n}\nfunc register() {\n RegisterKnowledgeBaseRoutes(v1, params.KBHandler, rbacGuards)\n}\n',
    'internal/container/container.go': 'package container\nimport (\n "github.com/Tencent/WeKnora/internal/handler"\n)\nfunc provide() {\n must(container.Provide(handler.NewKnowledgeBaseHandler))\n}\n',
  };
  for (const [name, value] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(sourceDirectory, name)), { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, name), value);
  }
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  const options = { sourceDirectory, buildRoot: path.join(root, 'build'), commit };
  const directory = prepareMemoryIndexBuildSource(options);
  assert.notEqual(directory, sourceDirectory);
  assert.equal(fs.statSync(path.join(directory, 'go.mod')).nlink, 1);
  const overlay = applyMemoryIndexOverlay(directory);
  assert.equal(overlay.sha256, memoryIndexOverlayDigest());
  assert.match(fs.readFileSync(path.join(directory, 'internal/router/router.go'), 'utf8'), /RegisterMemoryIndexRoutes/);
  for (const [name, value] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(sourceDirectory, name), 'utf8'), value);
  assert.equal(git('status', '--porcelain=v1', '--ignored=matching'), '');
  const second = prepareMemoryIndexBuildSource(options);
  assert.notEqual(directory, second);
  assert.equal(fs.readFileSync(path.join(second, 'internal/router/router.go'), 'utf8'), files['internal/router/router.go']);
  fs.writeFileSync(path.join(sourceDirectory, 'ignored-build-data'), 'unreviewed cached build');
  assert.throws(() => prepareMemoryIndexBuildSource(options), /local changes or ignored build data/);
  assert.equal(fs.readFileSync(path.join(sourceDirectory, 'ignored-build-data'), 'utf8'), 'unreviewed cached build');
});

test('staged backend cache requires current memory routes and the recorded executable bytes', async (t) => {
  const { canReuseStagedKnowledge, canReuseStagedKnowledgeBinary } = await import('./prepare-embedded-knowledge.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hy backend cache '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'config'));
  fs.mkdirSync(path.join(directory, 'migrations/sqlite'), { recursive: true });
  const binaryName = 'fixture-backend';
  const binary = path.join(directory, binaryName);
  fs.writeFileSync(binary, 'the compiled memory route');
  const pin = knowledgePins.knowledgeSourcePin({});
  const manifest = { ...pin, tags: 'sqlite_fts5,anydoc', windowsPatch: windowsPatchIdentity('win32'),
    binarySha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    memoryIndexOverlay: { version: 1, sha256: memoryIndexOverlayDigest() } };
  const options = { manifest, directory, binaryName, repository: pin.repository, ref: pin.ref, pinnedCommit: pin.commit, tags: 'sqlite_fts5,anydoc', platform: 'win32' };
  assert.equal(pin.commit, 'cd90b9a57abe85ad498e59b9be74e2748110c353');
  assert.equal(canReuseStagedKnowledgeBinary(options), true);
  assert.equal(canReuseStagedKnowledge(options), false, 'Legacy binary needs its portable dictionary resources');
  for (const change of [{ repository: 'other-repository' }, { ref: 'embedded-knowledge' }, { commit: 'f5adb9eac166e7d3da7dceed7aa50049d4c4db1f' }, { windowsPatch: { ...manifest.windowsPatch, sha256: '0'.repeat(64) } }]) {
    assert.equal(canReuseStagedKnowledgeBinary({ ...options, manifest: { ...manifest, ...change } }), false);
  }
  const overlay = manifest.memoryIndexOverlay;
  delete manifest.memoryIndexOverlay;
  assert.equal(canReuseStagedKnowledgeBinary(options), false);
  manifest.memoryIndexOverlay = { version: 1, sha256: '0'.repeat(64) };
  assert.equal(canReuseStagedKnowledgeBinary(options), false);
  manifest.memoryIndexOverlay = overlay;
  fs.writeFileSync(binary, 'older backend without the memory route');
  assert.equal(canReuseStagedKnowledgeBinary(options), false);
});
