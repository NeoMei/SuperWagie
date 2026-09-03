import * as baseCore from './dist/viewer-base/viewer-base.mjs';
import * as officeCore from './dist/viewer-office/viewer-office.mjs';

import { resolveResourceBudget } from './resource-budget.mjs';

const DESCRIPTORS = Object.freeze({
  'viewer.office.docx': Object.freeze({ container_kind: 'word', format: 'docx' }),
  'viewer.office.pptx': Object.freeze({ container_kind: 'ppt', format: 'pptx' })
});

const KNOWN_RELATIONSHIP_KINDS = new Set([
  'comments', 'customXml', 'endnotes', 'fontTable', 'footer', 'footnotes', 'header',
  'hyperlink', 'image', 'notesMaster', 'notesSlide', 'numbering', 'officeDocument',
  'presProps', 'relationships', 'settings', 'slide', 'slideLayout', 'slideMaster',
  'styles', 'tableStyles', 'theme', 'viewProps', 'webSettings'
]);

const MEDIA_ENTRY = /\/(?:media|embeddings)\//i;
const XML_ENTRY = /(?:\.xml|\.rels)$/i;
const LIMIT_DIAGNOSTIC = Object.freeze({
  code: 'VIEWER_OUTPUT_TRUNCATED',
  severity: 'warning',
  forces_partial: true,
  scope: { element_id: 'bounded-output' }
});

export class ViewerAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ViewerAdapterError';
    this.code = code;
    this.parser_dispatches = 0;
  }
}

function failHandle(code, message) {
  throw new ViewerAdapterError(code, message);
}

function sameAudience(actual, expected) {
  return actual?.kind === expected?.kind && actual?.id === expected?.id;
}

function validateOpenInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    failHandle('VIEWER_INPUT_INVALID', 'viewer input must be an object');
  }
  const allowed = new Set(['handle', 'bytes', 'descriptor_id', 'signal', 'limits']);
  const extra = Object.keys(input).find((key) => !allowed.has(key));
  if (extra) failHandle('VIEWER_INPUT_FIELD_FORBIDDEN', `viewer input field is forbidden: ${extra}`);
  if (!(input.bytes instanceof Uint8Array)) failHandle('VIEWER_INPUT_BYTES_INVALID', 'viewer bytes must be a Uint8Array');
}

function verifyHandle({ handle, bytes }, trustedContext, now) {
  if (handle?.verification_state !== 'verified_by_test_core') {
    failHandle('VIEWER_HANDLE_NOT_PREVERIFIED', 'the PoC accepts only a handle prevalidated by the test Core');
  }
  if (handle.resource_type !== 'viewer_input') {
    failHandle('VIEWER_HANDLE_RESOURCE_TYPE_INVALID', 'the handle is not a viewer_input handle');
  }
  if (!sameAudience(handle.audience, trustedContext.audience)) {
    failHandle('VIEWER_HANDLE_AUDIENCE_MISMATCH', 'the handle audience does not match the worker');
  }
  if (!handle.allowed_operations?.includes(trustedContext.operation)) {
    failHandle('VIEWER_HANDLE_OPERATION_DENIED', 'the handle does not allow the requested read operation');
  }
  const readOnlyOperations = new Set(['read', 'range_read', 'inspect']);
  if (handle.allowed_operations.some((operation) => !readOnlyOperations.has(operation))) {
    failHandle('VIEWER_HANDLE_OPERATION_DENIED', 'the viewer handle contains a non-read-only operation');
  }
  if (handle.resource_revision !== trustedContext.expected_revision) {
    failHandle('VIEWER_HANDLE_REVISION_MISMATCH', 'the handle revision does not match the requested revision');
  }
  const expiresAt = Date.parse(handle.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
    failHandle('VIEWER_HANDLE_EXPIRED', 'the handle has expired');
  }
  if (!Number.isSafeInteger(handle.declared_byte_length) || handle.declared_byte_length !== bytes.byteLength) {
    failHandle('VIEWER_HANDLE_SIZE_MISMATCH', 'the handle declared length does not match the supplied bytes');
  }
  if (!Number.isSafeInteger(handle.size_limit_bytes) || bytes.byteLength > handle.size_limit_bytes) {
    failHandle('VIEWER_HANDLE_SIZE_LIMIT', 'the supplied bytes exceed the handle size limit');
  }
}

