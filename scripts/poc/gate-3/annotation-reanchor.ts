import { createHash } from 'node:crypto';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import {
  createRequestId,
  validateAnnotationId,
  validateArtifactRevisionId,
  validateCandidateId,
  validateContextDigest,
  validatePageId,
  validatePreviewRevisionId,
  validateSemanticObjectId,
  type AnnotationId,
  type ArtifactRevisionId,
  type CandidateId,
  type ContextDigest,
  NormalizedBox,
  type PageId,
  PreviewFidelity,
  type PreviewRevisionId,
  type RequestId,
  type ReviewAnnotation,
  type SemanticObjectId
} from './review-contract';

const REQUEST_DRAFT_FIELDS = [
  'artifactRevisionId',
  'previewRevisionId',
  'annotationIds',
  'intent',
  'context'
] as const;
const INTENT_FIELDS = ['operation'] as const;
const CONTEXT_FIELDS = ['pageId', 'selectedText', 'bbox'] as const;
const COMPARISON_FIELDS = ['before', 'after'] as const;
const COMPARISON_SIDE_FIELDS = [
  'artifactRevisionId', 'previewRevisionId', 'fidelity', 'pageId', 'raster'
] as const;
const EDIT_INSTRUCTION = {
  'revise-selection': '修改所选批注内容',
  'replace-selection': '替换所选批注内容',
  'adjust-layout': '调整所选对象布局',
  'resolve-comment': '处理所选审阅批注'
} as const;
const PIXELMATCH_THRESHOLD = 0.1;
const SELECTED_TEXT_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const SELECTED_TEXT_DOMAIN = 'superwagie.review.selected-text.v1\0';
const ANNOTATION_FIELDS = [
  'annotationId', 'artifactRevisionId', 'previewRevisionId', 'fidelity',
  'pageId', 'bbox', 'selectedText', 'beforeContextHash', 'afterContextHash',
  'semanticObjectId', 'status'
] as const;
const CANDIDATE_FIELDS = [
  'candidateId', 'pageId', 'bbox', 'semanticObjectId', 'selectedText',
  'beforeContextHash', 'afterContextHash', 'imageFeatureScore'
] as const;
const TARGET_FIELDS = [
  'artifactRevisionId', 'previewRevisionId', 'fidelity', 'pageOrder', 'candidates'
] as const;

export type {
  AnnotationId,
  ArtifactRevisionId,
  CandidateId,
  ContextDigest,
  PageId,
  PreviewRevisionId,
  RequestId,
  SemanticObjectId
} from './review-contract';
export type SelectedTextFingerprint = ContextDigest;

export type RawReviewAnnotationInput = Omit<ReviewAnnotation, 'selectedText'> & {
  selectedText?: string;
};

export type PersistedReviewAnnotationRecord = Omit<ReviewAnnotation, 'selectedText'> & {
  selectedText?: SelectedTextFingerprint;
};

export type PersistedReviewAnnotation = Omit<
  ReviewAnnotation,
  | 'annotationId'
  | 'artifactRevisionId'
  | 'previewRevisionId'
  | 'pageId'
  | 'selectedText'
  | 'beforeContextHash'
  | 'afterContextHash'
  | 'semanticObjectId'
> & {
  annotationId: AnnotationId;
  artifactRevisionId: ArtifactRevisionId;
  previewRevisionId: PreviewRevisionId;
  pageId: PageId;
  selectedText?: SelectedTextFingerprint;
  beforeContextHash?: ContextDigest;
  afterContextHash?: ContextDigest;
  semanticObjectId?: SemanticObjectId;
};

export interface ReanchorCandidate {
  candidateId: string;
  pageId: string;
  bbox: NormalizedBox;
  semanticObjectId?: string;
  selectedText?: string;
  beforeContextHash?: string;
  afterContextHash?: string;
  imageFeatureScore?: number;
}

export interface ReanchorTarget {
  artifactRevisionId: string;
  previewRevisionId: string;
  fidelity: PreviewFidelity;
  pageOrder: string[];
  candidates: ReanchorCandidate[];
}

