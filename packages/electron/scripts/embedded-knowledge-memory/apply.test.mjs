import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyMemoryIndexOverlay, memoryIndexOverlayDigest, matchesMemoryIndexOverlay } from './apply.mjs';

function sourceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-overlay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'internal/router'), { recursive: true });
  fs.mkdirSync(path.join(root, 'internal/container'), { recursive: true });
  fs.writeFileSync(path.join(root, 'go.mod'), 'module github.com/Tencent/WeKnora\n');
  fs.writeFileSync(path.join(root, 'internal/router/router.go'), `package router
import (
  "github.com/Tencent/WeKnora/internal/handler"
)
type RouterParams struct {
  KBHandler                    *handler.KnowledgeBaseHandler
}
func fixture() {
    RegisterKnowledgeBaseRoutes(v1, params.KBHandler, rbacGuards)
}
`);
  fs.writeFileSync(path.join(root, 'internal/container/container.go'), `package container
import (
  "github.com/Tencent/WeKnora/internal/handler"
)
func fixture() {
    must(container.Provide(handler.NewKnowledgeBaseHandler))
}
`);
  return root;
}

test('applies source and routing once, and records a reproducible digest', (t) => {
  const root = sourceFixture(t);
  const first = applyMemoryIndexOverlay(root);
  const applied = fs.readFileSync(path.join(root, 'internal/router/router.go'), 'utf8');
  const second = applyMemoryIndexOverlay(root);
  assert.deepEqual(first, second);
  assert.equal(first.sha256, memoryIndexOverlayDigest());
  assert.equal(fs.readFileSync(path.join(root, 'internal/router/router.go'), 'utf8'), applied);
  assert.ok(fs.statSync(path.join(root, 'internal/memoryindex/store.go')).size > 1000);
  assert.ok(fs.statSync(path.join(root, 'internal/router/routes_memory_index.go')).size > 1000);
  assert.equal(matchesMemoryIndexOverlay({ memoryIndexOverlay: first }), true);
  assert.equal(matchesMemoryIndexOverlay({}), false);
});

test('rejects an upstream hook change before modifying source', (t) => {
  const root = sourceFixture(t);
  fs.writeFileSync(path.join(root, 'internal/container/container.go'), 'package container\n');
  const originalRouter = fs.readFileSync(path.join(root, 'internal/router/router.go'), 'utf8');
  assert.throws(() => applyMemoryIndexOverlay(root), /hook/);
  assert.equal(fs.existsSync(path.join(root, 'internal/memoryindex')), false);
  assert.equal(fs.readFileSync(path.join(root, 'internal/router/router.go'), 'utf8'), originalRouter);
});
