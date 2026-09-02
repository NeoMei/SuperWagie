const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const ARTIFACT_REVISION_ID = /^artifact-sha256:[0-9a-f]{64}$/;
const PREVIEW_REVISION_ID = /^preview-sha256:[0-9a-f]{64}$/;
const REQUEST_ID = /^request-sha256:[0-9a-f]{64}$/;
const ANNOTATION_ID = /^annotation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAGE_ID = /^page-[1-9][0-9]{0,5}$/;
const CONTEXT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEMANTIC_OBJECT_ID = /^semantic-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANDIDATE_ID = /^candidate-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

declare const IDENTITY_BRAND: unique symbol;
type BrandedString<Name extends string> = string & { readonly [IDENTITY_BRAND]: Name };

export type ArtifactRevisionId = BrandedString<'ArtifactRevisionId'>;
export type PreviewRevisionId = BrandedString<'PreviewRevisionId'>;
export type RequestId = BrandedString<'RequestId'>;
export type AnnotationId = BrandedString<'AnnotationId'>;
export type PageId = BrandedString<'PageId'>;
export type ContextDigest = BrandedString<'ContextDigest'>;
export type SemanticObjectId = BrandedString<'SemanticObjectId'>;
export type CandidateId = BrandedString<'CandidateId'>;

function validateMachineIdentity<T extends string>(
  value: unknown,
  format: RegExp,
  label: string
): T {
  if (typeof value !== 'string' || !format.test(value)) throw new Error(`${label} is invalid`);
  return value as T;
}

function validateLowerSha256(value: unknown, label: string): string {
  return validateMachineIdentity(value, LOWER_SHA256, label);
}

export function validateArtifactRevisionId(value: unknown, label = 'artifactRevisionId'): ArtifactRevisionId {
  return validateMachineIdentity(value, ARTIFACT_REVISION_ID, label);
}

export function createArtifactRevisionId(sourceRevisionHash: unknown): ArtifactRevisionId {
  return validateArtifactRevisionId(
    `artifact-sha256:${validateLowerSha256(sourceRevisionHash, 'source revision hash')}`
  );
}

export function validatePreviewRevisionId(value: unknown, label = 'previewRevisionId'): PreviewRevisionId {
  return validateMachineIdentity(value, PREVIEW_REVISION_ID, label);
}

export function createPreviewRevisionId(contentHash: unknown): PreviewRevisionId {
  return validatePreviewRevisionId(
    `preview-sha256:${validateLowerSha256(contentHash, 'preview content hash')}`
  );
}

export function validateRequestId(value: unknown, label = 'requestId'): RequestId {
  return validateMachineIdentity(value, REQUEST_ID, label);
}

export function createRequestId(contentHash: unknown): RequestId {
  return validateRequestId(`request-sha256:${validateLowerSha256(contentHash, 'request content hash')}`);
}

export function validateAnnotationId(value: unknown, label = 'annotationId'): AnnotationId {
  return validateMachineIdentity(value, ANNOTATION_ID, label);
}

export function createAnnotationId(uuid: unknown): AnnotationId {
  return validateAnnotationId(`annotation-${validateMachineIdentity(uuid, UUID_V4, 'annotation UUID')}`);
}

export function validatePageId(value: unknown, label = 'pageId'): PageId {
  return validateMachineIdentity(value, PAGE_ID, label);
}

export function createPageId(pageNumber: unknown): PageId {
  if (!Number.isSafeInteger(pageNumber) || (pageNumber as number) < 1 || (pageNumber as number) > 999_999) {
    throw new Error('page number is invalid');
  }
  return validatePageId(`page-${pageNumber as number}`);
}

export function validateContextDigest(value: unknown, label = 'context digest'): ContextDigest {
  return validateMachineIdentity(value, CONTEXT_DIGEST, label);
}

export function createContextDigest(contentHash: unknown): ContextDigest {
  return validateContextDigest(`sha256:${validateLowerSha256(contentHash, 'context content hash')}`);
}

export function validateSemanticObjectId(value: unknown, label = 'semanticObjectId'): SemanticObjectId {
  return validateMachineIdentity(value, SEMANTIC_OBJECT_ID, label);
}

export function createSemanticObjectId(uuid: unknown): SemanticObjectId {
  return validateSemanticObjectId(
    `semantic-${validateMachineIdentity(uuid, UUID_V4, 'semantic object UUID')}`
  );
}

export function validateCandidateId(value: unknown, label = 'candidateId'): CandidateId {
  return validateMachineIdentity(value, CANDIDATE_ID, label);
}

export function createCandidateId(uuid: unknown): CandidateId {
  return validateCandidateId(`candidate-${validateMachineIdentity(uuid, UUID_V4, 'candidate UUID')}`);
}