export interface ReanchorResult {
  status: 'resolved' | 'unresolved';
  method?: 'semantic' | 'text-context' | 'image-feature';
  confidence: number;
  pageId?: string;
  bbox?: NormalizedBox;
}

export interface AgentChangeRequestContext {
  pageId: PageId;
  bbox?: NormalizedBox;
}

export interface AgentChangeRequestDraftContext {
  pageId: string;
  bbox?: NormalizedBox;
  selectedText?: string;
}

export interface AgentChangeRequest {
  requestId: RequestId;
  artifactRevisionId: ArtifactRevisionId;
  previewRevisionId: PreviewRevisionId;
  annotationIds: AnnotationId[];
  instruction: string;
  context: AgentChangeRequestContext[];
}

export type AgentEditOperation = keyof typeof EDIT_INSTRUCTION;

export interface AgentChangeRequestDraft {
  artifactRevisionId: string;
  previewRevisionId: string;
  annotationIds: string[];
  intent: { operation: AgentEditOperation };
  context: AgentChangeRequestDraftContext[];
}

export interface EvidenceBundle {
  kind: 'agent-change-request' | 'page-visual-diff';
  bundleKey: string;
  directoryName: string;
  files: Record<string, Buffer>;
}

export interface PreparedAgentChangeRequest {
  status: 'prepared';
  label: '修改请求已准备';
  request: AgentChangeRequest;
  bundle: EvidenceBundle;
}

export interface RgbaRaster {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface PageDiffStatistics {
  changed_pixels: number;
  total_pixels: number;
  ratio: number;
}

export interface PageDiffResult extends PageDiffStatistics {
  comparisonKey: string;
  manifest: PageComparisonManifest;
  png: Buffer;
}

export interface PageComparisonSide {
  artifactRevisionId: string;
  previewRevisionId: string;
  fidelity: PreviewFidelity;
  pageId: string;
  raster: RgbaRaster;
}

export interface PageComparisonInput {
  before: PageComparisonSide;
  after: PageComparisonSide;
}

export interface PageComparisonManifestSide {
  artifactRevisionId: ArtifactRevisionId;
  previewRevisionId: PreviewRevisionId;
  fidelity: PreviewFidelity;
  pageId: PageId;
  width: number;
  height: number;
  rgbaSha256: string;
}

export interface PageComparisonManifest {
  schemaVersion: 1;
  comparisonKey: string;
  pageId: PageId;
  before: PageComparisonManifestSide;
  after: PageComparisonManifestSide;
  pixelmatchThreshold: number;
}

export interface PreparedPageVisualDiffBundle extends EvidenceBundle {
  kind: 'page-visual-diff';
  comparisonKey: string;
}

export function validateNormalizedBox(value: unknown): NormalizedBox {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('normalized bbox must contain four finite numbers');
  }
  const [x, y, width, height] = value;
  if (![x, y, width, height].every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error('normalized bbox values must be finite');
  }
  if (width <= 0 || height <= 0) {
    throw new Error('normalized bbox width and height must be positive');
  }
  if (x < 0 || y < 0 || x > 1 || y > 1 || width > 1 || height > 1) {
    throw new Error('normalized bbox values must be in normalized range');
  }
  if (x + width > 1 || y + height > 1) {
    throw new Error('normalized bbox exceeds page bounds');
  }
  return [x, y, width, height];
}

export function createReviewAnnotation(input: RawReviewAnnotationInput): PersistedReviewAnnotation {
  return normalizeReviewAnnotation(input, hashRawSelectedText);
}

export function rehydrateReviewAnnotation(
  input: PersistedReviewAnnotationRecord
): PersistedReviewAnnotation {
  return normalizeReviewAnnotation(input, validateSelectedTextFingerprint);
}