function normalizeDiagnostic(diagnostic) {
  const rawCode = String(diagnostic?.code ?? 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  const code = rawCode.startsWith('VIEWER_') ? rawCode : `VIEWER_${rawCode}`;
  const normalized = {
    code: code.slice(0, 71),
    severity: ['info', 'warning', 'error'].includes(diagnostic?.severity) ? diagnostic.severity : 'warning',
    forces_partial: diagnostic?.forces_partial === true
  };
  if (diagnostic?.scope && typeof diagnostic.scope === 'object') normalized.scope = structuredClone(diagnostic.scope);
  return normalized;
}

function createDiagnosticCollector(limit) {
  const diagnostics = [];
  let truncated = false;
  const addLimitMarker = () => {
    truncated = true;
    if (limit === 1) diagnostics[0] = structuredClone(LIMIT_DIAGNOSTIC);
    else if (!diagnostics.some((item) => item.code === LIMIT_DIAGNOSTIC.code)) {
      diagnostics.splice(Math.max(0, limit - 1), 1, structuredClone(LIMIT_DIAGNOSTIC));
    }
  };
  return {
    diagnostics,
    add(diagnostic) {
      if (diagnostics.length < Math.max(0, limit - 1)) diagnostics.push(normalizeDiagnostic(diagnostic));
      else addLimitMarker();
    },
    markOutputTruncated: addLimitMarker,
    get truncated() { return truncated; }
  };
}

function boundedArray(items, limit, diagnostics) {
  if (items.length <= limit) return items;
  diagnostics.markOutputTruncated();
  return items.slice(0, limit);
}

function output({ detected = null, state, model = {}, diagnostics, metrics }) {
  return {
    detected,
    document_model: { ...model, state },
    diagnostics: diagnostics.diagnostics,
    metrics: { ...metrics, output_truncated: diagnostics.truncated }
  };
}

function xmlStats(text) {
  let depth = 0;
  let maxDepth = 0;
  let nodes = 0;
  const tags = text.match(/<[^>]+>/g) ?? [];
  for (const tag of tags) {
    if (/^<\//.test(tag)) depth = Math.max(0, depth - 1);
    else if (!/^<[!?]/.test(tag)) {
      nodes += 1;
      if (!/\/>$/.test(tag)) {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
      }
    }
  }
  return { maxDepth, nodes };
}

function relationshipDiagnostics(text, diagnostics) {
  for (const relationship of text.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = /\bId="([^"]+)"/.exec(relationship)?.[1] ?? 'unknown';
    const type = /\bType="([^"]+)"/.exec(relationship)?.[1] ?? '';
    const relationshipKind = type.slice(type.lastIndexOf('/') + 1);
    if (KNOWN_RELATIONSHIP_KINDS.has(relationshipKind)) continue;
    const safeId = id.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^[^A-Za-z]+/, 'id-');
    diagnostics.add({
      code: 'VIEWER_OOXML_RELATIONSHIP_UNKNOWN',
      severity: 'warning',
      forces_partial: true,
      scope: { element_id: `relationship-${safeId}` }
    });
  }
}

function limitFailure(code, scope = { element_id: 'resource-budget' }) {
  return { code, severity: 'error', forces_partial: false, scope };
}

