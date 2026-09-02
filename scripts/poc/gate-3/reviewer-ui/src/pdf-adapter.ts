/// <reference types="vite/client" />

import {
  getDocument,
  GlobalWorkerOptions,
  version as pdfjsVersion
} from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type {
  NormalizedBox,
  PageSurfaceRef,
  PreviewAdapter,
  PreviewManifest,
  PreviewRequest,
  PreviewSession,
  TextLayer
} from '../../review-contract';
import { createPageId, createPreviewRevisionId, validateArtifactRevisionId } from '../../review-identifiers';
import type { HostBridge } from './host-bridge';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfViewport {
  width: number;
  height: number;
  transform: [number, number, number, number, number, number];
}

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

interface PdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

interface PdfPage {
  getViewport(input: { scale: number }): PdfViewport;
  getTextContent(): Promise<{ items: Array<PdfTextItem | object> }>;
  render(input: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
  }): PdfRenderTask;
}

interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  getData(): Promise<Uint8Array>;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void> | void;
}

export interface PdfJsRuntime {
  readonly version: string;
  readonly workerUrl: string;
  getDocument(input: { data: Uint8Array; disableAutoFetch: boolean }): PdfLoadingTask;
}

export type PdfOpenStage =
  | 'pdf_asset_url'
  | 'pdf_asset_fetch'
  | 'pdf_document_load'
  | 'pdf_manifest_build'
  | 'pdf_manifest_pages'
  | 'pdf_manifest_source'
  | 'pdf_manifest_hashes'
  | 'pdf_manifest_revision'
  | 'pdf_manifest_revision_id'
  | 'pdf_manifest_session';

const browserPdfJs: PdfJsRuntime = {
  version: pdfjsVersion,
  workerUrl: pdfWorkerUrl,
  getDocument: (input) => getDocument(input) as unknown as PdfLoadingTask
};

interface PdfSessionState {
  document: PdfDocument;
  loadingTask: PdfLoadingTask;
  manifest: PreviewManifest;
  pages: Map<string, PdfPage>;
  renderTasks: Set<PdfRenderTask>;
  surfaces: Map<string, HTMLCanvasElement>;
  cancelled: boolean;
}

let nextSessionId = 0;

export class PdfAdapter implements PreviewAdapter {
  readonly id = 'pdfjs';
  private readonly sessions = new Map<string, PdfSessionState>();

  constructor(
    private readonly host: HostBridge,
    private readonly pdfjs: PdfJsRuntime = browserPdfJs,
    private readonly onOpenStage: (stage: PdfOpenStage) => void = () => {}
  ) {}

  async probe(): Promise<{ available: boolean; reason?: string }> {
    return { available: true };
  }