function normalizeReviewAnnotation(
  input: ReviewAnnotation,
  selectedTextNormalizer: (value: unknown) => SelectedTextFingerprint | undefined
): PersistedReviewAnnotation {
  assertNoUnknownFields(input as unknown as Record<string, unknown>, ANNOTATION_FIELDS, 'ReviewAnnotation');
  const annotationId = validateAnnotationId(input.annotationId, 'annotationId');
  const artifactRevisionId = validateArtifactRevisionId(input.artifactRevisionId, 'artifactRevisionId');
  const previewRevisionId = validatePreviewRevisionId(input.previewRevisionId, 'previewRevisionId');
  const pageId = validatePageId(input.pageId, 'pageId');
  const beforeContextHash = validateOptionalContextDigest(input.beforeContextHash, 'beforeContextHash');
  const afterContextHash = validateOptionalContextDigest(input.afterContextHash, 'afterContextHash');
  const semanticObjectId = validateOptionalSemanticObjectId(input.semanticObjectId, 'semanticObjectId');
  if (!['fast', 'authoritative'].includes(input.fidelity)) throw new Error('invalid fidelity');
  if (!['active', 'stale', 'unresolved'].includes(input.status)) throw new Error('invalid annotation status');
  const selectedText = selectedTextNormalizer(input.selectedText);
  const annotation: PersistedReviewAnnotation = {
    annotationId,
    artifactRevisionId,
    previewRevisionId,
    fidelity: input.fidelity,
    pageId,
    status: input.status
  };
  if (input.bbox !== undefined) annotation.bbox = validateNormalizedBox(input.bbox);
  if (selectedText !== undefined) annotation.selectedText = selectedText;
  if (beforeContextHash !== undefined) annotation.beforeContextHash = beforeContextHash;
  if (afterContextHash !== undefined) annotation.afterContextHash = afterContextHash;
  if (semanticObjectId !== undefined) annotation.semanticObjectId = semanticObjectId;
  return annotation;
}

export function reanchor(annotation: PersistedReviewAnnotation, target: ReanchorTarget): ReanchorResult {
  if (!isValidReanchorInput(annotation, target)) return unresolved();

  const semanticMatches = annotation.semanticObjectId === undefined
    ? []
    : target.candidates.filter((entry) => entry.semanticObjectId === annotation.semanticObjectId);
  const semantic = resolveUnique(semanticMatches, 'semantic', 1);
  if (semantic !== null) return semantic;

  const exactTextContextMatches = target.candidates.filter((entry) =>
    hasSelectedText(annotation, entry)
    && annotation.beforeContextHash !== undefined
    && annotation.afterContextHash !== undefined
    && entry.beforeContextHash === annotation.beforeContextHash
    && entry.afterContextHash === annotation.afterContextHash
  );
  const exactTextContext = resolveUnique(exactTextContextMatches, 'text-context', 0.95);
  if (exactTextContext !== null) return exactTextContext;

  const sourcePageIndex = target.pageOrder.indexOf(annotation.pageId);
  const adjacentTextMatches = target.candidates.filter((entry) => {
    const candidatePageIndex = target.pageOrder.indexOf(entry.pageId);
    const beforeMatches = annotation.beforeContextHash !== undefined
      && entry.beforeContextHash === annotation.beforeContextHash;
    const afterMatches = annotation.afterContextHash !== undefined
      && entry.afterContextHash === annotation.afterContextHash;
    return hasSelectedText(annotation, entry)
      && Math.abs(candidatePageIndex - sourcePageIndex) <= 1
      && (beforeMatches || afterMatches);
  });
  const adjacentText = resolveUnique(adjacentTextMatches, 'text-context', 0.85);
  if (adjacentText !== null) return adjacentText;

  const imageMatches = target.candidates.filter((entry) =>
    entry.pageId === annotation.pageId
    && entry.imageFeatureScore !== undefined
    && entry.imageFeatureScore >= 0.9
  );
  if (imageMatches.length === 0) return unresolved();
  const bestScore = Math.max(...imageMatches.map((entry) => entry.imageFeatureScore ?? 0));
  const best = imageMatches.filter((entry) => entry.imageFeatureScore === bestScore);
  return best.length === 1
    ? resolved(best[0]!, 'image-feature', bestScore)
    : unresolved();
}

