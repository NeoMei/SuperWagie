import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PreviewFidelity,
  PreviewRequest,
  ReviewPerformanceSnapshot
} from '../../review-contract';
import { createPreviewRevision } from '../../review-contract';
import { createReviewAnnotation } from '../../annotation-reanchor';
import { DocxFastAdapter } from './docx-fast-adapter';
import {
  normalizeHostArtifactOpened,
  normalizeHostPreviewStatus,
  selectReviewerHostBridge,
  tauriHostBridge,
  type HostBridge
} from './host-bridge';
import { PdfAdapter, type PdfJsRuntime } from './pdf-adapter';

const docxRenderMutation = vi.hoisted(() => ({
  afterRender: null as null | ((bodyContainer: HTMLElement) => void)
}));

vi.mock('docx-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('docx-preview')>();
  return {
    ...actual,
    async renderAsync(...args: Parameters<typeof actual.renderAsync>) {
      const result = await actual.renderAsync(...args);
      docxRenderMutation.afterRender?.(args[1]);
      return result;
    }
  };
});

vi.mock('pdfjs-dist', () => ({
  getDocument: vi.fn(() => { throw new Error('tests inject a controlled PDF.js runtime'); }),
  GlobalWorkerOptions: { workerSrc: '' },
  version: 'test-only-default-runtime'
}));

interface FixtureManifest {
  files: Array<{ path: string; format: string }>;
}

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../fixtures/gate-3/G3-REVIEW-001'
);
const fixtureManifest = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, 'fixture-manifest.json'), 'utf8')
) as FixtureManifest;

function fixtureBytes(format: 'pdf' | 'docx'): Uint8Array {
  const entry = fixtureManifest.files.find((candidate) => candidate.format === format);
  if (!entry) throw new Error(`missing ${format} fixture manifest entry`);
  if (path.isAbsolute(entry.path) || entry.path.split('/').includes('..')) {
    throw new Error(`unsafe fixture manifest path: ${entry.path}`);
  }
  return new Uint8Array(fs.readFileSync(path.join(fixtureRoot, entry.path)));
}

const pdfBytes = fixtureBytes('pdf');
const docxBytes = fixtureBytes('docx');
const assetBodies = new Map<string, Uint8Array>();
let assetSequence = 0;

function fakeHost(bytes: Uint8Array): HostBridge & { requestedUrls: string[] } {
  const assetUrl = `reviewasset://localhost/fixture-${assetSequence += 1}`;
  assetBodies.set(assetUrl, bytes);
  const requestedUrls: string[] = [];

  return {
    requestedUrls,
    async assetUrl(_handle, _kind) {
      requestedUrls.push(assetUrl);
      return assetUrl;
    },
    async startTruthRender() { return { jobId: 'unused-job' }; },
    async previewStatus() { return { jobId: 'unused-job', state: 'queued' }; },
    async saveAnnotation() {},
    async acceptPreview() {},
    async openControlledCopy() { return { receiptId: 'unused-receipt' }; },
    async recordMetrics(_snapshot: ReviewPerformanceSnapshot) {}
  };
}

function request(mediaType: string, fidelity: PreviewFidelity): PreviewRequest {
  return {
    artifactRevisionId: `artifact-sha256:${'11'.repeat(32)}`,
    artifactHandle: 'opaque-fixture-handle-1',
    mediaType,
    preferredFidelity: fidelity,
    deadlineMs: 5_000
  };
}

interface ControlledPdfRuntime {
  runtime: PdfJsRuntime;
  loadingTaskDestroyed: ReturnType<typeof vi.fn>;
  options: Array<{ data: Uint8Array; disableAutoFetch: boolean }>;
  setRenderPending(value: boolean): void;
  renderCancelled: ReturnType<typeof vi.fn>;
  renderCalls: ReturnType<typeof vi.fn>;
}

interface ControlledPdfPageFixture {
  viewport: { width: number; height: number; transform: [number, number, number, number, number, number] };
  textItem: { str: string; transform: number[]; width: number; height: number };
}

