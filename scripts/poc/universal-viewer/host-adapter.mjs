import * as baseCore from './dist/viewer-base/viewer-base.mjs';
import * as officeCore from './dist/viewer-office/viewer-office.mjs';

import { resolveResourceBudget } from './resource-budget.mjs';

const DESCRIPTORS = Object.freeze({
  'viewer.office.docx': Object.freeze({ container_kind: 'word', format: 'docx' }),
  'viewer.office.pptx': Object.freeze({ container_kind: 'ppt', format: 'pptx' })
});

const OFFICE_RELATIONSHIP_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const PACKAGE_RELATIONSHIP_BASE = 'http://schemas.openxmlformats.org/package/2006/relationships/';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MCE_NAMESPACE = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const XML_PREFIX = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const XML_QNAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/u;
const XML_NAME_AT_START = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/u;
const MCE_PREFIX_LIST_ATTRIBUTES = new Set(['Ignorable', 'MustUnderstand']);
const MCE_QNAME_LIST_ATTRIBUTES = new Set(['ProcessContent', 'PreserveAttributes', 'PreserveElements']);
const KNOWN_RELATIONSHIP_URIS = new Set([
  ...[
    'comments', 'custom-properties', 'customXml', 'endnotes', 'extended-properties',
    'fontTable', 'footer', 'footnotes', 'header', 'hyperlink', 'image', 'notesMaster',
    'notesSlide', 'numbering', 'officeDocument', 'presProps', 'settings', 'slide',
    'slideLayout', 'slideMaster', 'styles', 'tableStyles', 'theme', 'viewProps',
    'webSettings'
  ].map((kind) => `${OFFICE_RELATIONSHIP_BASE}${kind}`),
  `${PACKAGE_RELATIONSHIP_BASE}metadata/core-properties`,
]);

