import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ReviewAnnotation } from './review-contract';
import {
  comparePageRasters,
  createPageVisualDiffBundle,
  createReviewAnnotation,
  prepareAgentChangeRequest,
  reanchor,
  rehydrateReviewAnnotation,
  validateNormalizedBox,
  type AgentChangeRequestDraft,
  type PageComparisonInput,
  type PersistedReviewAnnotation,
  type PersistedReviewAnnotationRecord,
  type ReanchorCandidate,
  type ReanchorTarget
} from './annotation-reanchor';

const BOX = [0.1, 0.2, 0.3, 0.25] as const;
const ARTIFACT_1 = `artifact-sha256:${'a'.repeat(64)}`;
const ARTIFACT_2 = `artifact-sha256:${'b'.repeat(64)}`;
const PREVIEW_FAST = `preview-sha256:${'1'.repeat(64)}`;
const PREVIEW_TRUTH = `preview-sha256:${'2'.repeat(64)}`;
const PREVIEW_OTHER = `preview-sha256:${'3'.repeat(64)}`;
const ANNOTATION_1 = 'annotation-11111111-1111-4111-8111-111111111111';
const SEMANTIC_7 = 'semantic-77777777-7777-4777-8777-777777777777';
const SEMANTIC_OTHER = 'semantic-88888888-8888-4888-8888-888888888888';
const CONTEXT_BEFORE = `sha256:${'c'.repeat(64)}`;
const CONTEXT_AFTER = `sha256:${'d'.repeat(64)}`;
const CONTEXT_DIFFERENT = `sha256:${'e'.repeat(64)}`;