  async open(request: PreviewRequest): Promise<PreviewSession> {
    if (request.mediaType !== 'application/pdf') {
      throw new Error(`PdfAdapter does not support ${request.mediaType}`);
    }
    const artifactRevisionId = validateArtifactRevisionId(request.artifactRevisionId);

    this.onOpenStage('pdf_asset_url');
    const assetUrl = await this.host.assetUrl(request.artifactHandle, request.assetKind ?? 'artifact');
    assertReviewAssetUrl(assetUrl);
    this.onOpenStage('pdf_asset_fetch');
    const response = await fetch(assetUrl, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`review asset request failed with ${response.status}`);
    const sourceBytes = new Uint8Array(await response.arrayBuffer());
    const loadingTask = this.pdfjs.getDocument({ data: sourceBytes, disableAutoFetch: true });

    try {
      this.onOpenStage('pdf_document_load');
      const pdfDocument = await loadingTask.promise;
      this.onOpenStage('pdf_manifest_pages');
      const pagePairs = await Promise.all(
        Array.from({ length: pdfDocument.numPages }, async (_unused, index) => {
          const pageNumber = index + 1;
          const page = await pdfDocument.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1 });
          return {
            pageId: createPageId(pageNumber),
            page,
            width: viewport.width,
            height: viewport.height
          };
        })
      );
      const pages = pagePairs.map(({ pageId, width, height }) => ({ pageId, width, height }));
      this.onOpenStage('pdf_manifest_source');
      const sourceBytes = await pdfDocument.getData();
      this.onOpenStage('pdf_manifest_hashes');
      const sourceContentHash = await sha256Hex(sourceBytes);
      const pageManifestHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(pages)));
      const rendererEnvironmentHash = await sha256Hex(
        new TextEncoder().encode(`${this.pdfjs.version}|${this.pdfjs.workerUrl}`)
      );
      const fontEnvironmentHash = await sha256Hex(
        new TextEncoder().encode('pdfjs-embedded-fonts-with-system-fallback')
      );
      const previewRevisionInput = {
          artifactRevisionId,
          fidelity: 'authoritative',
          rendererId: 'pdfjs',
          rendererVersion: this.pdfjs.version,
          rendererEnvironmentHash,
          fontEnvironmentHash,
          sourceContentHash,
          pageManifestHash
      } as const;
      this.onOpenStage('pdf_manifest_revision');
      const previewRevisionHash = await sha256Hex(
        new TextEncoder().encode(JSON.stringify(previewRevisionInput))
      );
      this.onOpenStage('pdf_manifest_revision_id');
      const previewRevisionId = createPreviewRevisionId(previewRevisionHash);
      const manifest: PreviewManifest = {
        previewRevision: {
          ...previewRevisionInput,
          previewRevisionId,
          acceptanceState: 'reviewable'
        },
        pages
      };
      this.onOpenStage('pdf_manifest_session');
      const sessionId = `pdf-session-${nextSessionId += 1}`;
      this.sessions.set(sessionId, {
        document: pdfDocument,
        loadingTask,
        manifest,
        pages: new Map(pagePairs.map(({ pageId, page }) => [pageId, page])),
        renderTasks: new Set(),
        surfaces: new Map(),
        cancelled: false
      });
      return { sessionId, state: 'authoritative_ready', manifest };
    } catch (error) {
      await loadingTask.destroy();
      throw error;
    }
  }

  async getManifest(sessionId: string): Promise<PreviewManifest> {
    return this.requireSession(sessionId).manifest;
  }

  async getPage(sessionId: string, pageId: string, scaleBucket: number): Promise<PageSurfaceRef> {
    if (!Number.isFinite(scaleBucket) || scaleBucket <= 0) {
      throw new Error('scaleBucket must be a positive finite number');
    }
    const session = this.requireSession(sessionId);
    const page = requirePage(session, pageId);
    const surfaceHandle = `pdf-surface:${sessionId}:${pageId}:${scaleBucket}`;
    const cached = session.surfaces.get(surfaceHandle);
    if (cached) return { pageId, width: cached.width, height: cached.height, surfaceHandle };
    const viewport = page.getViewport({ scale: scaleBucket });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PDF canvas 2D context is unavailable');

    const renderTask = page.render({ canvas, canvasContext: context, viewport });
    session.renderTasks.add(renderTask);
    try {
      await renderTask.promise;
      if (session.cancelled) throw new Error('PDF session was cancelled');
      session.surfaces.set(surfaceHandle, canvas);
      return {
        pageId,
        width: viewport.width,
        height: viewport.height,
        surfaceHandle
      };
    } finally {
      session.renderTasks.delete(renderTask);
    }
  }

  async getThumbnail(sessionId: string, pageId: string): Promise<PageSurfaceRef> {
    const session = this.requireSession(sessionId);
    const page = requirePage(session, pageId);
    const viewport = page.getViewport({ scale: 1 });
    const thumbnailScale = Math.min(1, 180 / viewport.width);
    return this.getPage(sessionId, pageId, thumbnailScale);
  }

  async getTextLayer(sessionId: string, pageId: string): Promise<TextLayer | null> {
    const session = this.requireSession(sessionId);
    const page = requirePage(session, pageId);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.flatMap((candidate) => {
      if (!isPdfTextItem(candidate) || candidate.str.length === 0) return [];
      const bbox = normalizedTextBox(viewport, candidate);
      return [{ text: candidate.str, bbox }];
    });
    return { items };
  }

  mountSurface(surfaceHandle: string, target: HTMLElement): boolean {
    for (const session of this.sessions.values()) {
      const canvas = session.surfaces.get(surfaceHandle);
      if (!canvas || session.cancelled) continue;
      canvas.classList.add('review-page-canvas');
      canvas.setAttribute('aria-hidden', 'true');
      target.replaceChildren(canvas);
      return true;
    }
    return false;
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.cancelled = true;
    const pendingTasks = [...session.renderTasks];
    for (const task of pendingTasks) task.cancel();
    await Promise.allSettled(pendingTasks.map((task) => task.promise));
    for (const canvas of session.surfaces.values()) canvas.remove();
    session.surfaces.clear();
    await session.loadingTask.destroy();
  }

  private requireSession(sessionId: string): PdfSessionState {
    const session = this.sessions.get(sessionId);
    if (!session || session.cancelled) throw new Error(`unknown PDF session: ${sessionId}`);
    return session;
  }
}