const MEDIA_ENTRY = /\/(?:media|embeddings)\//i;
const IMAGE_ENTRY = /\/media\//i;
const XML_ENTRY = /(?:\.xml|\.rels)$/i;
const EMBEDDED_ENTRY = /\/embeddings\//i;
const MACRO_ENTRY = /(?:^|\/)(?:vbaProject|macros?)\.(?:bin|xml)$/i;
const EXTERNAL_LINK_ENTRY = /\/externalLinks?\//i;
const FONT_ENTRY = /\/(?:fonts?|fontTable)\//i;
const DRAWING_ENTRY = /\/drawings?\//i;
const KNOWN_PART = /^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(?:app|core|custom)\.xml|word\/(?:document|styles|numbering|settings|webSettings|fontTable|footnotes|endnotes|comments)\.xml|word\/(?:header|footer)\d+\.xml|word\/(?:_rels\/[^/]+\.rels|theme\/theme\d+\.xml|media\/[^/]+)|ppt\/(?:presentation|presProps|viewProps|tableStyles)\.xml|ppt\/(?:_rels\/[^/]+\.rels|slides\/(?:_rels\/[^/]+\.rels|slide\d+\.xml)|slideMasters\/(?:_rels\/[^/]+\.rels|slideMaster\d+\.xml)|slideLayouts\/(?:_rels\/[^/]+\.rels|slideLayout\d+\.xml)|notesSlides\/(?:_rels\/[^/]+\.rels|notesSlide\d+\.xml)|notesMasters\/(?:_rels\/[^/]+\.rels|notesMaster\d+\.xml)|theme\/theme\d+\.xml|media\/[^/]+))$/i;
const KNOWN_CONTENT_TYPES = new Set([
  'application/xml',
  'application/vnd.openxmlformats-package.relationships+xml',
  'application/vnd.openxmlformats-package.core-properties+xml',
  'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  'application/vnd.openxmlformats-officedocument.custom-properties+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.websettings+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.fonttable+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.slidelayout+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.slidemaster+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.notesslide+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.notesmaster+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.presprops+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.viewprops+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.tablestyles+xml',
  'application/vnd.openxmlformats-officedocument.theme+xml'
]);
const KNOWN_NAMESPACES = new Set([
  XML_NAMESPACE,
  'http://schemas.openxmlformats.org/package/2006/content-types',
  'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://schemas.openxmlformats.org/drawingml/2006/chart',
  'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  'http://schemas.openxmlformats.org/markup-compatibility/2006',
  'http://purl.org/dc/elements/1.1/',
  'http://purl.org/dc/terms/',
  'http://purl.org/dc/dcmitype/',
  'http://www.w3.org/2001/XMLSchema-instance',
  'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties',
  'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'
]);
const KNOWN_DRAWING_URIS = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/chart',
  'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  'http://schemas.openxmlformats.org/drawingml/2006/picture',
  'http://schemas.openxmlformats.org/drawingml/2006/table',
  'http://schemas.microsoft.com/office/drawing/2010/chart',
  'http://schemas.microsoft.com/office/drawing/2016/SVG/main',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
]);
const MODEL_KEYS = Object.freeze([
  'text', 'value', 'paragraphs', 'runs', 'elements', 'children', 'tableRows', 'rows', 'cells'
]);
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
  if (!Number.isSafeInteger(handle.range_limit_bytes) || handle.range_limit_bytes <= 0) {
    failHandle('VIEWER_HANDLE_RANGE_LIMIT_INVALID', 'the handle range limit must be a positive safe integer');
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

function output({ detected = null, state, model = {}, diagnostics, metrics }) {
  return {
    detected,
    document_model: { ...model, state },
    diagnostics: diagnostics.diagnostics,
    metrics: { ...metrics, output_truncated: diagnostics.truncated }
  };
}

function xmlStats(text, remainingNodes) {
  let depth = 0;
  let maxDepth = 0;
  let nodes = 0;
  const tags = /<[^>]+>/g;
  let match;
  while ((match = tags.exec(text)) !== null) {
    const tag = match[0];
    if (/^<\//.test(tag)) depth = Math.max(0, depth - 1);
    else if (!/^<[!?]/.test(tag)) {
      nodes += 1;
      if (nodes > remainingNodes) return { maxDepth, nodes, nodesExceeded: true };
      if (!/\/>$/.test(tag)) {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
      }
    }
  }
  return { maxDepth, nodes };
}

function safeScope(value, prefix = 'part') {
  const safe = String(value).replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^[^A-Za-z]+/, 'id-');
  return { element_id: `${prefix}-${safe || 'unknown'}`.slice(0, 160) };
}

function partialFeature(diagnostics, code, value, prefix) {
  diagnostics.add({
    code,
    severity: 'warning',
    forces_partial: true,
    scope: safeScope(value, prefix)
  });
}

function decodeXmlAttribute(value) {
  let valid = !value.replace(/&(?:amp|apos|gt|lt|quot|#\d+|#x[0-9a-f]+);/gu, '').includes('&');
  const decoded = value.replace(/&(?:amp|apos|gt|lt|quot|#\d+|#x[0-9a-f]+);/gu, (entity) => {
    const body = entity.slice(1, -1);
    if (body === 'amp') return '&';
    if (body === 'apos') return "'";
    if (body === 'gt') return '>';
    if (body === 'lt') return '<';
    if (body === 'quot') return '"';
    const numeric = body[0] === '#' && body[1]?.toLowerCase() === 'x'
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    const validCodePoint = numeric === 0x9 || numeric === 0xA || numeric === 0xD
      || (numeric >= 0x20 && numeric <= 0xD7FF)
      || (numeric >= 0xE000 && numeric <= 0xFFFD)
      || (numeric >= 0x10000 && numeric <= 0x10FFFF);
    if (!validCodePoint) valid = false;
    try { return validCodePoint ? String.fromCodePoint(numeric) : entity; }
    catch { valid = false; return entity; }
  });
  return { value: decoded, valid };
}

function qnamePrefix(name) {
  const parts = name.split(':');
  return parts.length === 2 ? parts[0] : null;
}

function validateMceList(value, kind, namespaces, errors) {
  const tokens = value.trim() ? value.trim().split(/\s+/u) : [];
  if (tokens.length === 0) errors.push('invalid-mce-list-empty');
  const seen = new Set();
  for (const token of tokens) {
    if (seen.has(token)) errors.push('invalid-mce-list-duplicate');
    seen.add(token);
    if (kind === 'prefix') {
      if (!XML_PREFIX.test(token)) errors.push('invalid-mce-prefix');
      else if (!namespaces.has(token)) errors.push(`undeclared-mce-prefix:${token}`);
      continue;
    }
    if (!XML_QNAME.test(token)) errors.push('invalid-mce-qname');
    else {
      const prefix = qnamePrefix(token);
      if (prefix ? !namespaces.has(prefix) : !namespaces.has('')) {
        errors.push(`undeclared-mce-prefix:${prefix ?? 'default'}`);
      }
    }
  }
}

function parseXmlStartTags(text) {
  const tags = [];
  const errors = [];
  const namespaceStack = [new Map([['xml', XML_NAMESPACE], ['xmlns', XMLNS_NAMESPACE]])];
  const elementStack = [];
  let documentElements = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('<', cursor);
    const textEnd = open < 0 ? text.length : open;
    const textSegment = text.slice(cursor, textEnd);
    if (!decodeXmlAttribute(textSegment).valid) errors.push('invalid-text-entity');
    if (elementStack.length === 0 && textSegment.trim() !== '') errors.push('text-outside-document-element');
    if (open < 0) {
      cursor = text.length;
      break;
    }
    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4);
      if (close < 0) errors.push('unterminated-comment');
      cursor = close < 0 ? text.length : close + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const close = text.indexOf(']]>', open + 9);
      if (close < 0) errors.push('unterminated-cdata');
      if (elementStack.length === 0) errors.push('cdata-outside-document-element');
      cursor = close < 0 ? text.length : close + 3;
      continue;
    }
    let quote = null;
    let close = open + 1;
    for (; close < text.length; close += 1) {
      const character = text[close];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (close >= text.length) {
      errors.push('unterminated-tag');
      break;
    }
    const body = text.slice(open + 1, close).trim();
    cursor = close + 1;
    if (!body) {
      errors.push('empty-tag');
      continue;
    }
    if (body[0] === '?') {
      if (!body.endsWith('?')) errors.push('malformed-processing-instruction');
      continue;
    }
    if (body[0] === '!') {
      errors.push('unsupported-declaration');
      continue;
    }
    if (body[0] === '/') {
      const closingName = /^\/\s*([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)\s*$/u.exec(body)?.[1];
      if (!closingName || elementStack.at(-1) !== closingName) errors.push('mismatched-closing-tag');
      if (elementStack.length > 0) {
        elementStack.pop();
        namespaceStack.pop();
      }
      continue;
    }
    const nameMatch = XML_NAME_AT_START.exec(body);
    if (!nameMatch || !XML_QNAME.test(nameMatch[0]) || !/[\s/>]/u.test(body[nameMatch[0].length] ?? '>')) {
      errors.push('invalid-element-name');
      continue;
    }
    if (elementStack.length === 0) {
      documentElements += 1;
      if (documentElements > 1) errors.push('multiple-document-elements');
    }
    const attributes = new Map();
    const attributeNames = [];
    const attributeEntries = [];
    let malformed = false;
    let selfClosing = false;
    let index = nameMatch[0].length;
    while (index < body.length) {
      while (/\s/u.test(body[index] ?? '')) index += 1;
      if (index >= body.length) break;
      if (body[index] === '/') {
        selfClosing = index === body.length - 1;
        if (!selfClosing) malformed = true;
        break;
      }
      const attributeMatch = XML_NAME_AT_START.exec(body.slice(index));
      if (!attributeMatch || !XML_QNAME.test(attributeMatch[0])) {
        malformed = true;
        break;
      }
      const attributeName = attributeMatch[0];
      index += attributeName.length;
      while (/\s/u.test(body[index] ?? '')) index += 1;
      if (body[index] !== '=') {
        malformed = true;
        break;
      }
      index += 1;
      while (/\s/u.test(body[index] ?? '')) index += 1;
      const attributeQuote = body[index];
      if (attributeQuote !== '"' && attributeQuote !== "'") {
        malformed = true;
        break;
      }
      const valueStart = ++index;
      const valueEnd = body.indexOf(attributeQuote, valueStart);
      if (valueEnd < 0) {
        malformed = true;
        break;
      }
      const normalizedName = attributeName.toLowerCase();
      const decoded = decodeXmlAttribute(body.slice(valueStart, valueEnd));
      if (attributes.has(normalizedName) || !decoded.valid) malformed = true;
      attributes.set(normalizedName, decoded.value);
      attributeNames.push(attributeName);
      attributeEntries.push([attributeName, decoded.value]);
      index = valueEnd + 1;
    }
    if (malformed) errors.push('malformed-or-duplicate-attribute');

    const namespaces = new Map(namespaceStack.at(-1));
    for (const [attributeName, value] of attributeEntries) {
      if (attributeName === 'xmlns') {
        if (value) namespaces.set('', value);
        else namespaces.delete('');
      } else if (attributeName.startsWith('xmlns:')) {
        const prefix = attributeName.slice('xmlns:'.length);
        if (prefix && value) namespaces.set(prefix, value);
        else errors.push('invalid-namespace-declaration');
      }
    }
    const elementPrefix = qnamePrefix(nameMatch[0]);
    const elementLocalName = nameMatch[0].split(':').at(-1);
    const elementNamespaceUri = elementPrefix ? namespaces.get(elementPrefix) : namespaces.get('') ?? null;
    if (elementPrefix && !namespaces.has(elementPrefix)) errors.push(`undeclared-prefix:${elementPrefix}`);
    for (const attributeName of attributeNames) {
      const prefix = qnamePrefix(attributeName);
      if (prefix && prefix !== 'xmlns' && !namespaces.has(prefix)) errors.push(`undeclared-prefix:${prefix}`);
    }
    for (const [attributeName, value] of attributeEntries) {
      const prefix = qnamePrefix(attributeName);
      const localName = attributeName.split(':').at(-1);
      const mceAttribute = prefix && namespaces.get(prefix) === MCE_NAMESPACE;
      if (mceAttribute && MCE_PREFIX_LIST_ATTRIBUTES.has(localName)) {
        validateMceList(value, 'prefix', namespaces, errors);
      } else if (mceAttribute && MCE_QNAME_LIST_ATTRIBUTES.has(localName)) {
        validateMceList(value, 'qname', namespaces, errors);
      } else if (!prefix && elementNamespaceUri === MCE_NAMESPACE
        && elementLocalName === 'Choice' && localName === 'Requires') {
        validateMceList(value, 'prefix', namespaces, errors);
      }
    }
    if (elementNamespaceUri === MCE_NAMESPACE && elementLocalName === 'Choice'
      && !attributeEntries.some(([attributeName]) => attributeName === 'Requires')) {
      errors.push('missing-mce-choice-requires');
    }
    tags.push({
      name: nameMatch[0],
      localName: nameMatch[0].split(':').at(-1).toLowerCase(),
      attributes,
      attributeNames,
      namespaceUri: elementNamespaceUri,
    });
    if (!selfClosing) {
      elementStack.push(nameMatch[0]);
      namespaceStack.push(namespaces);
    }
  }
  if (documentElements !== 1) errors.push('document-element-count');
  if (elementStack.length > 0) errors.push('unclosed-element');
  return { tags, errors };
}

function inspectXmlFeatures(entry, text, diagnostics) {
  const parsed = parseXmlStartTags(text);
  const structuralError = parsed.errors.find((error) => !error.startsWith('undeclared-prefix:') && !error.startsWith('undeclared-mce-prefix:'));
  if (structuralError) {
    partialFeature(diagnostics, 'VIEWER_OOXML_XML_MALFORMED', `${entry}-${structuralError}`, 'xml');
    return;
  }
  const namespaceIncomplete = parsed.errors.some((error) => error.startsWith('undeclared-prefix:') || error.startsWith('undeclared-mce-prefix:'))
    || parsed.tags.some((tag) => tag.namespaceUri === null);
  if (namespaceIncomplete) {
    partialFeature(diagnostics, 'VIEWER_OOXML_NAMESPACE_UNDECLARED', entry, 'namespace');
  }
  for (const tag of parsed.tags) {
    for (const [name, value] of tag.attributes) {
      if ((name === 'xmlns' || name.startsWith('xmlns:')) && !KNOWN_NAMESPACES.has(value)) {
        partialFeature(diagnostics, 'VIEWER_OOXML_NAMESPACE_UNKNOWN', `${entry}-${value}`, 'namespace');
      }
    }
    const contentType = tag.attributes.get('contenttype');
    if (entry === '[Content_Types].xml' && (tag.localName === 'default' || tag.localName === 'override')) {
      const selectorName = tag.localName === 'default' ? 'extension' : 'partname';
      const requiredSelectorName = tag.localName === 'default' ? 'Extension' : 'PartName';
      const selector = tag.attributes.get(selectorName) ?? '';
      const selectorValid = tag.localName === 'default'
        ? /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(selector)
        : /^\/(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s?#]+$/u.test(selector);
      if (tag.namespaceUri !== CONTENT_TYPES_NAMESPACE
        || !tag.attributeNames.includes('ContentType')
        || !tag.attributeNames.includes(requiredSelectorName)
        || !selectorValid || !contentType) {
        partialFeature(diagnostics, 'VIEWER_OOXML_CONTENT_TYPE_INVALID', `${entry}-${tag.localName}`, 'content-type');
      }
    }
    if (contentType) {
      const normalizedContentType = contentType.toLowerCase();
      if (!KNOWN_CONTENT_TYPES.has(normalizedContentType) && !/^image\/[a-z0-9.+-]+$/.test(normalizedContentType)) {
        partialFeature(diagnostics, 'VIEWER_OOXML_CONTENT_TYPE_UNKNOWN', contentType, 'content-type');
      }
    }
    if (tag.localName === 'graphicdata') {
      const uri = tag.attributes.get('uri') ?? '';
      if (!KNOWN_DRAWING_URIS.has(uri)) partialFeature(diagnostics, 'VIEWER_OOXML_DRAWING_UNKNOWN', `${entry}-${uri}`, 'drawing');
    }
    if (entry.endsWith('.rels') && tag.localName === 'relationship') {
      const id = tag.attributes.get('id') ?? 'unknown';
      const type = tag.attributes.get('type') ?? '';
      const targetMode = tag.attributes.get('targetmode') ?? '';
      const target = tag.attributes.get('target') ?? '';
      if (/^external$/i.test(targetMode) || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
        partialFeature(diagnostics, 'VIEWER_OOXML_EXTERNAL_RELATIONSHIP', id, 'relationship');
      }
      if (!KNOWN_RELATIONSHIP_URIS.has(type)) {
        partialFeature(diagnostics, 'VIEWER_OOXML_RELATIONSHIP_UNKNOWN', id, 'relationship');
      }
    }
  }
  if (/(?:\btypeface|<w:font\b[^>]*\bw:name)\s*=\s*["'][^"']+["']/i.test(text)) {
    partialFeature(diagnostics, 'VIEWER_OOXML_FONT_UNVERIFIED', entry, 'font');
  }
  if (/<(?:w:documentProtection|p:modifyVerifier|p14:modifyVerifier)\b/i.test(text)) {
    partialFeature(diagnostics, 'VIEWER_OOXML_PROTECTION_PRESENT', entry, 'protection');
  }
}

function imageFacts(bytes) {
  if (bytes.byteLength >= 24
    && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20), frames: 1 };
  }
  if (bytes.byteLength >= 10
    && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let frames = 0;
    for (let index = 10; index < bytes.byteLength; index += 1) {
      if (bytes[index] === 0x2c) frames += 1;
    }
    return { width: view.getUint16(6, true), height: view.getUint16(8, true), frames: Math.max(1, frames) };
  }
  return null;
}

function inspectTables(text, budget) {
  let rows = 0;
  let cells = 0;
  const rowPattern = /<(?:w:tr|a:tr)\b[\s\S]*?<\/(?:w:tr|a:tr)>/g;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(text)) !== null) {
    rows += 1;
    if (rows > budget.max_table_rows) return 'VIEWER_LIMIT_TABLE_ROWS';
    let columns = 0;
    const cellPattern = /<(?:w:tc|a:tc)\b/g;
    while (cellPattern.exec(rowMatch[0]) !== null) {
      columns += 1;
      cells += 1;
      if (columns > budget.max_table_columns) return 'VIEWER_LIMIT_TABLE_COLUMNS';
      if (cells > budget.max_table_cells) return 'VIEWER_LIMIT_TABLE_CELLS';
    }
  }
  return null;
}