async function inventoryOoxml({ bytes, signal, budget, diagnostics, createAsset }) {
  let archive;
  let totalBytes = 0;
  let xmlNodes = 0;
  let hasWord = false;
  let hasPpt = false;
  try {
    archive = await officeCore.openPptxZip(bytes);
    const entries = await archive.list();
    if (entries.length > budget.max_archive_entries) {
      return { limit: 'VIEWER_LIMIT_ARCHIVE_ENTRIES', totalBytes, entries: entries.length };
    }
    for (const entry of entries) {
      if (entry.startsWith('word/')) hasWord = true;
      if (entry.startsWith('ppt/')) hasPpt = true;
      const depth = entry.split('/').filter(Boolean).length;
      if (depth > budget.max_archive_depth) return { limit: 'VIEWER_LIMIT_ARCHIVE_DEPTH', totalBytes, entries: entries.length };
      const entryBytes = await archive.bytes(entry);
      if (!entryBytes) continue;
      if (entryBytes.byteLength > budget.max_entry_uncompressed_bytes) {
        return { limit: 'VIEWER_LIMIT_ARCHIVE_ENTRY_BYTES', totalBytes, entries: entries.length };
      }
      totalBytes += entryBytes.byteLength;
      if (totalBytes > budget.max_total_uncompressed_bytes) {
        return { limit: 'VIEWER_LIMIT_ARCHIVE_TOTAL_BYTES', totalBytes, entries: entries.length };
      }
      if (bytes.byteLength > 0 && totalBytes / bytes.byteLength > budget.max_compression_ratio) {
        return { limit: 'VIEWER_LIMIT_COMPRESSION_RATIO', totalBytes, entries: entries.length };
      }
      if (MEDIA_ENTRY.test(entry)) createAsset(entryBytes, 'application/octet-stream');
      if (XML_ENTRY.test(entry)) {
        const text = new TextDecoder().decode(entryBytes);
        if (new TextEncoder().encode(text).byteLength > budget.max_xml_text_bytes) {
          return { limit: 'VIEWER_LIMIT_XML_TEXT', totalBytes, entries: entries.length };
        }
        const stats = xmlStats(text);
        xmlNodes += stats.nodes;
        if (stats.maxDepth > budget.max_xml_depth) {
          return { limit: 'VIEWER_LIMIT_XML_DEPTH', totalBytes, entries: entries.length };
        }
        if (xmlNodes > budget.max_xml_nodes) {
          return { limit: 'VIEWER_LIMIT_XML_NODES', totalBytes, entries: entries.length };
        }
        if (entry.endsWith('.rels')) relationshipDiagnostics(text, diagnostics);
      }
      if (signal?.aborted) return { cancelled: true, totalBytes, entries: entries.length };
    }
    return {
      kind: hasWord && hasPpt ? 'ambiguous' : hasWord ? 'word' : hasPpt ? 'ppt' : null,
      totalBytes,
      entries: entries.length
    };
  } catch {
    return { corrupt: true, totalBytes, entries: 0 };
  } finally {
    await archive?.close?.();
  }
}

function collectStrings(value, limit) {
  const found = [];
  const pending = [value];
  while (pending.length > 0 && found.length <= limit) {
    const current = pending.pop();
    if (typeof current === 'string' && current.trim()) found.push(current.trim());
    else if (Array.isArray(current)) pending.push(...current);
    else if (current && typeof current === 'object') pending.push(...Object.values(current));
  }
  return found;
}