export function prepareAgentChangeRequest(draft: AgentChangeRequestDraft): PreparedAgentChangeRequest {
  const request = normalizeAgentChangeRequest(draft);
  const bytes = canonicalJsonBytes(request);
  const bundleKey = sha256Hex(bytes);
  return {
    status: 'prepared',
    label: '修改请求已准备',
    request,
    bundle: {
      kind: 'agent-change-request',
      bundleKey,
      directoryName: `request-${bundleKey}`,
      files: { 'agent-change-request.json': bytes }
    }
  };
}

export function comparePageRasters(input: PageComparisonInput): PageDiffResult {
  const { before, after } = validatePageComparison(input);
  if (before.raster.width !== after.raster.width || before.raster.height !== after.raster.height) {
    throw new Error('page raster dimensions must match exactly');
  }
  const expectedLength = validateRasterShape(before.raster);
  const afterLength = validateRasterShape(after.raster);
  if (expectedLength !== afterLength) throw new Error('page raster buffer length mismatch');

  const diff = Buffer.alloc(expectedLength);
  const changedPixels = pixelmatch(
    before.raster.data,
    after.raster.data,
    diff,
    before.raster.width,
    before.raster.height,
    { threshold: PIXELMATCH_THRESHOLD }
  );
  const totalPixels = before.raster.width * before.raster.height;
  const ratio = changedPixels / totalPixels;
  if (!Number.isFinite(ratio)) throw new Error('page raster ratio is not finite');
  const png = new PNG({ width: before.raster.width, height: before.raster.height });
  png.data = diff;
  const identity = comparisonIdentity(before, after);
  const comparisonKey = sha256Hex(canonicalJsonBytes(identity));
  const manifest: PageComparisonManifest = {
    schemaVersion: 1,
    comparisonKey,
    pageId: identity.pageId,
    before: identity.before,
    after: identity.after,
    pixelmatchThreshold: PIXELMATCH_THRESHOLD
  };
  return {
    changed_pixels: changedPixels,
    total_pixels: totalPixels,
    ratio,
    comparisonKey,
    manifest,
    png: PNG.sync.write(png)
  };
}

export function createPageVisualDiffBundle(input: PageComparisonInput): PreparedPageVisualDiffBundle {
  const { png, comparisonKey, manifest, ...statistics } = comparePageRasters(input);
  return {
    kind: 'page-visual-diff',
    comparisonKey,
    bundleKey: comparisonKey,
    directoryName: `comparison-${comparisonKey}`,
    files: {
      'diff.png': png,
      'diff-stats.json': canonicalJsonBytes(statistics),
      'comparison-manifest.json': canonicalJsonBytes(manifest)
    }
  };
}

