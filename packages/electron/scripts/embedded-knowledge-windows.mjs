import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { knowledgeGitEnv } from './embedded-knowledge-git-env.mjs';

const upstreamCommit = '304f40cd564ab11f08123ecc70839e09143629ca';
const target = 'x86_64-pc-windows-gnu';
const patchUrl = new URL('./embedded-knowledge-windows-gnu.patch', import.meta.url);
const readPatch = () => fs.readFileSync(patchUrl, 'utf8').replace(/\r\n/g, '\n');

export function knowledgeBuildEnv(platform = process.platform, inherited = process.env) {
  const env = { ...inherited, EDITION: 'lite', CGO_ENABLED: '1' };
  if (platform === 'win32') env.TARGET = target;
  if (platform === 'darwin') {
    env.CGO_CFLAGS = inherited.CGO_CFLAGS || '-Wno-deprecated-declarations';
    env.CGO_LDFLAGS = inherited.CGO_LDFLAGS || '-Wl,-no_warn_duplicate_libraries';
  }
  return env;
}

export function knowledgeBuildEnvForTarget(platform, inherited, architecture) {
  const supported = {
    darwin: { x64: ['amd64', 'x86_64-apple-darwin'], arm64: ['arm64', 'aarch64-apple-darwin'] },
    linux: { x64: ['amd64', 'x86_64-unknown-linux-gnu'], arm64: ['arm64', 'aarch64-unknown-linux-gnu'] },
    win32: { x64: ['amd64', 'x86_64-pc-windows-gnu'] },
  };
  const target = supported[platform]?.[architecture];
  if (!target) throw new Error(`Unsupported embedded-knowledge target ${platform}/${architecture}`);
  const [goArch, rustTarget] = target;
  const goOs = platform === 'win32' ? 'windows' : platform;
  for (const [key, expected] of Object.entries({ GOOS: goOs, GOARCH: goArch })) {
    if (inherited[key] && inherited[key] !== expected) throw new Error(`${key} conflicts with embedded-knowledge target ${platform}/${architecture}`);
  }
  if (platform !== 'win32' && inherited.TARGET && inherited.TARGET !== rustTarget) throw new Error(`TARGET conflicts with embedded-knowledge target ${platform}/${architecture}`);
  const env = { ...knowledgeBuildEnv(platform, inherited), GOOS: goOs, GOARCH: goArch, TARGET: rustTarget };
  if (platform === 'darwin' && !env.CC) env.CC = `clang -arch ${architecture === 'x64' ? 'x86_64' : 'arm64'}`;
  return env;
}

export function windowsPatchIdentity(platform = process.platform) {
  if (platform !== 'win32') return null;
  return {
    target,
    sha256: crypto.createHash('sha256').update(readPatch()).digest('hex'),
  };
}

export function matchesWindowsKnowledgePatch(manifest, platform = process.platform) {
  const expected = windowsPatchIdentity(platform);
  return expected === null || (
    manifest?.windowsPatch?.target === expected.target &&
    manifest?.windowsPatch?.sha256 === expected.sha256
  );
}

// Whole-file Git blob identities reject edits outside the patch's context too.
// Normalize CRLF so a Windows checkout and Git's LF blobs have the same identity.
function blobId(file) {
  const content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
}

export function isVerifiedWindowsKnowledgePatch(sourceDir) {
  try {
    const files = [...readPatch().matchAll(/^diff --git a\/(\S+) b\/\1\nindex ([a-f0-9]{40})\.\.([a-f0-9]{40}) /gm)];
    return files.length === 2 && files.every(([, file, , after]) => blobId(path.join(sourceDir, file)) === after);
  } catch { return false; }
}

export function applyWindowsKnowledgePatch(sourceDir, commit, platform = process.platform) {
  if (platform !== 'win32') return null;
  if (commit !== upstreamCommit) {
    throw new Error(`Windows knowledge patch requires ${upstreamCommit}; found ${commit}. Review the patch for this source.`);
  }

  const patch = readPatch();
  const files = [...patch.matchAll(/^diff --git a\/(\S+) b\/\1\nindex ([a-f0-9]{40})\.\.([a-f0-9]{40}) /gm)];
  if (files.length !== 2) throw new Error('Windows knowledge patch must identify both complete upstream files');
  const states = files.map(([, file, before, after]) => {
    const actual = blobId(path.join(sourceDir, file));
    if (actual === before) return 'original';
    if (actual === after) return 'patched';
    throw new Error(`Windows knowledge patch source mismatch: ${file}. Preserve the edits and review them before building.`);
  });
  if (states.every((state) => state === 'patched')) return windowsPatchIdentity(platform);
  if (!states.every((state) => state === 'original')) {
    throw new Error('Windows knowledge patch source mismatch: partially patched source; review before building');
  }

  // Never reset, checkout, or reverse a user's source tree. Git checks all hunks
  // before writing; unknown or partially patched files fail above without writes.
  for (const args of [['apply', '--check', '--ignore-space-change', '-'], ['apply', '--ignore-space-change', '-']]) {
    const result = spawnSync('git', args, {
      cwd: sourceDir, input: patch, encoding: 'utf8', windowsHide: true, env: knowledgeGitEnv(),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Windows knowledge patch failed: ${result.stderr || result.stdout}`);
  }
  for (const [, file, , after] of files) {
    if (blobId(path.join(sourceDir, file)) !== after) {
      throw new Error(`Windows knowledge patch result mismatch: ${file}`);
    }
  }
  return windowsPatchIdentity(platform);
}