function zipEntryRatios(bytes, maxEntries) {
  if (bytes.byteLength < 22) return new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let index = bytes.byteLength - 22; index >= Math.max(0, bytes.byteLength - 65_557); index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) return new Map();
  const count = view.getUint16(eocd + 10, true);
  const ratios = new Map();
  let offset = view.getUint32(eocd + 16, true);
  for (let index = 0; index < Math.min(count, maxEntries + 1); index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) break;
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.byteLength) break;
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    ratios.set(name, uncompressed === 0 ? 0 : compressed === 0 ? Number.POSITIVE_INFINITY : uncompressed / compressed);
    offset = end;
  }
  return ratios;
}

function limitFailure(code, scope = { element_id: 'resource-budget' }) {
  return { code, severity: 'error', forces_partial: false, scope };
}

async function inventoryOoxml({ bytes, signal, budget, diagnostics, createAsset, officeCore: selectedOfficeCore }) {
  let archive;
  let totalBytes = 0;
  let xmlNodes = 0;
  let pages = 1;
  let physicalSlides = 0;
  let logicalSlides = 0;
  let sheets = 0;
  let hasWord = false;
  let hasPpt = false;
  try {
    archive = await selectedOfficeCore.openPptxZip(bytes);
    const entries = await archive.list();
    if (entries.length > budget.max_archive_entries) {
      return { limit: 'VIEWER_LIMIT_ARCHIVE_ENTRIES', totalBytes, entries: entries.length };
    }
    const entryRatios = zipEntryRatios(bytes, budget.max_archive_entries);
    for (const entry of entries) {
      if (signal?.aborted) return { cancelled: true, totalBytes, entries: entries.length };
      if (entry.endsWith('/')) continue;
      if (entry.startsWith('word/')) hasWord = true;
      if (entry.startsWith('ppt/')) hasPpt = true;
      if (/^ppt\/slides\/slide\d+\.xml$/i.test(entry)) {
        physicalSlides += 1;
        if (physicalSlides > budget.max_slides) return { limit: 'VIEWER_LIMIT_SLIDES', totalBytes, entries: entries.length };
      }
      if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(entry)) {
        sheets += 1;
        if (sheets > budget.max_sheets) return { limit: 'VIEWER_LIMIT_SHEETS', totalBytes, entries: entries.length };
      }
      const depth = entry.split('/').filter(Boolean).length;
      if (depth > budget.max_archive_depth) return { limit: 'VIEWER_LIMIT_ARCHIVE_DEPTH', totalBytes, entries: entries.length };
      const entryBytes = await archive.bytes(entry);
      if (!entryBytes) continue;
      if (entryBytes.byteLength > budget.max_entry_uncompressed_bytes) {
        return { limit: 'VIEWER_LIMIT_ARCHIVE_ENTRY_BYTES', totalBytes, entries: entries.length };
      }
      if ((entryRatios.get(entry) ?? 0) > budget.max_compression_ratio) {
        return { limit: 'VIEWER_LIMIT_COMPRESSION_RATIO', totalBytes, entries: entries.length };
      }
      totalBytes += entryBytes.byteLength;
      if (totalBytes > budget.max_total_uncompressed_bytes) {
        return { limit: 'VIEWER_LIMIT_ARCHIVE_TOTAL_BYTES', totalBytes, entries: entries.length };
      }
      if (bytes.byteLength > 0 && totalBytes / bytes.byteLength > budget.max_compression_ratio) {
        return { limit: 'VIEWER_LIMIT_COMPRESSION_RATIO', totalBytes, entries: entries.length };
      }
      if (!KNOWN_PART.test(entry) && !EMBEDDED_ENTRY.test(entry) && !MACRO_ENTRY.test(entry)) {
        partialFeature(diagnostics, 'VIEWER_OOXML_PART_UNKNOWN', entry, 'part');
      }
      if (EMBEDDED_ENTRY.test(entry)) {
        partialFeature(diagnostics, 'VIEWER_OOXML_EMBEDDED_OBJECT', entry, 'embedded');
      }
      if (MACRO_ENTRY.test(entry)) {
        partialFeature(diagnostics, 'VIEWER_OOXML_MACRO_PRESENT', entry, 'macro');
      }
      if (EXTERNAL_LINK_ENTRY.test(entry)) {
        partialFeature(diagnostics, 'VIEWER_OOXML_EXTERNAL_LINK', entry, 'external-link');
      }
      if (FONT_ENTRY.test(entry)) {
        partialFeature(diagnostics, 'VIEWER_OOXML_FONT_UNVERIFIED', entry, 'font');
      }
      if (DRAWING_ENTRY.test(entry)) {
        partialFeature(diagnostics, 'VIEWER_OOXML_DRAWING_UNKNOWN', entry, 'drawing');
      }
      if (/\/theme\//i.test(entry)) {
        partialFeature(diagnostics, 'VIEWER_OOXML_THEME_MASTER_UNVERIFIED', entry, 'theme-master');
      }
      if (MEDIA_ENTRY.test(entry)) {
        if (IMAGE_ENTRY.test(entry)) {
          const facts = imageFacts(entryBytes);
          if (facts) {
            if (facts.width > budget.max_image_width_px) return { limit: 'VIEWER_LIMIT_IMAGE_WIDTH', totalBytes, entries: entries.length };
            if (facts.height > budget.max_image_height_px) return { limit: 'VIEWER_LIMIT_IMAGE_HEIGHT', totalBytes, entries: entries.length };
            if (BigInt(facts.width) * BigInt(facts.height) > BigInt(budget.max_image_pixels)) {
              return { limit: 'VIEWER_LIMIT_IMAGE_PIXELS', totalBytes, entries: entries.length };
            }
            if (facts.frames > budget.max_animation_frames) return { limit: 'VIEWER_LIMIT_ANIMATION_FRAMES', totalBytes, entries: entries.length };
          } else {
            partialFeature(diagnostics, 'VIEWER_IMAGE_METADATA_UNVERIFIED', entry, 'image');
          }
        }
        createAsset(entryBytes, 'application/octet-stream');
      }
      if (XML_ENTRY.test(entry)) {
        if (entryBytes.byteLength > budget.max_xml_text_bytes) {
          return { limit: 'VIEWER_LIMIT_XML_TEXT', totalBytes, entries: entries.length };
        }
        const text = new TextDecoder().decode(entryBytes);
        const stats = xmlStats(text, budget.max_xml_nodes - xmlNodes);
        xmlNodes += stats.nodes;
        if (stats.maxDepth > budget.max_xml_depth) {
          return { limit: 'VIEWER_LIMIT_XML_DEPTH', totalBytes, entries: entries.length };
        }
        if (stats.nodesExceeded || xmlNodes > budget.max_xml_nodes) {
          return { limit: 'VIEWER_LIMIT_XML_NODES', totalBytes, entries: entries.length };
        }
        if (entry === 'word/document.xml') {
          const pageBreaks = /<w:br\b[^>]*\bw:type="page"[^>]*\/?\s*>/g;
          while (pageBreaks.exec(text) !== null) {
            pages += 1;
            if (pages > budget.max_pages) return { limit: 'VIEWER_LIMIT_PAGES', totalBytes, entries: entries.length };
          }
        }
        if (entry === 'ppt/presentation.xml') {
          const slideReferences = /<p:sldId\b[^>]*>/g;
          while (slideReferences.exec(text) !== null) {
            logicalSlides += 1;
            if (logicalSlides > budget.max_slides) {
              return { limit: 'VIEWER_LIMIT_SLIDES', totalBytes, entries: entries.length };
            }
          }
        }
        const tableLimit = inspectTables(text, budget);
        if (tableLimit) return { limit: tableLimit, totalBytes, entries: entries.length };
        inspectXmlFeatures(entry, text, diagnostics);
      }
    }
    return {
      kind: hasWord && hasPpt ? 'ambiguous' : hasWord ? 'word' : hasPpt ? 'ppt' : null,
      totalBytes,
      entries: entries.length
    };
  } catch (error) {
    if (signal?.aborted || isAbortFailure(error)) return { cancelled: true, totalBytes, entries: 0 };
    return { corrupt: true, totalBytes, entries: 0 };
  } finally {
    await archive?.close?.();
  }
}

