// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const overlayRoot = path.dirname(fileURLToPath(import.meta.url));
const packageImport = 'github.com/Tencent/WeKnora/internal/memoryindex';
const goFiles = () => fs.readdirSync(path.join(overlayRoot, 'go')).filter((name) => name.endsWith('.go')).sort();

export function memoryIndexOverlayDigest() {
  const hash = crypto.createHash('sha256');
  for (const file of ['apply.mjs', ...goFiles().map((name) => `go/${name}`)]) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(overlayRoot, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function matchesMemoryIndexOverlay(manifest) {
  return manifest?.memoryIndexOverlay?.version === 1
    && manifest.memoryIndexOverlay.sha256 === memoryIndexOverlayDigest();
}

function insertHook(source, pattern, already, replacement, name) {
  if (already.test(source)) return source;
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replaceAll('g', '')}g`))];
  if (matches.length !== 1) throw new Error(`Embedded memory overlay hook changed: ${name}`);
  return source.replace(pattern, replacement);
}

function importPackage(source) {
  return insertHook(source, /^([ \t]*)"github\.com\/Tencent\/WeKnora\/internal\/handler"\r?$/m,
    /"github\.com\/Tencent\/WeKnora\/internal\/memoryindex"/,
    `$&\n$1"${packageImport}"`, 'memory package import');
}

export function applyMemoryIndexOverlay(sourceDirectory) {
  const root = path.resolve(sourceDirectory);
  const module = fs.readFileSync(path.join(root, 'go.mod'), 'utf8');
  if (!/^module github\.com\/Tencent\/WeKnora\s*$/m.test(module)) {
    throw new Error('Embedded memory overlay requires the pinned WeKnora module');
  }
  const routerFile = path.join(root, 'internal/router/router.go');
  const containerFile = path.join(root, 'internal/container/container.go');
  let router = importPackage(fs.readFileSync(routerFile, 'utf8'));
  let container = importPackage(fs.readFileSync(containerFile, 'utf8'));
  router = insertHook(router, /^([ \t]*)KBHandler[ \t]+\*handler\.KnowledgeBaseHandler\r?$/m,
    /^\s*MemoryIndexHandler\s+\*memoryindex\.Handler\s*$/m,
    '$&\n$1MemoryIndexHandler *memoryindex.Handler', 'router dependency');
  router = insertHook(router, /^([ \t]*)RegisterKnowledgeBaseRoutes\(v1, params\.KBHandler, rbacGuards\)\r?$/m,
    /RegisterMemoryIndexRoutes\(v1, params\.MemoryIndexHandler, rbacGuards\)/,
    '$&\n$1RegisterMemoryIndexRoutes(v1, params.MemoryIndexHandler, rbacGuards)', 'authenticated route registration');
  container = insertHook(container, /^([ \t]*)must\(container\.Provide\(handler\.NewKnowledgeBaseHandler\)\)\r?$/m,
    /must\(container\.Provide\(memoryindex\.NewHandler\)\)/,
    '$&\n$1must(container.Provide(memoryindex.NewHandler))', 'handler injection');

  // Validate all upstream anchors before changing any source in the build copy.
  const writes = [[routerFile, router], [containerFile, container]];
  for (const name of goFiles()) {
    const folder = name.startsWith('routes_memory_index') ? 'router' : 'memoryindex';
    writes.push([path.join(root, 'internal', folder, name), fs.readFileSync(path.join(overlayRoot, 'go', name))]);
  }
  for (const [file, content] of writes) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.hy-memory-tmp`;
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, file);
  }
  return { version: 1, sha256: memoryIndexOverlayDigest() };
}