function isValidReanchorInput(annotation: PersistedReviewAnnotation, target: ReanchorTarget): boolean {
  try {
    rehydrateReviewAnnotation(annotation);
    assertNoUnknownFields(target as unknown as Record<string, unknown>, TARGET_FIELDS, 'ReanchorTarget');
    validateArtifactRevisionId(target.artifactRevisionId, 'artifactRevisionId');
    validatePreviewRevisionId(target.previewRevisionId, 'previewRevisionId');
    if (!['fast', 'authoritative'].includes(target.fidelity)) return false;
    if (!Array.isArray(target.pageOrder) || target.pageOrder.length === 0) return false;
    const pageIds = new Set<string>();
    for (const pageId of target.pageOrder) {
      validatePageId(pageId, 'pageId');
      if (pageIds.has(pageId)) return false;
      pageIds.add(pageId);
    }
    if (!pageIds.has(annotation.pageId) || !Array.isArray(target.candidates)) return false;
    const candidateIds = new Set<string>();
    for (const entry of target.candidates) {
      assertNoUnknownFields(entry as unknown as Record<string, unknown>, CANDIDATE_FIELDS, 'ReanchorCandidate');
      validateCandidateId(entry.candidateId, 'candidateId');
      validatePageId(entry.pageId, 'pageId');
      if (!pageIds.has(entry.pageId) || candidateIds.has(entry.candidateId)) return false;
      candidateIds.add(entry.candidateId);
      validateNormalizedBox(entry.bbox);
      validateOptionalSemanticObjectId(entry.semanticObjectId, 'semanticObjectId');
      validateOptionalContextDigest(entry.beforeContextHash, 'beforeContextHash');
      validateOptionalContextDigest(entry.afterContextHash, 'afterContextHash');
      hashRawSelectedText(entry.selectedText);
      if (entry.imageFeatureScore !== undefined
        && (!Number.isFinite(entry.imageFeatureScore)
          || entry.imageFeatureScore < 0
          || entry.imageFeatureScore > 1)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function resolveUnique(
  matches: ReanchorCandidate[],
  method: 'semantic' | 'text-context',
  confidence: number
): ReanchorResult | null {
  if (matches.length === 0) return null;
  return matches.length === 1 ? resolved(matches[0]!, method, confidence) : unresolved();
}

function resolved(
  candidate: ReanchorCandidate,
  method: 'semantic' | 'text-context' | 'image-feature',
  confidence: number
): ReanchorResult {
  return {
    status: 'resolved',
    method,
    confidence,
    pageId: candidate.pageId,
    bbox: [...candidate.bbox]
  };
}

function unresolved(): ReanchorResult {
  return { status: 'unresolved', confidence: 0 };
}

function hasSelectedText(annotation: PersistedReviewAnnotation, candidate: ReanchorCandidate): boolean {
  return annotation.selectedText !== undefined
    && SELECTED_TEXT_FINGERPRINT.test(annotation.selectedText)
    && hashRawSelectedText(candidate.selectedText) === annotation.selectedText;
}

function normalizeAgentChangeRequest(draft: AgentChangeRequestDraft): AgentChangeRequest {
  assertExactFields(draft as unknown as Record<string, unknown>, REQUEST_DRAFT_FIELDS, 'AgentChangeRequestDraft');
  const artifactRevisionId = validateArtifactRevisionId(draft.artifactRevisionId, 'artifactRevisionId');
  const previewRevisionId = validatePreviewRevisionId(draft.previewRevisionId, 'previewRevisionId');
  if (!Array.isArray(draft.annotationIds) || draft.annotationIds.length === 0) {
    throw new Error('annotationIds must be a non-empty array');
  }
  const annotationIds = draft.annotationIds.map((id) => {
    return validateAnnotationId(id, 'annotationId');
  });
  if (new Set(annotationIds).size !== annotationIds.length) throw new Error('annotationIds must be unique');
  assertExactFields(draft.intent as unknown as Record<string, unknown>, INTENT_FIELDS, 'intent');
  if (typeof draft.intent.operation !== 'string'
    || !Object.hasOwn(EDIT_INSTRUCTION, draft.intent.operation)) {
    throw new Error('intent operation is not allowlisted');
  }
  const instruction = EDIT_INSTRUCTION[draft.intent.operation];
  if (!/^[\u4e00-\u9fff]+$/.test(instruction)) throw new Error('generated instruction is invalid');
  if (!Array.isArray(draft.context) || draft.context.length === 0) {
    throw new Error('context must be a non-empty array');
  }
  const context = draft.context.map((entry) => {
    assertExactFields(entry as unknown as Record<string, unknown>, CONTEXT_FIELDS, 'context');
    const pageId = validatePageId(entry.pageId, 'pageId');
    const normalized: AgentChangeRequestContext = { pageId };
    if (entry.bbox !== undefined) normalized.bbox = validateNormalizedBox(entry.bbox);
    return normalized;
  });
  const requestSeed = {
    schemaVersion: 1,
    artifactRevisionId,
    previewRevisionId,
    annotationIds,
    instruction,
    context
  };
  const requestId = createRequestId(sha256Hex(canonicalJsonBytes(requestSeed)));
  return {
    requestId,
    artifactRevisionId,
    previewRevisionId,
    annotationIds,
    instruction,
    context
  };
}

function validatePageComparison(input: PageComparisonInput): PageComparisonInput {
  assertExactFields(input as unknown as Record<string, unknown>, COMPARISON_FIELDS, 'PageComparisonInput');
  for (const [label, side] of [['before', input.before], ['after', input.after]] as const) {
    assertExactFields(side as unknown as Record<string, unknown>, COMPARISON_SIDE_FIELDS, label);
    validateArtifactRevisionId(side.artifactRevisionId, `${label} artifactRevisionId`);
    validatePreviewRevisionId(side.previewRevisionId, `${label} previewRevisionId`);
    validatePageId(side.pageId, `${label} pageId`);
    if (!['fast', 'authoritative'].includes(side.fidelity)) throw new Error(`${label} fidelity is invalid`);
  }
  if (input.before.pageId !== input.after.pageId) throw new Error('before and after pageId must match');
  if (input.before.previewRevisionId === input.after.previewRevisionId) {
    throw new Error('before and after Preview Revision IDs must differ');
  }
  if (input.after.fidelity !== 'authoritative') {
    throw new Error('after comparison fidelity must be authoritative');
  }
  if (input.before.fidelity === 'fast'
    && input.before.artifactRevisionId !== input.after.artifactRevisionId) {
    throw new Error('fast comparison must remain within one Artifact Revision');
  }
  return input;
}

function comparisonIdentity(before: PageComparisonSide, after: PageComparisonSide): Omit<PageComparisonManifest, 'comparisonKey'> {
  return {
    schemaVersion: 1,
    pageId: validatePageId(before.pageId, 'pageId'),
    before: comparisonSideIdentity(before),
    after: comparisonSideIdentity(after),
    pixelmatchThreshold: PIXELMATCH_THRESHOLD
  };
}

function comparisonSideIdentity(side: PageComparisonSide): PageComparisonManifestSide {
  return {
    artifactRevisionId: validateArtifactRevisionId(side.artifactRevisionId, 'artifactRevisionId'),
    previewRevisionId: validatePreviewRevisionId(side.previewRevisionId, 'previewRevisionId'),
    fidelity: side.fidelity,
    pageId: validatePageId(side.pageId, 'pageId'),
    width: side.raster.width,
    height: side.raster.height,
    rgbaSha256: sha256Hex(side.raster.data)
  };
}

function assertExactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertNoUnknownFields(value, allowed, label);
  const missing = allowed.filter((field) => !Object.hasOwn(value, field))
    .filter((field) => !['selectedText', 'bbox'].includes(field));
  if (missing.length > 0) throw new Error(`${label} is missing field: ${missing.join(', ')}`);
}

function assertNoUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) throw new Error(`${label} has unknown field: ${unknown.join(', ')}`);
}

function validateOptionalContextDigest(
  value: unknown,
  label: string
): ContextDigest | undefined {
  return value === undefined ? undefined : validateContextDigest(value, label);
}

function validateOptionalSemanticObjectId(
  value: unknown,
  label: string
): SemanticObjectId | undefined {
  return value === undefined ? undefined : validateSemanticObjectId(value, label);
}

function hashRawSelectedText(value: unknown): SelectedTextFingerprint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 64 * 1024) {
    throw new Error('selectedText is invalid');
  }
  return validateContextDigest(`sha256:${createHash('sha256')
    .update(SELECTED_TEXT_DOMAIN, 'utf8')
    .update(value, 'utf8')
    .digest('hex')}`, 'selectedText fingerprint');
}

function validateSelectedTextFingerprint(value: unknown): SelectedTextFingerprint | undefined {
  if (value === undefined) return undefined;
  try {
    return validateContextDigest(value, 'selectedText fingerprint');
  } catch {
    throw new Error('selectedText fingerprint is invalid');
  }
}

function validateRasterShape(raster: RgbaRaster): number {
  if (!Number.isSafeInteger(raster.width)
    || !Number.isSafeInteger(raster.height)
    || raster.width <= 0
    || raster.height <= 0) {
    throw new Error('page raster dimensions must be positive integers');
  }
  const pixels = raster.width * raster.height;
  if (!Number.isSafeInteger(pixels) || pixels > Math.floor(Number.MAX_SAFE_INTEGER / 4)) {
    throw new Error('page raster dimensions overflow RGBA length');
  }
  const expectedLength = pixels * 4;
  if (!(raster.data instanceof Uint8Array) || raster.data.byteLength !== expectedLength) {
    throw new Error('page raster buffer length does not match dimensions');
  }
  return expectedLength;
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function sha256Hex(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