function isAbortFailure(error) {
  return error?.name === 'AbortError'
    || error?.name === 'MountAbortedError'
    || error?.code === 'ABORT_ERR'
    || error?.code === 'ERR_ABORTED';
}

function collectStrings(value, limit, traversal, diagnostics) {
  const found = [];
  const seen = new WeakSet();
  const pending = [{ kind: 'value', value }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame.kind === 'array') {
      if (frame.index >= frame.value.length) continue;
      if (traversal.remaining <= 0) {
        diagnostics.markOutputTruncated();
        break;
      }
      traversal.remaining -= 1;
      pending.push({ ...frame, index: frame.index + 1 });
      pending.push({ kind: 'value', value: frame.value[frame.index] });
      continue;
    }
    if (frame.kind === 'object') {
      if (frame.index >= MODEL_KEYS.length) continue;
      const key = MODEL_KEYS[frame.index];
      pending.push({ ...frame, index: frame.index + 1 });
      if (!Object.hasOwn(frame.value, key)) continue;
      if (traversal.remaining <= 0) {
        diagnostics.markOutputTruncated();
        break;
      }
      traversal.remaining -= 1;
      pending.push({ kind: 'value', value: frame.value[key] });
      continue;
    }
    const current = frame.value;
    if (typeof current === 'string') {
      const normalized = current.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;
      if (found.length >= limit) {
        diagnostics.markOutputTruncated();
        break;
      }
      found.push(normalized);
      continue;
    }
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) pending.push({ kind: 'array', value: current, index: 0 });
    else pending.push({ kind: 'object', value: current, index: 0 });
    if (found.length >= limit && pending.length > 0) {
      diagnostics.markOutputTruncated();
      break;
    }
  }
  return found;
}