function controlledPdfRuntime(pageFixture: ControlledPdfPageFixture = {
  viewport: { width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] },
  textItem: { str: 'Fixture PDF text', transform: [1, 0, 0, 12, 72, 720], width: 84, height: 12 }
}): ControlledPdfRuntime {
  const loadingTaskDestroyed = vi.fn(async () => {});
  const renderCancelled = vi.fn();
  const renderCalls = vi.fn();
  const options: Array<{ data: Uint8Array; disableAutoFetch: boolean }> = [];
  let renderPending = false;

  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: pageFixture.viewport.width * scale,
      height: pageFixture.viewport.height * scale,
      transform: pageFixture.viewport.transform.map((value) => value * scale) as [number, number, number, number, number, number]
    }),
    async getTextContent() {
      return { items: [pageFixture.textItem] };
    },
    render() {
      renderCalls();
      if (!renderPending) return { promise: Promise.resolve(), cancel: renderCancelled };
      let rejectRender!: (reason: Error) => void;
      const promise = new Promise<void>((_resolve, reject) => { rejectRender = reject; });
      return {
        promise,
        cancel: vi.fn(() => {
          renderCancelled();
          rejectRender(new Error('render cancelled'));
        })
      };
    }
  };

  return {
    runtime: {
      version: 'fixture-pdfjs-1',
      workerUrl: './assets/pdf.worker.fixture.mjs',
      getDocument(input) {
        options.push(input);
        return {
          promise: (async () => {
            const bytes = input.data;
            if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
              throw new Error('fixture is not a PDF');
            }
            return {
              numPages: 2,
              getPage: async () => page,
              getData: async () => bytes
            };
          })(),
          destroy: loadingTaskDestroyed
        };
      }
    },
    loadingTaskDestroyed,
    options,
    setRenderPending(value) { renderPending = value; },
    renderCancelled
    , renderCalls
  };
}