async function flushAnimationFrames(count = 4) {
  if (typeof requestAnimationFrame !== 'function') return;
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

async function parseDocx(bytes, budget, diagnostics, coreContext) {
  if (typeof document?.createElement !== 'function') throw new Error('DOCX parser requires an isolated DOM');
  const container = document.createElement('div');
  let mounted;
  try {
    mounted = await officeCore.mountBundledWordViewer(
      { fileName: 'viewer-input.docx', data: bytes },
      container,
      coreContext,
      { styleIsolation: 'scoped' }
    );
    await flushAnimationFrames();
    const paragraphs = [...container.querySelectorAll('p')]
      .map((node) => node.textContent.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const text = paragraphs.length > 0
      ? paragraphs
      : [container.textContent.replace(/\s+/g, ' ').trim()].filter(Boolean);
    const boundedText = boundedArray(text, budget.max_text_items, diagnostics);
    const blocks = boundedArray(
      text.map((value, index) => ({ block_id: `block-${index + 1}`, text: value })),
      budget.max_model_items,
      diagnostics
    );
    const coreState = mounted?.status?.state;
    return {
      state: coreState === 'ready' ? 'ready' : coreState === 'partial' ? 'partial' : 'corrupt',
      model: { kind: 'docx', text: boundedText, blocks }
    };
  } finally {
    mounted?.dispose?.();
    container.replaceChildren();
    await flushAnimationFrames();
  }
}

async function parsePptx(bytes, signal, budget, diagnostics) {
  const parsed = await officeCore.parsePptxVscode(bytes, {
    signal,
    limits: {
      maxInputBytes: budget.max_input_bytes,
      maxEntries: budget.max_archive_entries,
      maxDecompressedBytes: budget.max_total_uncompressed_bytes,
      maxParseMillis: budget.parse_deadline_ms
    }
  });
  for (const item of parsed?.result?.diagnostics ?? []) diagnostics.add(item);
  if (parsed?.result?.status === 'failed') {
    const limited = parsed.result.failure?.code === 'limit-exceeded';
    return { state: limited ? 'too_large' : 'corrupt', model: { kind: 'pptx', text: [], slides: [] } };
  }
  const sourceSlides = parsed?.result?.document?.slides ?? [];
  if (sourceSlides.length === 0) {
    diagnostics.add({ code: 'VIEWER_PPTX_HAS_NO_SLIDES', severity: 'error', forces_partial: false });
    return { state: 'corrupt', model: { kind: 'pptx', text: [], slides: [] } };
  }
  if (sourceSlides.length > budget.max_slides) {
    diagnostics.add(limitFailure('VIEWER_LIMIT_SLIDES'));
    return { state: 'too_large', model: { kind: 'pptx', text: [], slides: [] } };
  }
  const slides = sourceSlides.map((slide, index) => ({
    slide_number: slide.slideNumber ?? index + 1,
    text: boundedArray(collectStrings(slide.elements ?? [], budget.max_text_items + 1), budget.max_text_items, diagnostics)
  }));
  const boundedSlides = boundedArray(slides, Math.min(budget.max_slides, budget.max_model_items), diagnostics);
  return {
    state: parsed.result.status === 'partial' ? 'partial' : 'ready',
    model: {
      kind: 'pptx',
      text: boundedArray(boundedSlides.flatMap((slide) => slide.text), budget.max_text_items, diagnostics),
      total_slides: sourceSlides.length,
      slides: boundedSlides
    }
  };
}

export function createViewerHostAdapter({
  trusted_context: trustedContext,
  now = () => Date.now(),
  create_asset_url: createAssetUrl,
  revoke_asset_url: revokeAssetUrl
} = {}) {
  if (!['surface', 'worker'].includes(trustedContext?.audience?.kind)
    || typeof trustedContext?.audience?.id !== 'string'
    || trustedContext.audience.id.length === 0
    || trustedContext?.operation !== 'read'
    || typeof trustedContext?.expected_revision !== 'string'
    || trustedContext.expected_revision.length === 0) {
    throw new TypeError('trusted_context must bind audience, operation, and expected_revision');
  }

  let activeDiagnostics = null;
  let assetSequence = 0;
  const liveAssetUrls = new Set();

  const adapter = {
    readAll(input) {
      validateOpenInput(input);
      verifyHandle(input, trustedContext, now);
      return Uint8Array.from(input.bytes);
    },
    readRange(input, start, length) {
      validateOpenInput(input);
      verifyHandle(input, trustedContext, now);
      if (!input.handle.allowed_operations.includes('range_read')) {
        failHandle('VIEWER_HANDLE_RANGE_OPERATION_DENIED', 'the handle does not allow range reads');
      }
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0) {
        failHandle('VIEWER_RANGE_INVALID', 'range offsets must be non-negative integers');
      }
      if (length > input.handle.range_limit_bytes || start + length > input.bytes.byteLength) {
        failHandle('VIEWER_RANGE_LIMIT', 'range read exceeds the handle boundary');
      }
      return Uint8Array.from(input.bytes.subarray(start, start + length));
    },
    isCancelled(signal) {
      return signal?.aborted === true;
    },
    reportDiagnostic(diagnostic) {
      const normalized = normalizeDiagnostic(diagnostic);
      activeDiagnostics?.add(normalized);
      return normalized;
    },
    createEphemeralAssetUrl(bytes, mediaType = 'application/octet-stream') {
      const url = createAssetUrl
        ? createAssetUrl(Uint8Array.from(bytes), mediaType)
        : `blob:superwagie-viewer-poc/${++assetSequence}`;
      if (typeof url !== 'string' || !url.startsWith('blob:')) throw new Error('ephemeral asset URL factory must return a blob URL');
      liveAssetUrls.add(url);
      return url;
    },
    revokeEphemeralAssetUrl(url) {
      if (!liveAssetUrls.delete(url)) return false;
      revokeAssetUrl?.(url);
      return true;
    },
    async open(input) {
      validateOpenInput(input);
      verifyHandle(input, trustedContext, now);
      const descriptor = DESCRIPTORS[input.descriptor_id];
      if (!descriptor) failHandle('VIEWER_DESCRIPTOR_NOT_ADMITTED_FOR_POC', 'descriptor is not admitted by the Task 4 PoC fixture');
      const budget = resolveResourceBudget(input.limits);
      const diagnostics = createDiagnosticCollector(budget.max_diagnostics);
      activeDiagnostics = diagnostics;
      const metrics = {
        input_bytes: input.bytes.byteLength,
        decompressed_bytes: 0,
        archive_entries: 0,
        parser_dispatches: 0,
        ephemeral_asset_urls_created: 0,
        ephemeral_asset_urls_revoked: 0
      };
      const requestAssets = [];
      const createRequestAsset = (bytes, mediaType) => {
        const url = adapter.createEphemeralAssetUrl(bytes, mediaType);
        requestAssets.push(url);
        metrics.ephemeral_asset_urls_created += 1;
        return url;
      };
      let result;
      try {
        if (adapter.isCancelled(input.signal)) {
          result = output({ state: 'cancelled', diagnostics, metrics });
          return result;
        }
        if (input.bytes.byteLength > budget.max_input_bytes) {
          diagnostics.add(limitFailure('VIEWER_LIMIT_INPUT_BYTES'));
          result = output({ state: 'too_large', diagnostics, metrics });
          return result;
        }

        const bytes = adapter.readAll(input);
        const header = bytes.subarray(0, Math.min(bytes.byteLength, budget.max_detection_bytes));
        const container = baseCore.sniffContainer(header);
        if (container !== 'zip') {
          diagnostics.add({ code: 'VIEWER_CONTAINER_UNRECOGNIZED', severity: 'error', forces_partial: false });
          result = output({ detected: { container, format: null }, state: 'corrupt', diagnostics, metrics });
          return result;
        }
        const probed = await baseCore.probeContainer(bytes, container, {
          signal: input.signal,
          limits: { maxEntries: budget.max_archive_entries }
        });
        const inventory = await inventoryOoxml({
          bytes,
          signal: input.signal,
          budget,
          diagnostics,
          createAsset: createRequestAsset
        });
        metrics.decompressed_bytes = inventory.totalBytes ?? 0;
        metrics.archive_entries = inventory.entries ?? 0;
        if (inventory.cancelled || adapter.isCancelled(input.signal)) {
          result = output({ detected: { container, format: descriptor.format }, state: 'cancelled', diagnostics, metrics });
          return result;
        }
        if (inventory.limit) {
          diagnostics.add(limitFailure(inventory.limit));
          result = output({ detected: { container, format: descriptor.format }, state: 'too_large', diagnostics, metrics });
          return result;
        }
        if (inventory.corrupt) {
          diagnostics.add({ code: 'VIEWER_CONTAINER_CORRUPT', severity: 'error', forces_partial: false });
          result = output({ detected: { container, format: null }, state: 'corrupt', diagnostics, metrics });
          return result;
        }
        if (inventory.kind === 'ambiguous') {
          diagnostics.add({ code: 'VIEWER_CONTAINER_AMBIGUOUS', severity: 'error', forces_partial: false });
          result = output({ detected: { container, format: null }, state: 'corrupt', diagnostics, metrics });
          return result;
        }
        if (!inventory.kind || probed !== inventory.kind || inventory.kind !== descriptor.container_kind) {
          diagnostics.add({ code: 'VIEWER_DESCRIPTOR_MISMATCH', severity: 'error', forces_partial: false });
          result = output({ detected: { container, format: null }, state: 'corrupt', diagnostics, metrics });
          return result;
        }

        metrics.parser_dispatches += 1;
        let parsed;
        if (descriptor.format === 'docx') {
          const coreContext = Object.freeze({
            assets: Object.freeze({ resolveAssetUrl: async (value) => value }),
            i18n: Object.freeze({ t: (key) => key }),
            logger: Object.freeze({ log: (diagnostic) => adapter.reportDiagnostic(diagnostic) })
          });
          parsed = await parseDocx(bytes, budget, diagnostics, coreContext);
        } else {
          parsed = await parsePptx(bytes, input.signal, budget, diagnostics);
        }
        let state = parsed.state;
        if (diagnostics.diagnostics.some((diagnostic) => diagnostic.forces_partial) && state === 'ready') state = 'partial';
        result = output({
          detected: { container, format: descriptor.format, descriptor_id: input.descriptor_id },
          state,
          model: parsed.model,
          diagnostics,
          metrics
        });
        return result;
      } catch (error) {
        if (adapter.isCancelled(input.signal)) {
          result = output({ detected: null, state: 'cancelled', diagnostics, metrics });
          return result;
        }
        diagnostics.add({ code: 'VIEWER_PARSER_ERROR', severity: 'error', forces_partial: false });
        result = output({ detected: null, state: 'corrupt', diagnostics, metrics });
        return result;
      } finally {
        for (const url of requestAssets) {
          if (adapter.revokeEphemeralAssetUrl(url)) metrics.ephemeral_asset_urls_revoked += 1;
        }
        activeDiagnostics = null;
        if (result) {
          result.metrics.ephemeral_asset_urls_revoked = metrics.ephemeral_asset_urls_revoked;
          result.metrics.output_truncated = diagnostics.truncated;
        }
      }
    }
  };

  return Object.freeze(adapter);
}