async function flushAnimationFrames(count = 4) {
  if (typeof requestAnimationFrame !== 'function') return;
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

function transferWordDiagnostics(status, budget, diagnostics) {
  const coreDiagnostics = status?.diagnostics;
  if (!coreDiagnostics || !Number.isSafeInteger(coreDiagnostics.length) || coreDiagnostics.length <= 0) return;
  const remaining = Math.max(0, budget.max_diagnostics - diagnostics.diagnostics.length);
  const transferCount = Math.min(coreDiagnostics.length, remaining);
  for (let index = 0; index < transferCount; index += 1) {
    const diagnostic = coreDiagnostics[index];
    diagnostics.add({
      code: diagnostic?.code,
      severity: diagnostic?.severity,
      forces_partial: status.state === 'partial' || diagnostic?.forces_partial === true,
      scope: safeScope(diagnostic?.location ?? `diagnostic-${index + 1}`, 'core')
    });
  }
  if (coreDiagnostics.length > transferCount) diagnostics.markOutputTruncated();
}

async function parseDocx(bytes, signal, budget, diagnostics, coreContext, selectedOfficeCore) {
  if (typeof document?.createElement !== 'function') throw new Error('DOCX parser requires an isolated DOM');
  const container = document.createElement('div');
  let mounted;
  try {
    mounted = await selectedOfficeCore.mountBundledWordViewer(
      { fileName: 'viewer-input.docx', data: bytes },
      container,
      coreContext,
      {
        styleIsolation: 'scoped',
        signal,
        limits: {
          maxInputBytes: budget.max_input_bytes,
          maxDecompressedBytes: budget.max_total_uncompressed_bytes,
          maxPages: budget.max_pages,
          maxImageBytes: budget.max_entry_uncompressed_bytes,
          maxEmbeddedFiles: budget.max_archive_entries
        }
      }
    );
    if (signal?.aborted) return { state: 'cancelled', model: { kind: 'docx', text: [], blocks: [] } };
    const coreStatus = mounted?.status;
    transferWordDiagnostics(coreStatus, budget, diagnostics);
    if (coreStatus?.state === 'aborted') {
      return { state: 'cancelled', model: { kind: 'docx', text: [], blocks: [] } };
    }
    await flushAnimationFrames();
    if (signal?.aborted) return { state: 'cancelled', model: { kind: 'docx', text: [], blocks: [] } };
    const text = [];
    const blocks = [];
    const paragraphs = container.querySelectorAll('p');
    for (let index = 0; index < paragraphs.length; index += 1) {
      if (text.length >= budget.max_text_items && blocks.length >= budget.max_model_items) {
        diagnostics.markOutputTruncated();
        break;
      }
      const value = paragraphs[index].textContent.replace(/\s+/g, ' ').trim();
      if (!value) continue;
      if (text.length < budget.max_text_items) text.push(value);
      else diagnostics.markOutputTruncated();
      if (blocks.length < budget.max_model_items) blocks.push({ block_id: `block-${blocks.length + 1}`, text: value });
      else diagnostics.markOutputTruncated();
    }
    if (text.length === 0 && blocks.length === 0) {
      const value = container.textContent.replace(/\s+/g, ' ').trim();
      if (value) {
        text.push(value);
        blocks.push({ block_id: 'block-1', text: value });
      }
    }
    const coreState = coreStatus?.state;
    return {
      state: coreState === 'ready'
        ? 'ready'
        : coreState === 'partial'
          ? 'partial'
          : coreState === 'aborted'
            ? 'cancelled'
            : 'corrupt',
      model: { kind: 'docx', text, blocks }
    };
  } finally {
    mounted?.dispose?.();
    container.replaceChildren();
    await flushAnimationFrames();
  }
}

async function parsePptx(bytes, signal, budget, diagnostics, selectedOfficeCore) {
  const parsed = await selectedOfficeCore.parsePptxVscode(bytes, {
    signal,
    limits: {
      maxInputBytes: budget.max_input_bytes,
      maxEntries: budget.max_archive_entries,
      maxDecompressedBytes: budget.max_total_uncompressed_bytes,
      maxParseMillis: budget.parse_deadline_ms
    }
  });
  if (signal?.aborted) return { state: 'cancelled', model: { kind: 'pptx', text: [], slides: [] } };
  const coreDiagnostics = parsed?.result?.diagnostics ?? [];
  for (let index = 0; index < coreDiagnostics.length; index += 1) {
    if (index >= budget.max_diagnostics) {
      diagnostics.markOutputTruncated();
      break;
    }
    diagnostics.add(coreDiagnostics[index]);
  }
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
  const slideLimit = Math.min(budget.max_slides, budget.max_model_items);
  const slides = [];
  const aggregateText = [];
  const traversal = { remaining: budget.max_model_items };
  if (sourceSlides.length > slideLimit) diagnostics.markOutputTruncated();
  const visitCount = Math.min(sourceSlides.length, slideLimit);
  for (let index = 0; index < visitCount; index += 1) {
    if (signal?.aborted) return { state: 'cancelled', model: { kind: 'pptx', text: [], slides: [] } };
    const slide = sourceSlides[index];
    const slideText = collectStrings(slide?.elements ?? [], budget.max_text_items, traversal, diagnostics);
    slides.push({
      slide_number: slide?.slideNumber ?? index + 1,
      text: slideText
    });
    for (let textIndex = 0; textIndex < slideText.length; textIndex += 1) {
      if (aggregateText.length >= budget.max_text_items) {
        diagnostics.markOutputTruncated();
        break;
      }
      aggregateText.push(slideText[textIndex]);
    }
  }
  return {
    state: parsed.result.status === 'partial' ? 'partial' : 'ready',
    model: {
      kind: 'pptx',
      text: aggregateText,
      total_slides: sourceSlides.length,
      slides
    }
  };
}

export function createViewerHostAdapter({
  trusted_context: trustedContext,
  now = () => Date.now(),
  create_asset_url: createAssetUrl,
  revoke_asset_url: revokeAssetUrl,
  base_core: selectedBaseCore = baseCore,
  office_core: selectedOfficeCore = officeCore
} = {}) {
  if (!['surface', 'worker'].includes(trustedContext?.audience?.kind)
    || typeof trustedContext?.audience?.id !== 'string'
    || trustedContext.audience.id.length === 0
    || trustedContext?.operation !== 'read'
    || typeof trustedContext?.expected_revision !== 'string'
    || trustedContext.expected_revision.length === 0) {
    throw new TypeError('trusted_context must bind audience, operation, and expected_revision');
  }

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
      return normalizeDiagnostic(diagnostic);
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
        const container = selectedBaseCore.sniffContainer(header);
        if (container !== 'zip') {
          diagnostics.add({ code: 'VIEWER_CONTAINER_UNRECOGNIZED', severity: 'error', forces_partial: false });
          result = output({ detected: { container, format: null }, state: 'corrupt', diagnostics, metrics });
          return result;
        }
        const probed = await selectedBaseCore.probeContainer(bytes, container, {
          signal: input.signal,
          limits: { maxEntries: budget.max_archive_entries }
        });
        const inventory = await inventoryOoxml({
          bytes,
          signal: input.signal,
          budget,
          diagnostics,
          createAsset: createRequestAsset,
          officeCore: selectedOfficeCore
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
            logger: Object.freeze({
              log: (diagnostic) => {
                const normalized = adapter.reportDiagnostic(diagnostic);
                diagnostics.add(normalized);
                return normalized;
              }
            })
          });
          parsed = await parseDocx(bytes, input.signal, budget, diagnostics, coreContext, selectedOfficeCore);
        } else {
          parsed = await parsePptx(bytes, input.signal, budget, diagnostics, selectedOfficeCore);
        }
        if (adapter.isCancelled(input.signal) || parsed.state === 'cancelled') {
          result = output({
            detected: { container, format: descriptor.format, descriptor_id: input.descriptor_id },
            state: 'cancelled',
            model: parsed.model,
            diagnostics,
            metrics
          });
          return result;
        }
        let state = parsed.state;
        if (adapter.isCancelled(input.signal)) state = 'cancelled';
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
        if (adapter.isCancelled(input.signal) || isAbortFailure(error)) {
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
        if (result) {
          result.metrics.ephemeral_asset_urls_revoked = metrics.ephemeral_asset_urls_revoked;
          result.metrics.output_truncated = diagnostics.truncated;
        }
      }
    }
  };

  return Object.freeze(adapter);
}
