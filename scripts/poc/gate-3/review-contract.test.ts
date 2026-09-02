import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  createAnnotationId,
  createArtifactRevisionId,
  createCandidateId,
  createContextDigest,
  createPageId,
  createPreviewRevision,
  createSemanticObjectId,
  validateAnnotationId,
  validateArtifactRevisionId,
  validateCandidateId,
  validateContextDigest,
  validatePageId,
  validatePreviewRevisionId,
  validateSemanticObjectId
} from './review-contract';

const SOURCE_REVISION_HASH = '11'.repeat(32);
const ARTIFACT_REVISION_ID = `artifact-sha256:${SOURCE_REVISION_HASH}`;

describe('PreviewRevision', () => {
  it('rejects authoritative revisions without renderer environment identity', () => {
    expect(() => createPreviewRevision({
      artifactRevisionId: ARTIFACT_REVISION_ID, fidelity: 'authoritative',
      rendererId: 'wps-pdf', rendererVersion: '12.1',
      rendererEnvironmentHash: '', fontEnvironmentHash: 'font-hash',
      sourceContentHash: 'source-hash', pageManifestHash: 'pages-hash'
    })).toThrow('rendererEnvironmentHash');
  });

  it('does not allow fast_ready to become accepted', () => {
    expect(() => assertTransition('fast_ready', 'accepted')).toThrow('invalid preview transition');
  });

  it('tags canonical preview digests as machine preview revision identities', () => {
    const revision = createPreviewRevision({
      artifactRevisionId: ARTIFACT_REVISION_ID, fidelity: 'authoritative',
      rendererId: 'wps-pdf', rendererVersion: '12.1',
      rendererEnvironmentHash: 'environment-hash', fontEnvironmentHash: 'font-hash',
      sourceContentHash: 'source-hash', pageManifestHash: 'pages-hash'
    });

    expect(revision.previewRevisionId).toMatch(/^preview-sha256:[0-9a-f]{64}$/);
    expect(revision.artifactRevisionId).toBe(ARTIFACT_REVISION_ID);
  });

  it('rejects an untagged Artifact Revision instead of transporting it into a preview', () => {
    expect(() => createPreviewRevision({
      artifactRevisionId: SOURCE_REVISION_HASH, fidelity: 'authoritative',
      rendererId: 'wps-pdf', rendererVersion: '12.1',
      rendererEnvironmentHash: 'environment-hash', fontEnvironmentHash: 'font-hash',
      sourceContentHash: 'source-hash', pageManifestHash: 'pages-hash'
    })).toThrow('artifactRevisionId');
  });

  it('tags only a validated lowercase source revision hash as an Artifact Revision', () => {
    expect(createArtifactRevisionId(SOURCE_REVISION_HASH)).toBe(ARTIFACT_REVISION_ID);
    expect(() => createArtifactRevisionId('AA'.repeat(32))).toThrow('source revision hash');
    expect(() => createArtifactRevisionId(`sha256:${SOURCE_REVISION_HASH}`)).toThrow('source revision hash');
  });

  it('shares exact field-specific identity factories and validators', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    expect(validateArtifactRevisionId(ARTIFACT_REVISION_ID)).toBe(ARTIFACT_REVISION_ID);
    expect(validatePreviewRevisionId(`preview-sha256:${'22'.repeat(32)}`))
      .toBe(`preview-sha256:${'22'.repeat(32)}`);
    expect(createAnnotationId(uuid)).toBe(`annotation-${uuid}`);
    expect(createPageId(42)).toBe('page-42');
    expect(createContextDigest('33'.repeat(32))).toBe(`sha256:${'33'.repeat(32)}`);
    expect(createSemanticObjectId(uuid)).toBe(`semantic-${uuid}`);
    expect(createCandidateId(uuid)).toBe(`candidate-${uuid}`);
  });

  it.each([
    'OpenAI-gpt-5',
    'sk-proj-1234567890abcdef',
    '/private/tmp/review.docx',
    '44'.repeat(32),
    'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo'
  ])('rejects sensitive transport probe %s from every shared identity validator', (probe) => {
    expect(() => validateArtifactRevisionId(probe)).toThrow();
    expect(() => validatePreviewRevisionId(probe)).toThrow();
    expect(() => validateAnnotationId(probe)).toThrow();
    expect(() => validatePageId(probe)).toThrow();
    expect(() => validateContextDigest(probe)).toThrow();
    expect(() => validateSemanticObjectId(probe)).toThrow();
    expect(() => validateCandidateId(probe)).toThrow();
  });
});