beforeEach(() => {
  assetBodies.clear();
  docxRenderMutation.afterRender = null;
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const bytes = assetBodies.get(url);
    if (!bytes) return new Response('missing review asset', { status: 404 });
    return new Response(bytes.slice().buffer, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' }
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe('PdfAdapter', () => {
  it('reports authoritative fidelity for a source PDF', async () => {
    const controlled = controlledPdfRuntime();
    const stages: string[] = [];
    const adapter = new PdfAdapter(fakeHost(pdfBytes), controlled.runtime, (stage) => stages.push(stage));

    const session = await adapter.open(request('application/pdf', 'authoritative'));

    expect(session.manifest?.previewRevision.fidelity).toBe('authoritative');
    expect(session.manifest?.previewRevision.acceptanceState).toBe('reviewable');
    expect(session.manifest?.previewRevision.previewRevisionId)
      .toMatch(/^preview-sha256:[0-9a-f]{64}$/);
    const previewRevision = session.manifest!.previewRevision;
    expect(previewRevision).toEqual(createPreviewRevision({
      artifactRevisionId: previewRevision.artifactRevisionId,
      fidelity: previewRevision.fidelity,
      rendererId: previewRevision.rendererId,
      rendererVersion: previewRevision.rendererVersion,
      rendererEnvironmentHash: previewRevision.rendererEnvironmentHash,
      fontEnvironmentHash: previewRevision.fontEnvironmentHash,
      sourceContentHash: previewRevision.sourceContentHash,
      pageManifestHash: previewRevision.pageManifestHash
    }));
    expect(createReviewAnnotation({
      annotationId: 'annotation-123e4567-e89b-42d3-a456-426614174000',
      artifactRevisionId: previewRevision.artifactRevisionId,
      previewRevisionId: previewRevision.previewRevisionId,
      fidelity: previewRevision.fidelity,
      pageId: 'page-1',
      selectedText: 'Task 1 to adapter to Task 7 interop',
      status: 'active'
    })).toMatchObject({
      artifactRevisionId: previewRevision.artifactRevisionId,
      previewRevisionId: previewRevision.previewRevisionId,
      selectedText: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    });
    expect(controlled.options).toEqual([{
      data: expect.any(Uint8Array),
      disableAutoFetch: true
    }]);
    expect(Buffer.from(controlled.options[0]!.data).equals(Buffer.from(pdfBytes))).toBe(true);
    expect(stages).toEqual([
      'pdf_asset_url',
      'pdf_asset_fetch',
      'pdf_document_load',
      'pdf_manifest_pages',
      'pdf_manifest_source',
      'pdf_manifest_hashes',
      'pdf_manifest_revision',
      'pdf_manifest_revision_id',
      'pdf_manifest_session'
    ]);
  });

  it('enumerates page dimensions and exposes normalized text-layer items', async () => {
    const adapter = new PdfAdapter(fakeHost(pdfBytes), controlledPdfRuntime().runtime);
    const session = await adapter.open(request('application/pdf', 'authoritative'));

    expect(session.manifest?.pages).toEqual([
      { pageId: 'page-1', width: 612, height: 792 },
      { pageId: 'page-2', width: 612, height: 792 }
    ]);
    const textLayer = await adapter.getTextLayer(session.sessionId, 'page-1');
    expect(textLayer?.items[0]?.text).toBe('Fixture PDF text');
    expect(textLayer?.items[0]?.bbox[0]).toBeCloseTo(72 / 612);
    expect(textLayer?.items[0]?.bbox[1]).toBeCloseTo(60 / 792);
    expect(textLayer?.items[0]?.bbox[2]).toBeCloseTo(84 / 612);
    expect(textLayer?.items[0]?.bbox[3]).toBeCloseTo(12 / 792);
  });

  it('composes cropped and rotated viewport geometry with a nontrivial text transform', async () => {
    const controlled = controlledPdfRuntime({
      viewport: { width: 200, height: 300, transform: [0, 1, 1, 0, -20, -10] },
      textItem: {
        str: 'Rotated audited PDF boundary',
        transform: [0, 2, -3, 0, 50, 80],
        width: 40,
        height: 10
      }
    });
    const adapter = new PdfAdapter(fakeHost(pdfBytes), controlled.runtime);
    const session = await adapter.open(request('application/pdf', 'authoritative'));

    const textLayer = await adapter.getTextLayer(session.sessionId, 'page-1');

    expect(textLayer?.items[0]?.text).toBe('Rotated audited PDF boundary');
    expect(textLayer?.items[0]?.bbox[0]).toBeCloseTo(0.3);
    expect(textLayer?.items[0]?.bbox[1]).toBeCloseTo(0.1);
    expect(textLayer?.items[0]?.bbox[2]).toBeCloseTo(0.2);
    expect(textLayer?.items[0]?.bbox[3]).toBeCloseTo(1 / 30);
  });

  it('mounts the rendered PDF canvas into a visible review target by opaque surface handle', async () => {
    const controlled = controlledPdfRuntime();
    const adapter = new PdfAdapter(fakeHost(pdfBytes), controlled.runtime);
    const session = await adapter.open(request('application/pdf', 'authoritative'));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    const surface = await adapter.getPage(session.sessionId, 'page-1', 1);
    const target = document.createElement('div');
    document.body.append(target);

    expect(adapter.mountSurface(surface.surfaceHandle, target)).toBe(true);

    const mountedCanvas = target.querySelector('canvas');
    expect(mountedCanvas).not.toBeNull();
    expect(mountedCanvas?.width).toBe(612);
    expect(mountedCanvas?.height).toBe(792);
    expect(mountedCanvas?.hidden).toBe(false);
    expect(getComputedStyle(mountedCanvas!).display).not.toBe('none');
  });

  it('returns a real cached page surface without rendering the same page and scale twice', async () => {
    const controlled = controlledPdfRuntime();
    const adapter = new PdfAdapter(fakeHost(pdfBytes), controlled.runtime);
    const session = await adapter.open(request('application/pdf', 'authoritative'));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);

    const first = await adapter.getPage(session.sessionId, 'page-1', 1);
    const cached = await adapter.getPage(session.sessionId, 'page-1', 1);

    expect(cached).toEqual(first);
    expect(controlled.renderCalls).toHaveBeenCalledOnce();
  });

  it('cancels pending render tasks and destroys PDF.js resources', async () => {
    const controlled = controlledPdfRuntime();
    controlled.setRenderPending(true);
    const adapter = new PdfAdapter(fakeHost(pdfBytes), controlled.runtime);
    const session = await adapter.open(request('application/pdf', 'authoritative'));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);

    const pendingPage = adapter.getPage(session.sessionId, 'page-1', 1);
    await Promise.resolve();
    await adapter.cancel(session.sessionId);

    await expect(pendingPage).rejects.toThrow('render cancelled');
    expect(controlled.renderCancelled).toHaveBeenCalledOnce();
    expect(controlled.loadingTaskDestroyed).toHaveBeenCalledOnce();
  });
});

describe('HostBridge truth-render status', () => {
  it('accepts both host identities only on authoritative ready', () => {
    const previewRevisionId = `preview-sha256:${'44'.repeat(32)}`;
    const previewHandle = '55'.repeat(16);
    expect(normalizeHostPreviewStatus({
      jobId: '66'.repeat(16),
      state: 'authoritative_ready',
      previewRevisionId,
      previewHandle
    })).toEqual({
      jobId: '66'.repeat(16),
      state: 'authoritative_ready',
      previewRevisionId,
      previewHandle
    });
    expect(() => normalizeHostPreviewStatus({
      jobId: '66'.repeat(16),
      state: 'authoritative_ready',
      previewRevisionId: previewHandle,
      previewHandle
    })).toThrow('host preview status is invalid');
    expect(() => normalizeHostPreviewStatus({
      jobId: '66'.repeat(16),
      state: 'rendering_authoritative',
      previewRevisionId,
      previewHandle
    })).toThrow('host preview status is invalid');
  });
});

describe('DocxFastAdapter', () => {
  it('can never report authoritative fidelity', async () => {
    const bodyContainer = document.createElement('main');
    const styleContainer = document.createElement('div');
    document.body.append(bodyContainer, styleContainer);
    const adapter = new DocxFastAdapter(fakeHost(docxBytes), { bodyContainer, styleContainer });

    const session = await adapter.open(request(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'fast'
    ));

    expect(session.manifest?.previewRevision.fidelity).toBe('fast');
    expect(session.manifest?.previewRevision.acceptanceState).toBe('not_eligible');
    expect(session.manifest?.previewRevision.previewRevisionId)
      .toMatch(/^preview-sha256:[0-9a-f]{64}$/);
    const previewRevision = session.manifest!.previewRevision;
    expect(previewRevision).toEqual(createPreviewRevision({
      artifactRevisionId: previewRevision.artifactRevisionId,
      fidelity: previewRevision.fidelity,
      rendererId: previewRevision.rendererId,
      rendererVersion: previewRevision.rendererVersion,
      rendererEnvironmentHash: previewRevision.rendererEnvironmentHash,
      fontEnvironmentHash: previewRevision.fontEnvironmentHash,
      sourceContentHash: previewRevision.sourceContentHash,
      pageManifestHash: previewRevision.pageManifestHash
    }));
    expect(bodyContainer.dataset.previewFidelity).toBe('fast');
    expect(bodyContainer.dataset.acceptanceState).toBe('not_eligible');
    expect(bodyContainer.querySelector('.superwagie-docx-fast')).not.toBeNull();
  });

  it('overrides an authoritative preference and keeps every status ineligible', async () => {
    const bodyContainer = document.createElement('main');
    const adapter = new DocxFastAdapter(fakeHost(docxBytes), { bodyContainer });

    const session = await adapter.open(request(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'authoritative'
    ));
    const manifest = await adapter.getManifest(session.sessionId);

    expect(manifest.previewRevision.fidelity).toBe('fast');
    expect(manifest.previewRevision.acceptanceState).toBe('not_eligible');
    expect(bodyContainer.dataset.previewFidelity).toBe('fast');
    expect(bodyContainer.dataset.acceptanceState).toBe('not_eligible');
  });

  it('makes malicious rendered hyperlinks inert before the audited DOCX becomes visible', async () => {
    const bodyContainer = document.createElement('main');
    document.body.append(bodyContainer);
    docxRenderMutation.afterRender = (renderedBody) => {
      const page = renderedBody.querySelector('.superwagie-docx-fast') ?? renderedBody;
      const networkLink = document.createElement('a');
      networkLink.href = 'https://untrusted.invalid/collect';
      networkLink.target = '_blank';
      networkLink.ping = 'https://untrusted.invalid/ping';
      networkLink.textContent = 'network target from audited fixture mutation';
      const customSchemeLink = document.createElement('a');
      customSchemeLink.href = 'malicious-reviewer://launch/payload';
      customSchemeLink.textContent = 'custom scheme from audited fixture mutation';
      page.append(networkLink, customSchemeLink);
    };
    const openWindow = vi.spyOn(window, 'open');
    const adapter = new DocxFastAdapter(fakeHost(docxBytes), { bodyContainer });

    await adapter.open(request(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'fast'
    ));

    expect(bodyContainer.querySelectorAll('a[href], area[href], [ping]')).toHaveLength(0);
    const inertLinks = bodyContainer.querySelectorAll<HTMLElement>('[data-docx-link-inert]');
    expect(inertLinks).toHaveLength(2);
    for (const inertLink of inertLinks) {
      inertLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('mounts a visible inert DOCX page clone and its rendered styles by opaque surface handle', async () => {
    const bodyContainer = document.createElement('main');
    const styleContainer = document.createElement('div');
    bodyContainer.hidden = true;
    document.body.append(bodyContainer, styleContainer);
    const adapter = new DocxFastAdapter(fakeHost(docxBytes), { bodyContainer, styleContainer });
    const session = await adapter.open(request(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'fast'
    ));
    const surface = await adapter.getPage(session.sessionId, 'page-1', 1);
    const target = document.createElement('div');
    document.body.append(target);

    expect(adapter.mountSurface(surface.surfaceHandle, target)).toBe(true);

    const mountedPage = target.querySelector<HTMLElement>('.superwagie-docx-fast');
    expect(mountedPage).not.toBeNull();
    expect(mountedPage?.textContent?.trim().length).toBeGreaterThan(0);
    expect(target.querySelectorAll('a, area, [ping]')).toHaveLength(0);
    expect(target.querySelectorAll('style')).not.toHaveLength(0);
    expect(getComputedStyle(mountedPage!).display).not.toBe('none');
  });
});

describe('review asset isolation', () => {
  it('keeps browser-only review previews free of host metric failures', async () => {
    const browserPreviewHost = selectReviewerHostBridge(undefined);

    await expect(browserPreviewHost.recordMetrics({
      progressVisibleMs: 0,
      firstPageMs: 0,
      interactions: []
    })).resolves.toBeUndefined();
    await expect(browserPreviewHost.assetUrl('opaque-handle', 'artifact'))
      .rejects.toThrow('review host unavailable');
    expect(selectReviewerHostBridge({})).toBe(tauriHostBridge);
  });

  it('tags the exact lowercase host revisionHash at the UI event boundary', () => {
    const opened = normalizeHostArtifactOpened({
      handle: '0123456789abcdef0123456789abcdef',
      displayName: 'review.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 42,
      revisionHash: 'ab'.repeat(32)
    });

    expect(opened.artifactRevisionId).toBe(`artifact-sha256:${'ab'.repeat(32)}`);
    expect(opened).not.toHaveProperty('revisionHash');
  });

  it.each([
    ['PDF', (host: HostBridge) => new PdfAdapter(host, controlledPdfRuntime().runtime), 'application/pdf'],
    ['DOCX', (host: HostBridge) => new DocxFastAdapter(host), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
  ])('rejects an untagged Artifact Revision before the %s adapter reads the artifact', async (_name, makeAdapter, mediaType) => {
    const host = fakeHost(pdfBytes);
    await expect(makeAdapter(host).open({
      ...request(mediaType, 'authoritative'),
      artifactRevisionId: '11'.repeat(32)
    })).rejects.toThrow('artifactRevisionId');
    expect(host.requestedUrls).toHaveLength(0);
  });

  it('adapters only request reviewasset URLs', async () => {
    const host = fakeHost(pdfBytes);
    const adapter = new PdfAdapter(host, controlledPdfRuntime().runtime);

    await adapter.open(request('application/pdf', 'authoritative'));

    expect(host.requestedUrls.every((url) => url.startsWith('reviewasset://localhost/'))).toBe(true);
  });

  it.each([
    ['PDF', (host: HostBridge) => new PdfAdapter(host, controlledPdfRuntime().runtime), 'application/pdf'],
    ['DOCX', (host: HostBridge) => new DocxFastAdapter(host), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
  ])('rejects a non-reviewasset URL before the %s renderer can read it', async (_name, makeAdapter, mediaType) => {
    const hostileHost = {
      ...fakeHost(pdfBytes),
      assetUrl: vi.fn(async () => 'file:///private/tmp/leaked-document')
    };

    await expect(makeAdapter(hostileHost).open(request(mediaType, 'authoritative')))
      .rejects.toThrow('HostBridge returned a forbidden review asset URL');
    expect(fetch).not.toHaveBeenCalled();
  });
});