function candidateId(index: number): string {
  return `candidate-00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

function annotation(overrides: Partial<ReviewAnnotation> = {}): PersistedReviewAnnotation {
  return createReviewAnnotation({
    annotationId: ANNOTATION_1,
    artifactRevisionId: ARTIFACT_1,
    previewRevisionId: PREVIEW_FAST,
    fidelity: 'fast',
    pageId: 'page-2',
    bbox: [...BOX],
    selectedText: '季度目标',
    beforeContextHash: CONTEXT_BEFORE,
    afterContextHash: CONTEXT_AFTER,
    semanticObjectId: SEMANTIC_7,
    status: 'active',
    ...overrides
  });
}

const QUARTER_GOAL_FINGERPRINT = 'sha256:a003d6d80f24f5e8d508084f973103ea0e91e9ec6411383d9f9cb9437f44c916';

function candidate(overrides: Partial<ReanchorCandidate> = {}): ReanchorCandidate {
  return {
    candidateId: candidateId(1),
    pageId: 'page-2',
    bbox: [0.2, 0.3, 0.4, 0.1],
    ...overrides
  };
}

function target(candidates: ReanchorCandidate[], overrides: Partial<ReanchorTarget> = {}): ReanchorTarget {
  return {
    artifactRevisionId: ARTIFACT_2,
    previewRevisionId: PREVIEW_TRUTH,
    fidelity: 'authoritative',
    pageOrder: ['page-1', 'page-2', 'page-3', 'page-4'],
    candidates,
    ...overrides
  };
}

describe('normalized annotation boxes', () => {
  it('accepts finite positive boxes wholly inside normalized page space', () => {
    expect(validateNormalizedBox([0, 0, 1, 1])).toEqual([0, 0, 1, 1]);
    expect(validateNormalizedBox([...BOX])).toEqual([...BOX]);
  });

  it('rejects annotation fields outside the public path-free schema', () => {
    expect(() => createReviewAnnotation({
      ...annotation(),
      sourcePath: '/Users/example/private.docx'
    } as ReviewAnnotation)).toThrow('unknown field');
  });

  it.each([
    [[0, 0, 0, 1], 'positive'],
    [[0, 0, 1, 0], 'positive'],
    [[-0.1, 0, 0.2, 0.2], 'normalized'],
    [[0, 1.1, 0.2, 0.2], 'normalized'],
    [[0.8, 0, 0.3, 0.2], 'bounds'],
    [[0, 0.9, 0.2, 0.2], 'bounds'],
    [[Number.NaN, 0, 0.2, 0.2], 'finite'],
    [[0, Number.POSITIVE_INFINITY, 0.2, 0.2], 'finite'],
    [[0, 0, 0.2], 'four finite numbers']
  ])('rejects invalid box %j', (box, message) => {
    expect(() => validateNormalizedBox(box)).toThrow(message);
  });
});

describe('deterministic annotation re-anchoring', () => {
  it('normalizes selected text immediately to a domain-separated opaque fingerprint', () => {
    const stored = annotation();
    expect(stored.selectedText).toBe(QUARTER_GOAL_FINGERPRINT);
    expect(rehydrateReviewAnnotation(stored).selectedText).toBe(QUARTER_GOAL_FINGERPRINT);
    expect(JSON.stringify(stored)).not.toContain('季度目标');
  });

  it('always hashes literal fingerprint-looking raw text at capture', () => {
    const literal = `sha256:${'0'.repeat(64)}`;
    const stored = annotation({ selectedText: literal });

    expect(stored.selectedText).toBe(
      'sha256:2a8b4b7c878467883b9350d4cd0ecee0568f4da3b5c6f3d220ace95057a5e83f'
    );
    expect(stored.selectedText).not.toBe(literal);
    expect(rehydrateReviewAnnotation(stored)).toEqual(stored);
    if (false) {
      // @ts-expect-error persisted rehydration cannot accept raw selected text
      rehydrateReviewAnnotation({ ...stored, selectedText: '季度目标' });
    }
    expect(() => rehydrateReviewAnnotation({
      ...stored, selectedText: '季度目标'
    } as unknown as PersistedReviewAnnotationRecord)).toThrow('selectedText fingerprint');
  });

  it('does not let a raw forged digest resolve unrelated candidate text', () => {
    const forged = 'sha256:b230b0bea78b8cb14623db1df1ae60da017f36bf756eb8a35ac233eaea980225';
    const source = annotation({
      semanticObjectId: undefined,
      selectedText: forged
    });

    expect(source.selectedText).toBe(
      'sha256:8eab33bf76744072f878a54e9e2eee156b8a6af56c0f5221a63e921219d0f897'
    );
    expect(reanchor(source, target([candidate({
      selectedText: 'attacker-chosen-target',
      beforeContextHash: CONTEXT_BEFORE,
      afterContextHash: CONTEXT_AFTER
    })]))).toEqual({ status: 'unresolved', confidence: 0 });
  });

  it('prefers exact semantic identity over lower-priority coordinate or text matches', () => {
    const result = reanchor(annotation(), target([
      candidate({
        candidateId: candidateId(2),
        semanticObjectId: SEMANTIC_OTHER,
        selectedText: '季度目标',
        beforeContextHash: CONTEXT_BEFORE,
        afterContextHash: CONTEXT_AFTER
      }),
      candidate({
        candidateId: candidateId(3),
        pageId: 'page-4',
        semanticObjectId: SEMANTIC_7,
        bbox: [0.4, 0.4, 0.1, 0.1]
      })
    ]));

    expect(result).toEqual({
      status: 'resolved', method: 'semantic', confidence: 1,
      pageId: 'page-4', bbox: [0.4, 0.4, 0.1, 0.1]
    });
  });

  it('resolves exact selected text with both context hashes at 0.95', () => {
    const result = reanchor(annotation({ semanticObjectId: undefined }), target([
      candidate({
        pageId: 'page-4', selectedText: '季度目标',
        beforeContextHash: CONTEXT_BEFORE, afterContextHash: CONTEXT_AFTER
      })
    ]));

    expect(result).toEqual({
      status: 'resolved', method: 'text-context', confidence: 0.95,
      pageId: 'page-4', bbox: [0.2, 0.3, 0.4, 0.1]
    });
  });

  it('hashes ephemeral candidate text before matching a persisted fingerprint', () => {
    const secret = '任意 Unicode 🔐\u0000raw-secret-值';
    const source = annotation({
      semanticObjectId: undefined,
      selectedText: secret,
      beforeContextHash: CONTEXT_BEFORE,
      afterContextHash: CONTEXT_AFTER
    });
    expect(source.selectedText).toBe('sha256:b71e4260c9f9d04fdaa009672abd5d109826679b63968d53237440d508fc4df2');
    expect(reanchor(source, target([candidate({
      selectedText: secret,
      beforeContextHash: CONTEXT_BEFORE,
      afterContextHash: CONTEXT_AFTER
    })]))).toMatchObject({ status: 'resolved', method: 'text-context', confidence: 0.95 });
    expect(reanchor(source, target([candidate({
      selectedText: `${secret}-different`,
      beforeContextHash: CONTEXT_BEFORE,
      afterContextHash: CONTEXT_AFTER
    })]))).toEqual({ status: 'unresolved', confidence: 0 });
  });

  it('resolves selected text with exactly one context hash on an adjacent page at 0.85', () => {
    const result = reanchor(annotation({ semanticObjectId: undefined }), target([
      candidate({
        pageId: 'page-3', selectedText: '季度目标',
        beforeContextHash: CONTEXT_BEFORE, afterContextHash: CONTEXT_DIFFERENT
      })
    ]));

    expect(result).toEqual({
      status: 'resolved', method: 'text-context', confidence: 0.85,
      pageId: 'page-3', bbox: [0.2, 0.3, 0.4, 0.1]
    });
  });

  it('accepts an image feature only on the same page and at the inclusive 0.90 boundary', () => {
    const source = annotation({
      semanticObjectId: undefined,
      selectedText: undefined,
      beforeContextHash: undefined,
      afterContextHash: undefined
    });
    expect(reanchor(source, target([
      candidate({ imageFeatureScore: 0.9 })
    ]))).toMatchObject({ status: 'resolved', method: 'image-feature', confidence: 0.9 });
    expect(reanchor(source, target([
      candidate({ imageFeatureScore: 0.899999 })
    ]))).toEqual({ status: 'unresolved', confidence: 0 });
    expect(reanchor(source, target([
      candidate({ pageId: 'page-3', imageFeatureScore: 1 })
    ]))).toEqual({ status: 'unresolved', confidence: 0 });
  });

  it('marks duplicate equal-best candidates unresolved regardless of input order', () => {
    const source = annotation({ semanticObjectId: undefined });
    const candidates = [
      candidate({ candidateId: candidateId(4), pageId: 'page-1', selectedText: '季度目标', beforeContextHash: CONTEXT_BEFORE, afterContextHash: CONTEXT_AFTER }),
      candidate({ candidateId: candidateId(5), pageId: 'page-4', selectedText: '季度目标', beforeContextHash: CONTEXT_BEFORE, afterContextHash: CONTEXT_AFTER })
    ];

    expect(reanchor(source, target(candidates))).toEqual({ status: 'unresolved', confidence: 0 });
    expect(reanchor(source, target([...candidates].reverse()))).toEqual({ status: 'unresolved', confidence: 0 });
  });

  it('selects the unique higher image score independent of candidate order', () => {
    const source = annotation({ semanticObjectId: undefined, selectedText: undefined });
    const candidates = [
      candidate({ candidateId: candidateId(6), imageFeatureScore: 0.91, bbox: [0.1, 0.1, 0.1, 0.1] }),
      candidate({ candidateId: candidateId(7), imageFeatureScore: 0.96, bbox: [0.6, 0.6, 0.1, 0.1] })
    ];
    const expected = {
      status: 'resolved', method: 'image-feature', confidence: 0.96,
      pageId: 'page-2', bbox: [0.6, 0.6, 0.1, 0.1]
    };

    expect(reanchor(source, target(candidates))).toEqual(expected);
    expect(reanchor(source, target([...candidates].reverse()))).toEqual(expected);
  });

  it('never resolves bbox-only movement across preview revisions or from fast to authoritative', () => {
    const source = annotation({
      semanticObjectId: undefined, selectedText: undefined,
      beforeContextHash: undefined, afterContextHash: undefined
    });

    expect(reanchor(source, target([candidate()]))).toEqual({ status: 'unresolved', confidence: 0 });
    expect(reanchor(source, target([candidate()], {
      fidelity: 'fast', previewRevisionId: PREVIEW_OTHER
    }))).toEqual({ status: 'unresolved', confidence: 0 });
  });

  it('fails closed on invalid candidate boxes, scores, page identity, or page order', () => {
    const source = annotation({ semanticObjectId: undefined, selectedText: undefined });
    expect(reanchor(source, target([
      candidate({ imageFeatureScore: 0.99, bbox: [0.9, 0.9, 0.2, 0.2] })
    ]))).toEqual({ status: 'unresolved', confidence: 0 });
    expect(reanchor(source, target([
      candidate({ imageFeatureScore: Number.NaN })
    ]))).toEqual({ status: 'unresolved', confidence: 0 });
    expect(reanchor(source, target([
      candidate({ pageId: 'unknown-page', imageFeatureScore: 1 })
    ]))).toEqual({ status: 'unresolved', confidence: 0 });
    expect(reanchor(source, target([candidate()], {
      pageOrder: ['page-1', 'page-2', 'page-2']
    }))).toEqual({ status: 'unresolved', confidence: 0 });
    expect(reanchor(source, target([{
      ...candidate({ imageFeatureScore: 1 }),
      sourcePath: '/Users/example/private.png'
    } as ReanchorCandidate]))).toEqual({ status: 'unresolved', confidence: 0 });
  });

  it('returns a relocation without rewriting the annotation original revision binding', () => {
    const source = annotation();
    const snapshot = structuredClone(source);
    const result = reanchor(source, target([
      candidate({ semanticObjectId: SEMANTIC_7, pageId: 'page-4' })
    ]));

    expect(result.status).toBe('resolved');
    expect(source).toEqual(snapshot);
    expect(source.previewRevisionId).toBe(PREVIEW_FAST);
    expect(source.artifactRevisionId).toBe(ARTIFACT_1);
  });
});

describe('inert structured Agent change request artifacts', () => {
  const unsafeIdentifierTransports = [
    'OpenAI-gpt-5',
    'sk-proj-1234567890abcdef',
    'AKIAIOSFODNN7EXAMPLE',
    'f'.repeat(64),
    'QWxhZGRpbjpvcGVuIHNlc2FtZQ',
    '/etc/passwd',
    'provider-v2'
  ];

  function request(overrides: Partial<AgentChangeRequestDraft> = {}): AgentChangeRequestDraft {
    return {
      artifactRevisionId: ARTIFACT_2,
      previewRevisionId: PREVIEW_TRUTH,
      annotationIds: [ANNOTATION_1],
      intent: { operation: 'revise-selection' },
      context: [{ pageId: 'page-2', selectedText: '季度目标', bbox: [...BOX] }],
      ...overrides
    };
  }

  it('generates persisted instruction from an allowlisted operation without caller text', () => {
    const result = prepareAgentChangeRequest(request());
    expect(result.status).toBe('prepared');
    expect(result.label).toBe('修改请求已准备');
    expect(result.bundle.kind).toBe('agent-change-request');
    expect(result.bundle.directoryName).toBe(`request-${result.bundle.bundleKey}`);
    expect(Object.keys(result.bundle.files)).toEqual(['agent-change-request.json']);
    const stored = JSON.parse(result.bundle.files['agent-change-request.json'].toString('utf8'));
    expect(Object.keys(stored)).toEqual([
      'requestId', 'artifactRevisionId', 'previewRevisionId',
      'annotationIds', 'instruction', 'context'
    ]);
    expect(stored.requestId).toMatch(/^request-sha256:[0-9a-f]{64}$/);
    expect(stored.instruction).toBe('修改所选批注内容');
    expect(Object.keys(stored.context[0])).toEqual(['pageId', 'bbox']);
    expect(result.bundle.bundleKey).toBe(
      createHash('sha256').update(result.bundle.files['agent-change-request.json']).digest('hex')
    );
  });

  it.each([
    'revise-selection', 'replace-selection', 'adjust-layout', 'resolve-comment'
  ] as const)('maps the allowlisted %s operation to a fixed safe template', (operation) => {
    const result = prepareAgentChangeRequest(request({ intent: { operation } }));
    const stored = JSON.parse(result.bundle.files['agent-change-request.json'].toString('utf8'));
    expect(stored.instruction).toMatch(/^[\u4e00-\u9fff]+$/);
  });

  it('rejects caller-supplied instruction fields and non-allowlisted operations', () => {
    expect(() => prepareAgentChangeRequest({
      ...request(), instruction: 'Please run node run.js'
    } as AgentChangeRequestDraft)).toThrow('unknown field');
    expect(() => prepareAgentChangeRequest(request({
      intent: { operation: 'run-command' as 'revise-selection' }
    }))).toThrow('operation');
  });

  it('generates request identity internally and rejects caller request identity transport', () => {
    const first = prepareAgentChangeRequest(request());
    const second = prepareAgentChangeRequest(request());
    expect(second.request.requestId).toBe(first.request.requestId);
    expect(() => prepareAgentChangeRequest({
      ...request(),
      requestId: 'request-sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    } as AgentChangeRequestDraft)).toThrow('unknown field');
  });

  const rawSelectedText = [
    '/etc/passwd', '/opt/tools/run', '/usr/bin/node run.js', 'root=/etc/passwd', '../private/file',
    '\\\\server\\share\\private.docx', '\\\\?\\C:\\private.docx', '\\\\.\\PhysicalDrive0',
    'C:\\Users\\name\\private.docx', '~/private.docx', '$HOME/private.docx', '${PATH}/private',
    '%USERPROFILE%\\private.docx', '%TEMP%\\private.docx',
    'file:///private/file.docx', 'https://example.invalid/private', 'ssh://host/private',
    'data:text/plain,payload', 'javascript:alert(1)',
    'Please run node run-external-agent.js', 'please EXECUTE python task.py', 'invoke Codex Desktop',
    '$(node run.js)', '`python task.py`', 'text; node run.js', 'text && curl example.invalid',
    'text & node run.js', 'text | sh',
    'Use provider OpenAI model gpt-5', 'Anthropic Claude API key secret', 'Gemini provider token',
    'Use an LLM Agent with bearer credentials', 'CODEX_HOME=/private',
    '调用模型提供商 API 密钥', '执行终端脚本',
    '\\Device\\HarddiskVolume1\\Windows\\System32', 'x:payload',
    'sh -c date', 'fish -c date', 'perl -e print', 'deno eval code',
    'Open AI endpoint', 'GPT_5', 'sk-proj-1234567890abcdef', 'AKIAIOSFODNN7EXAMPLE',
    '任意 Unicode 🔐\u0000raw-secret-值'
  ];

  it.each(rawSelectedText)('never persists caller-selected context text: %s', (selectedText) => {
    const result = prepareAgentChangeRequest(request({
      context: [{ pageId: 'page-2', selectedText, bbox: [...BOX] }]
    }));
    const json = result.bundle.files['agent-change-request.json'].toString('utf8');
    const stored = JSON.parse(json);
    expect(stored.context).toEqual([{ pageId: 'page-2', bbox: [...BOX] }]);
    expect(json).not.toContain(selectedText);
    expect(json).not.toContain(JSON.stringify(selectedText).slice(1, -1));
    expect(json).not.toContain(Buffer.from(selectedText, 'utf8').toString('base64'));
    expect(json).not.toContain(Buffer.from(selectedText, 'utf8').toString('hex'));
  });

  it.each(rawSelectedText)('persists only an opaque selected-text fingerprint: %s', (selectedText) => {
    const stored = annotation({ selectedText });
    expect(stored.selectedText).toMatch(/^sha256:[0-9a-f]{64}$/);
    const json = JSON.stringify(stored);
    expect(json).not.toContain(selectedText);
    expect(json).not.toContain(JSON.stringify(selectedText).slice(1, -1));
    expect(json).not.toContain(Buffer.from(selectedText, 'utf8').toString('base64'));
    expect(json).not.toContain(Buffer.from(selectedText, 'utf8').toString('hex'));
  });

  it('rejects untyped transport probes from every persisted identifier field', () => {
    const safeAnnotationBytes = JSON.stringify(annotation());
    const safeRequest = prepareAgentChangeRequest(request());
    const safeRequestBytes = safeRequest.bundle.files['agent-change-request.json'].toString('utf8');
    const safeBundleBytes = Object.values(safeRequest.bundle.files)
      .map((bytes) => bytes.toString('utf8'))
      .join('\n');

    for (const unsafe of unsafeIdentifierTransports) {
      expect(() => prepareAgentChangeRequest({
        ...request(), requestId: unsafe
      } as AgentChangeRequestDraft)).toThrow('unknown field');
      expect(() => prepareAgentChangeRequest(request({ artifactRevisionId: unsafe }))).toThrow('artifactRevisionId');
      expect(() => prepareAgentChangeRequest(request({ previewRevisionId: unsafe }))).toThrow('previewRevisionId');
      expect(() => prepareAgentChangeRequest(request({ annotationIds: [unsafe] }))).toThrow('annotationId');
      expect(() => prepareAgentChangeRequest(request({ context: [{ pageId: unsafe }] }))).toThrow('pageId');
      const base = annotation();
      expect(() => rehydrateReviewAnnotation({ ...base, annotationId: unsafe })).toThrow('annotationId');
      expect(() => rehydrateReviewAnnotation({ ...base, artifactRevisionId: unsafe })).toThrow('artifactRevisionId');
      expect(() => rehydrateReviewAnnotation({ ...base, previewRevisionId: unsafe })).toThrow('previewRevisionId');
      expect(() => rehydrateReviewAnnotation({ ...base, pageId: unsafe })).toThrow('pageId');
      expect(() => rehydrateReviewAnnotation({ ...base, beforeContextHash: unsafe })).toThrow('beforeContextHash');
      expect(() => rehydrateReviewAnnotation({ ...base, afterContextHash: unsafe })).toThrow('afterContextHash');
      expect(() => rehydrateReviewAnnotation({ ...base, semanticObjectId: unsafe })).toThrow('semanticObjectId');
      expect(reanchor(base, target([candidate({ candidateId: unsafe })]))).toEqual({
        status: 'unresolved', confidence: 0
      });
      expect(reanchor(base, target([candidate({ semanticObjectId: unsafe })]))).toEqual({
        status: 'unresolved', confidence: 0
      });
      expect(reanchor(base, target([candidate()], { artifactRevisionId: unsafe }))).toEqual({
        status: 'unresolved', confidence: 0
      });
      expect(reanchor(base, target([candidate()], { previewRevisionId: unsafe }))).toEqual({
        status: 'unresolved', confidence: 0
      });

      for (const serialized of [safeAnnotationBytes, safeRequestBytes, safeBundleBytes]) {
        expect(serialized).not.toContain(unsafe);
      }
    }
  });
});

describe('revision-bound equal-dimension Pixelmatch page diffs', () => {
  const black = Uint8Array.from([0, 0, 0, 255, 0, 0, 0, 255]);
  const oneWhite = Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255]);

  function comparison(overrides: Partial<PageComparisonInput> = {}): PageComparisonInput {
    return {
      before: {
        artifactRevisionId: ARTIFACT_1,
        previewRevisionId: PREVIEW_FAST,
        fidelity: 'fast',
        pageId: 'page-1',
        raster: { width: 2, height: 1, data: black }
      },
      after: {
        artifactRevisionId: ARTIFACT_1,
        previewRevisionId: PREVIEW_TRUTH,
        fidelity: 'authoritative',
        pageId: 'page-1',
        raster: { width: 2, height: 1, data: oneWhite }
      },
      ...overrides
    };
  }

  it('returns exact statistics and deterministic PNG bytes for an identity-bound comparison', () => {
    const unchangedInput = comparison();
    unchangedInput.after.raster = { width: 2, height: 1, data: black };
    const unchanged = comparePageRasters(unchangedInput);
    expect(unchanged).toMatchObject({ changed_pixels: 0, total_pixels: 2, ratio: 0 });

    const changed = comparePageRasters(comparison());
    expect(changed).toMatchObject({ changed_pixels: 1, total_pixels: 2, ratio: 0.5 });
    expect(Number.isFinite(changed.ratio)).toBe(true);
    expect(changed.png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(createHash('sha256').update(changed.png).digest('hex')).toBe(
      createHash('sha256').update(comparePageRasters(comparison()).png).digest('hex')
    );
  });

  it('builds a canonical immutable bundle keyed by identities and raster content', () => {
    const first = createPageVisualDiffBundle(comparison());
    const second = createPageVisualDiffBundle(comparison());
    expect(second).toEqual(first);
    expect(first.directoryName).toBe(`comparison-${first.comparisonKey}`);
    expect(Object.keys(first.files)).toEqual(['diff.png', 'diff-stats.json', 'comparison-manifest.json']);
    expect(JSON.parse(first.files['diff-stats.json'].toString('utf8'))).toEqual({
      changed_pixels: 1, total_pixels: 2, ratio: 0.5
    });
    const manifest = JSON.parse(first.files['comparison-manifest.json'].toString('utf8'));
    expect(manifest).toMatchObject({
      comparisonKey: first.comparisonKey,
      pageId: 'page-1',
      before: { artifactRevisionId: ARTIFACT_1, previewRevisionId: PREVIEW_FAST, fidelity: 'fast' },
      after: { artifactRevisionId: ARTIFACT_1, previewRevisionId: PREVIEW_TRUTH, fidelity: 'authoritative' },
      pixelmatchThreshold: 0.1
    });
    expect(createPageVisualDiffBundle(comparison({
      after: { ...comparison().after, previewRevisionId: PREVIEW_OTHER }
    })).comparisonKey).not.toBe(first.comparisonKey);
    expect(createPageVisualDiffBundle(comparison({
      after: { ...comparison().after, raster: { width: 2, height: 1, data: black } }
    })).comparisonKey).not.toBe(first.comparisonKey);
  });

  it('fails closed on dimension, buffer, empty, and overflow inputs instead of resizing', () => {
    expect(() => comparePageRasters(comparison({
      after: { ...comparison().after, raster: { width: 1, height: 2, data: black } }
    }))).toThrow('dimensions');
    expect(() => comparePageRasters(comparison({
      before: { ...comparison().before, raster: { width: 2, height: 1, data: black.subarray(0, 4) } }
    }))).toThrow('buffer length');
    expect(() => comparePageRasters(comparison({
      before: { ...comparison().before, raster: { width: 0, height: 1, data: new Uint8Array() } },
      after: { ...comparison().after, raster: { width: 0, height: 1, data: new Uint8Array() } }
    }))).toThrow('positive integer');
    expect(() => comparePageRasters(comparison({
      before: { ...comparison().before, raster: { width: Number.MAX_SAFE_INTEGER, height: 2, data: new Uint8Array() } },
      after: { ...comparison().after, raster: { width: Number.MAX_SAFE_INTEGER, height: 2, data: new Uint8Array() } }
    }))).toThrow('overflow');
  });

  it('rejects mismatched page/revision identities and inappropriate fidelity direction', () => {
    expect(() => comparePageRasters(comparison({
      after: { ...comparison().after, pageId: 'page-2' }
    }))).toThrow('pageId');
    expect(() => comparePageRasters(comparison({
      after: { ...comparison().after, previewRevisionId: PREVIEW_FAST }
    }))).toThrow('Preview Revision');
    expect(() => comparePageRasters(comparison({
      after: { ...comparison().after, fidelity: 'fast' }
    }))).toThrow('authoritative');
    expect(() => comparePageRasters(comparison({
      after: { ...comparison().after, artifactRevisionId: ARTIFACT_2 }
    }))).toThrow('fast comparison');
    expect(() => comparePageRasters(comparison({
      before: { ...comparison().before, fidelity: 'authoritative' },
      after: { ...comparison().after, artifactRevisionId: ARTIFACT_2 }
    }))).not.toThrow();
  });

  it('applies the same public-text policy to every persisted comparison identity', () => {
    for (const unsafe of [
      'OpenAI-gpt-5', 'sk-proj-1234567890abcdef', 'AKIAIOSFODNN7EXAMPLE',
      'f'.repeat(64), 'QWxhZGRpbjpvcGVuIHNlc2FtZQ', '/etc/passwd',
      '\\\\server\\share\\file', 'C:\\private\\file', 'provider-v2'
    ]) {
      for (const side of ['before', 'after'] as const) {
        for (const field of ['artifactRevisionId', 'previewRevisionId', 'pageId'] as const) {
          const input = comparison();
          input[side] = { ...input[side], [field]: unsafe };
          expect(() => createPageVisualDiffBundle(input), `${side}.${field}=${unsafe}`).toThrow(field);
        }
      }
    }
  });
});
