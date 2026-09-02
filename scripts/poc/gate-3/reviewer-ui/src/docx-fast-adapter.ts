import { renderAsync } from 'docx-preview';
import type {
  PageSurfaceRef,
  PreviewAdapter,
  PreviewManifest,
  PreviewRequest,
  PreviewSession,
  TextLayer
} from '../../review-contract';
import { createPageId, createPreviewRevisionId, validateArtifactRevisionId } from '../../review-identifiers';
import type { HostBridge } from './host-bridge';

interface DocxFastAdapterContainers {
  bodyContainer?: HTMLElement;
  styleContainer?: HTMLElement;
}

interface DocxFastSessionState {
  manifest: PreviewManifest;
  bodyContainer: HTMLElement;
  styleContainer: HTMLElement;
  pages: Map<string, HTMLElement>;
}

let nextSessionId = 0;

export class DocxFastAdapter implements PreviewAdapter {
  readonly id = 'docx-preview-fast';
  private readonly sessions = new Map<string, DocxFastSessionState>();

  constructor(
    private readonly host: HostBridge,
    private readonly containers: DocxFastAdapterContainers = {}
  ) {}

  async probe(): Promise<{ available: boolean; reason?: string }> {
    return typeof document === 'undefined'
      ? { available: false, reason: 'DOM rendering is unavailable' }
      : { available: true };
  }

