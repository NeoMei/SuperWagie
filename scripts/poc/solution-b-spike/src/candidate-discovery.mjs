import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runtimePlatform } from './runtime-platform.mjs';

function validateCandidateRoot(candidate, platform) {
  const rootMetadata = lstatSync(candidate);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('CANDIDATE_ROOT_UNSAFE');
  const manifestPath = join(candidate, 'runtime-manifest.json');
  const manifestMetadata = lstatSync(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) throw new Error('CANDIDATE_MANIFEST_UNSAFE');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.platform !== platform.id) throw new Error(`CANDIDATE_PLATFORM_MISMATCH:${manifest.platform ?? 'missing'}`);
  return candidate;
}

export function findCandidateRoot(repositoryRoot, explicit = process.env.SUPERWAGIE_CANDIDATE_ROOT) {
  const platform = runtimePlatform();
  if (explicit) return validateCandidateRoot(resolve(explicit), platform);
  const evidenceRoot = join(repositoryRoot, 'evidence', 'gate-0');
  if (!existsSync(evidenceRoot)) throw new Error(`CANDIDATE_NOT_BUILT_FOR_PLATFORM:${platform.id}`);
  const candidates = readdirSync(evidenceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('solution-b-v1-'))
    .map((entry) => join(evidenceRoot, entry.name, 'candidate-root'))
    .filter((candidate) => {
      try { validateCandidateRoot(candidate, platform); return true; }
      catch { return false; }
    })
    .sort((left, right) => statSync(dirname(right)).mtimeMs - statSync(dirname(left)).mtimeMs);
  if (!candidates.length) throw new Error(`CANDIDATE_NOT_BUILT_FOR_PLATFORM:${platform.id}`);
  return validateCandidateRoot(candidates[0], platform);
}

export function actualResultForCandidate(candidateRoot) {
  const result = join(dirname(candidateRoot), 'raw-run', 'actual-electron-result.json');
  if (!existsSync(result)) throw new Error('CANDIDATE_ACTUAL_RESULT_MISSING');
  return result;
}