function assertReviewAssetUrl(candidate: string): void {
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'reviewasset:' ||
      url.hostname !== 'localhost' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.pathname === '' ||
      url.pathname === '/'
    ) {
      throw new Error('forbidden');
    }
  } catch {
    throw new Error('HostBridge returned a forbidden review asset URL');
  }
}

function requirePage(session: PdfSessionState, pageId: string): PdfPage {
  const page = session.pages.get(pageId);
  if (!page) throw new Error(`unknown PDF page: ${pageId}`);
  return page;
}

function isPdfTextItem(candidate: object): candidate is PdfTextItem {
  const value = candidate as Partial<PdfTextItem>;
  return typeof value.str === 'string' &&
    Array.isArray(value.transform) &&
    typeof value.width === 'number' &&
    typeof value.height === 'number';
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizedTextBox(viewport: PdfViewport, item: PdfTextItem): NormalizedBox {
  const textTransform = asTransform(item.transform);
  const combined = multiplyTransforms(viewport.transform, textTransform);
  const sourceBaselineScale = Math.hypot(textTransform[0], textTransform[1]) || 1;
  const sourceVerticalScale = Math.hypot(textTransform[2], textTransform[3]) || 1;
  const screenBaselineScale = Math.hypot(combined[0], combined[1]) || 1;
  const screenVerticalScale = Math.hypot(combined[2], combined[3]) || 1;
  const width = Math.abs(item.width) * screenBaselineScale / sourceBaselineScale;
  const sourceHeight = Math.abs(item.height) || sourceVerticalScale;
  const height = sourceHeight * screenVerticalScale / sourceVerticalScale;
  const baselineUnit: [number, number] = [
    combined[0] / screenBaselineScale,
    combined[1] / screenBaselineScale
  ];
  const verticalUnit: [number, number] = [
    combined[2] / screenVerticalScale,
    combined[3] / screenVerticalScale
  ];
  const origin: [number, number] = [combined[4], combined[5]];
  const corners: Array<[number, number]> = [
    origin,
    [origin[0] + baselineUnit[0] * width, origin[1] + baselineUnit[1] * width],
    [origin[0] + verticalUnit[0] * height, origin[1] + verticalUnit[1] * height],
    [
      origin[0] + baselineUnit[0] * width + verticalUnit[0] * height,
      origin[1] + baselineUnit[1] * width + verticalUnit[1] * height
    ]
  ];
  const xValues = corners.map(([x]) => x);
  const yValues = corners.map(([, y]) => y);
  const left = clampUnit(Math.min(...xValues) / viewport.width);
  const right = clampUnit(Math.max(...xValues) / viewport.width);
  const top = clampUnit(Math.min(...yValues) / viewport.height);
  const bottom = clampUnit(Math.max(...yValues) / viewport.height);
  return [left, top, Math.max(0, right - left), Math.max(0, bottom - top)];
}

function asTransform(values: number[]): [number, number, number, number, number, number] {
  return [
    values[0] ?? 1,
    values[1] ?? 0,
    values[2] ?? 0,
    values[3] ?? 1,
    values[4] ?? 0,
    values[5] ?? 0
  ];
}

function multiplyTransforms(
  left: [number, number, number, number, number, number],
  right: [number, number, number, number, number, number]
): [number, number, number, number, number, number] {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