  async open(request: PreviewRequest): Promise<PreviewSession> {
    if (!request.mediaType.includes('wordprocessingml.document')) {
      throw new Error(`DocxFastAdapter does not support ${request.mediaType}`);
    }
    const artifactRevisionId = validateArtifactRevisionId(request.artifactRevisionId);

    const assetUrl = await this.host.assetUrl(request.artifactHandle, 'artifact');
    assertReviewAssetUrl(assetUrl);
    const response = await fetch(assetUrl, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`review asset request failed with ${response.status}`);
    const bytes = await response.arrayBuffer();
    const bodyContainer = this.containers.bodyContainer ?? document.createElement('main');
    const styleContainer = this.containers.styleContainer ?? document.createElement('div');

    stampFastOnlyStatus(bodyContainer);
    await renderAsync(bytes, bodyContainer, styleContainer, {
      className: 'superwagie-docx-fast',
      renderAltChunks: false,
      useBase64URL: true,
      ignoreLastRenderedPageBreak: false
    });
    makeRenderedLinksInert(bodyContainer);
    stampFastOnlyStatus(bodyContainer);

    let pageElements = Array.from(
      bodyContainer.querySelectorAll<HTMLElement>('section.superwagie-docx-fast')
    );
    if (pageElements.length === 0) pageElements = [bodyContainer];
    const pages = pageElements.map((page, index) => {
      stampFastOnlyStatus(page);
      const bounds = page.getBoundingClientRect();
      return {
        pageId: createPageId(index + 1),
        width: bounds.width || 816,
        height: bounds.height || 1056
      };
    });
    const sourceContentHash = await sha256Hex(new Uint8Array(bytes));
    const pageManifestHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(pages)));
    const rendererEnvironmentHash = await sha256Hex(
      new TextEncoder().encode('docx-preview-0.4.0|superwagie-docx-fast')
    );
    const fontEnvironmentHash = await sha256Hex(
      new TextEncoder().encode('webview-font-environment-non-authoritative')
    );
    const previewRevisionInput = {
        artifactRevisionId,
        fidelity: 'fast',
        rendererId: 'docx-preview',
        rendererVersion: '0.4.0',
        rendererEnvironmentHash,
        fontEnvironmentHash,
        sourceContentHash,
        pageManifestHash
    } as const;
    const previewRevisionId = createPreviewRevisionId(await sha256Hex(
      new TextEncoder().encode(JSON.stringify(previewRevisionInput))
    ));
    const manifest: PreviewManifest = {
      previewRevision: {
        ...previewRevisionInput,
        previewRevisionId,
        acceptanceState: 'not_eligible'
      },
      pages
    };
    const sessionId = `docx-fast-session-${nextSessionId += 1}`;
    this.sessions.set(sessionId, {
      manifest,
      bodyContainer,
      styleContainer,
      pages: new Map(pageElements.map((page, index) => [createPageId(index + 1), page]))
    });
    return { sessionId, state: 'fast_ready', manifest };
  }

  async getManifest(sessionId: string): Promise<PreviewManifest> {
    const session = this.requireSession(sessionId);
    assertFastOnlyManifest(session.manifest);
    stampFastOnlyStatus(session.bodyContainer);
    return session.manifest;
  }

  async getPage(sessionId: string, pageId: string, _scaleBucket: number): Promise<PageSurfaceRef> {
    const session = this.requireSession(sessionId);
    const page = requirePage(session, pageId);
    stampFastOnlyStatus(page);
    const manifestPage = session.manifest.pages.find((candidate) => candidate.pageId === pageId);
    if (!manifestPage) throw new Error(`unknown DOCX fast page manifest: ${pageId}`);
    return {
      ...manifestPage,
      surfaceHandle: `docx-fast-surface:${sessionId}:${pageId}`
    };
  }

  async getThumbnail(sessionId: string, pageId: string): Promise<PageSurfaceRef> {
    const page = await this.getPage(sessionId, pageId, 1);
    const scale = Math.min(1, 180 / page.width);
    return { ...page, width: page.width * scale, height: page.height * scale };
  }

  async getTextLayer(sessionId: string, pageId: string): Promise<TextLayer | null> {
    const session = this.requireSession(sessionId);
    const page = requirePage(session, pageId);
    const text = page.textContent?.trim() ?? '';
    if (text.length === 0) return { items: [] };
    return { items: [{ text, bbox: [0, 0, 1, 1] }] };
  }

  mountSurface(surfaceHandle: string, target: HTMLElement): boolean {
    for (const [sessionId, session] of this.sessions) {
      for (const [pageId, page] of session.pages) {
        if (surfaceHandle !== `docx-fast-surface:${sessionId}:${pageId}`) continue;
        const fragment = target.ownerDocument.createDocumentFragment();
        for (const styleNode of session.styleContainer.childNodes) {
          fragment.append(styleNode.cloneNode(true));
        }
        const visiblePage = page.cloneNode(true) as HTMLElement;
        makeRenderedLinksInert(visiblePage);
        stampFastOnlyStatus(visiblePage);
        visiblePage.hidden = false;
        fragment.append(visiblePage);
        target.replaceChildren(fragment);
        return true;
      }
    }
    return false;
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.bodyContainer.replaceChildren();
    session.styleContainer.replaceChildren();
    delete session.bodyContainer.dataset.previewFidelity;
    delete session.bodyContainer.dataset.acceptanceState;
    session.pages.clear();
  }

  private requireSession(sessionId: string): DocxFastSessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown DOCX fast session: ${sessionId}`);
    return session;
  }
}

function stampFastOnlyStatus(element: HTMLElement): void {
  element.dataset.previewFidelity = 'fast';
  element.dataset.acceptanceState = 'not_eligible';
}

function makeRenderedLinksInert(bodyContainer: HTMLElement): void {
  for (const link of bodyContainer.querySelectorAll('a, area')) {
    const inertText = bodyContainer.ownerDocument.createElement('span');
    inertText.dataset.docxLinkInert = '';
    inertText.setAttribute('role', 'text');
    const className = link.getAttribute('class');
    if (className) inertText.className = className;
    while (link.firstChild) inertText.append(link.firstChild);
    if (!inertText.hasChildNodes()) {
      inertText.textContent = link.getAttribute('aria-label') ?? link.getAttribute('title') ?? '';
    }
    link.replaceWith(inertText);
  }
}

function assertFastOnlyManifest(manifest: PreviewManifest): void {
  if (
    manifest.previewRevision.fidelity !== 'fast' ||
    manifest.previewRevision.acceptanceState !== 'not_eligible'
  ) {
    throw new Error('DOCX fast preview invariant was violated');
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

function requirePage(session: DocxFastSessionState, pageId: string): HTMLElement {
  const page = session.pages.get(pageId);
  if (!page) throw new Error(`unknown DOCX fast page: ${pageId}`);
  return page;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
