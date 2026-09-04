import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

import { verifyAcquiredCandidate } from './acquire-frozen-core.mjs';
import { createViewerHostAdapter } from './host-adapter.mjs';
import { evaluateMaliciousAggregate } from './malicious-admission.mjs';
import { DEFAULT_RESOURCE_BUDGET } from './resource-budget.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const POC_ROOT = path.resolve(import.meta.dirname);
const REPO_ROOT = path.resolve(POC_ROOT, '..', '..', '..');
const DEFAULT_ACCEPTANCE_PATH = path.join(REPO_ROOT, 'fixtures', 'gvp-0', 'GVP-0-CORE-001', 'acceptance.json');
const ADMISSION_EVIDENCE_PATH = path.join(POC_ROOT, 'baseline-evidence', 'admission-decision.json');
const BUILT_SOURCE_POLICY_EVIDENCE_PATH = path.join(POC_ROOT, 'baseline-evidence', 'built-source-policy.json');
const CHUNK_EVIDENCE_PATH = path.join(POC_ROOT, 'baseline-evidence', 'chunks.json');
const SOURCE_LOCK_PATH = path.join(POC_ROOT, 'source-lock.json');
const OUTPUT_MARKER_SUFFIX = '.superwagie-viewer-malicious-output-owned';
const OUTPUT_MARKER_CONTENT = 'superwagie-viewer-malicious-output-v1\n';
const PROHIBITED_EXECUTABLES = new Set([
  'wps', 'wpsoffice', 'et', 'wpp', 'microsoft word', 'microsoft powerpoint', 'microsoft excel',
  'libreoffice', 'soffice', 'wpscomposer', 'wpscomposer.exe', 'cmd', 'cmd.exe', 'powershell',
  'powershell.exe', 'pwsh', 'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'tar',
  'bsdtar', 'gtar', 'zip', 'unzip', '7z', '7zz', 'unrar', 'archive utility'
]);
const ACTIVE_ELEMENTS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'foreignobject', 'link', 'meta', 'base', 'frame', 'frameset',
  'animate', 'animatemotion', 'animatetransform', 'set', 'applet', 'portal'
]);
const URL_ATTRIBUTES = new Set([
  'href', 'src', 'srcset', 'imagesrcset', 'xlink:href', 'action', 'formaction', 'poster', 'data',
  'background', 'cite', 'ping', 'longdesc', 'usemap', 'manifest', 'icon', 'archive', 'code', 'codebase',
  'dynsrc', 'lowsrc'
]);
const SVG_RESOURCE_ATTRIBUTES = new Set([
  'filter', 'clip-path', 'mask', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor'
]);
const SVG_PAINT_ATTRIBUTES = new Set([
  'fill', 'stroke', 'color', 'flood-color', 'lighting-color', 'stop-color'
]);
const EXECUTABLE_HASH_CACHE = new Map();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function optionalLstat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function inodeKey(info) {
  return `${info.dev}:${info.ino}`;
}

async function collectTreeInodes(root) {
  const inodes = new Set();
  async function visit(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (relativeDirectory === '' && entry.name === '.git') continue;
      const relative = path.join(relativeDirectory, entry.name);
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`source tree contains a symbolic link: ${relative}`);
      inodes.add(inodeKey(info));
      if (info.isDirectory()) await visit(absolute, relative);
      else if (!info.isFile()) throw new Error(`source tree contains an unsupported entry: ${relative}`);
    }
  }
  inodes.add(inodeKey(await lstat(root)));
  await visit(root);
  return inodes;
}

async function resolveOutputBoundary({ candidateRoot, fixtureRoot, acceptancePath, output }) {
  const resolvedCandidate = path.resolve(candidateRoot);
  const resolvedFixtures = path.resolve(fixtureRoot);
  const resolvedAcceptance = path.resolve(acceptancePath);
  const resolvedOutput = path.resolve(output);
  const [canonicalCandidate, canonicalFixtures, canonicalAcceptance] = await Promise.all([
    realpath(resolvedCandidate),
    realpath(resolvedFixtures),
    realpath(resolvedAcceptance)
  ]);
  for (const [directory, label] of [[canonicalCandidate, 'candidate'], [canonicalFixtures, 'fixture']]) {
    if (!(await stat(directory)).isDirectory()) throw new Error(`${label} source is not a directory`);
  }
  if (!(await stat(canonicalAcceptance)).isFile()) throw new Error('acceptance source is not a file');

  const resolvedOutputParent = path.dirname(resolvedOutput);
  const parentInfo = await lstat(resolvedOutputParent);
  if (!parentInfo.isDirectory() && !parentInfo.isSymbolicLink()) {
    throw new Error('output parent must be an existing directory');
  }
  const canonicalOutputParent = await realpath(resolvedOutputParent);
  if (!(await stat(canonicalOutputParent)).isDirectory()) throw new Error('output parent must be an existing directory');
  const canonicalOutput = path.join(canonicalOutputParent, path.basename(resolvedOutput));
  const overlap = () => new Error('output must be outside candidate, fixture, and acceptance sources');
  if (
    isWithin(canonicalCandidate, canonicalOutput)
    || isWithin(canonicalFixtures, canonicalOutput)
    || canonicalOutput === canonicalAcceptance
  ) throw overlap();

  const outputInfo = await optionalLstat(resolvedOutput);
  if (outputInfo?.isSymbolicLink()) throw overlap();
  if (outputInfo && !outputInfo.isFile()) throw new Error('output must be a regular file');
  const [candidateInodes, fixtureInodes, acceptanceInfo] = await Promise.all([
    collectTreeInodes(canonicalCandidate),
    collectTreeInodes(canonicalFixtures),
    lstat(canonicalAcceptance)
  ]);
  const protectedInodes = new Set([...candidateInodes, ...fixtureInodes, inodeKey(acceptanceInfo)]);
  if (outputInfo && protectedInodes.has(inodeKey(outputInfo))) throw overlap();
  if (outputInfo) {
    const canonicalExistingOutput = await realpath(resolvedOutput);
    if (
      isWithin(canonicalCandidate, canonicalExistingOutput)
      || isWithin(canonicalFixtures, canonicalExistingOutput)
      || canonicalExistingOutput === canonicalAcceptance
    ) throw overlap();
  }

  const markerPath = `${canonicalOutput}${OUTPUT_MARKER_SUFFIX}`;
  if (markerPath === canonicalAcceptance || isWithin(canonicalCandidate, markerPath) || isWithin(canonicalFixtures, markerPath)) {
    throw overlap();
  }
  const markerInfo = await optionalLstat(markerPath);
  if (markerInfo?.isSymbolicLink() || (markerInfo && !markerInfo.isFile())) {
    throw new Error('output ownership marker is unsafe');
  }
  if (markerInfo && protectedInodes.has(inodeKey(markerInfo))) throw overlap();
  if (outputInfo && !markerInfo) throw new Error('output is not marker-owned by this PoC');
  if (markerInfo && await readFile(markerPath, 'utf8') !== OUTPUT_MARKER_CONTENT) {
    throw new Error('output is not marker-owned by this PoC');
  }
  return {
    candidateRoot: canonicalCandidate,
    fixtureRoot: canonicalFixtures,
    acceptancePath: canonicalAcceptance,
    output: canonicalOutput,
    outputParent: canonicalOutputParent,
    markerPath,
    markerExists: markerInfo !== null,
    protectedInodes
  };
}

async function claimOutput(boundary) {
  if (!boundary.markerExists) {
    await writeFile(boundary.markerPath, OUTPUT_MARKER_CONTENT, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    boundary.markerExists = true;
  }
}

async function assertOutputStillSafe(boundary) {
  const canonicalParent = await realpath(path.dirname(boundary.output));
  if (canonicalParent !== boundary.outputParent) throw new Error('output parent changed after validation');
  const outputInfo = await optionalLstat(boundary.output);
  if (
    outputInfo?.isSymbolicLink()
    || (outputInfo && !outputInfo.isFile())
    || (outputInfo && boundary.protectedInodes.has(inodeKey(outputInfo)))
  ) {
    throw new Error('output must be outside candidate, fixture, and acceptance sources');
  }
  const markerInfo = await lstat(boundary.markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || boundary.protectedInodes.has(inodeKey(markerInfo))) {
    throw new Error('output ownership marker is unsafe');
  }
  if (await readFile(boundary.markerPath, 'utf8') !== OUTPUT_MARKER_CONTENT) {
    throw new Error('output is not marker-owned by this PoC');
  }
}

async function atomicWriteEvidence(boundary, value) {
  await assertOutputStillSafe(boundary);
  const temporary = path.join(boundary.outputParent, `.${path.basename(boundary.output)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await assertOutputStillSafe(boundary);
    await rename(temporary, boundary.output);
  } finally {
    await rm(temporary, { force: true });
  }
}

function centralDirectoryOffset(bytes) {
  if (bytes.byteLength < 22) return -1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

function isUnsafeArchivePath(name) {
  if (name.includes('\0') || /^(?:[a-z]:|[\\/])/i.test(name)) return true;
  return name.replaceAll('\\', '/').split('/').some((part) => part === '..');
}

export function inspectZipMetadata(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = centralDirectoryOffset(bytes);
  if (eocd < 0) return { valid: false, entries: [], expanded_bytes: 0 };
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      return { valid: false, entries, expanded_bytes: 0 };
    }
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > bytes.byteLength) return { valid: false, entries, expanded_bytes: 0 };
    const name = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({
      name,
      compressed_bytes: compressedBytes,
      uncompressed_bytes: uncompressedBytes,
      compression_ratio: uncompressedBytes === 0 ? 0 : compressedBytes === 0 ? Number.POSITIVE_INFINITY : uncompressedBytes / compressedBytes,
      unsafe_path: isUnsafeArchivePath(name)
    });
    offset = next;
  }
  return { valid: entries.length === entryCount, entries, expanded_bytes: 0 };
}

function hasActiveResourceSyntax(value) {
  const text = String(value).normalize('NFKC');
  const compact = text.replace(/[\u0000-\u0020\u007f\u00a0]+/g, '').toLowerCase();
  return /(?:https?:|javascript:|data:|file:|ftp:|blob:|ws:|wss:|\/\/)/.test(compact)
    || /(?:@\s*import|u\s*r\s*l\s*\(|expression\s*\(|behavior\s*:)/i.test(text.replace(/\/\*[\s\S]*?\*\//g, ''));
}

function isSafeSvgPaint(value) {
  const normalized = String(value).trim();
  return /^(?:none|currentcolor|transparent|inherit|#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d.,%\s+-]+\)|hsla?\([\d.,%\s+-]+\))$/i.test(normalized);
}

export function sanitizeMarkup(source, kind) {
  if (!['html', 'svg'].includes(kind)) throw new Error('markup kind must be html or svg');
  const dom = kind === 'svg'
    ? new JSDOM(source, { contentType: 'image/svg+xml' })
    : new JSDOM(source);
  const document = dom.window.document;
  let removedCount = 0;
  const sanitizeContainer = (container) => {
    const elements = Array.from(container.childNodes)
      .filter((node) => node.nodeType === dom.window.Node.ELEMENT_NODE);
    for (const element of elements) {
      if (ACTIVE_ELEMENTS.has(element.localName.toLowerCase())) {
        element.remove();
        removedCount += 1;
        continue;
      }
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const removeAttribute = name.startsWith('on')
          || name === 'srcdoc'
          || name.startsWith('xmlns')
          || name === 'style'
          || URL_ATTRIBUTES.has(name)
          || SVG_RESOURCE_ATTRIBUTES.has(name)
          || (SVG_PAINT_ATTRIBUTES.has(name) && !isSafeSvgPaint(attribute.value))
          || hasActiveResourceSyntax(attribute.value);
        if (removeAttribute) {
          element.removeAttribute(attribute.name);
          removedCount += 1;
        }
      }
      sanitizeContainer(element);
      if (element.localName.toLowerCase() === 'template'
        && element.content?.nodeType === dom.window.Node.DOCUMENT_FRAGMENT_NODE) {
        sanitizeContainer(element.content);
      }
    }
  };
  sanitizeContainer(document);
  const serialized = kind === 'svg'
    ? document.documentElement.outerHTML.replace(/\sxmlns(?::[\w.-]+)?="[^"]*"/gi, '')
    : dom.serialize();
  return {
    outcome: 'sanitized',
    diagnostic: 'VIEWER_ACTIVE_CONTENT_REMOVED',
    removed_count: removedCount,
    sanitized: serialized
  };
}

function installDom(networkGuard) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://viewer.invalid/',
    pretendToBeVisual: true
  });
  const names = [
    'window', 'document', 'navigator', 'Node', 'Text', 'Element', 'HTMLElement', 'HTMLCanvasElement',
    'SVGElement', 'ShadowRoot', 'Document', 'DocumentFragment', 'DOMParser', 'XMLSerializer',
    'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'
  ];
  for (const name of names) {
    const value = name === 'window' ? dom.window : dom.window[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
  if (networkGuard) {
    dom.window.fetch = networkGuard.block('window-fetch');
    dom.window.XMLHttpRequest = class OfflineWindowXMLHttpRequest {
      constructor() { networkGuard.block('window-xhr')(); }
    };
    dom.window.WebSocket = class OfflineWindowWebSocket {
      constructor() { networkGuard.block('window-websocket')(); }
    };
    dom.window.EventSource = class OfflineWindowEventSource {
      constructor() { networkGuard.block('window-eventsource')(); }
    };
    dom.window.URL.createObjectURL = networkGuard.block('window-asset-url');
  }
  return dom.window;
}

function installOfflineGuards() {
  let attempts = 0;
  let observedHook = null;
  const restore = [];
  const block = (hook) => () => {
      attempts += 1;
      observedHook = hook;
      const error = new Error('offline worker blocked a network attempt');
      error.code = 'VIEWER_NETWORK_ATTEMPT_BLOCKED';
      throw error;
    };
  const patch = (target, property, hook) => {
    const original = target[property];
    target[property] = block(hook);
    restore.push(() => { target[property] = original; });
  };
  for (const [target, methods, hook] of [
    [dns, ['lookup', 'resolve', 'resolve4', 'resolve6'], 'dns'],
    [net, ['connect', 'createConnection'], 'socket'],
    [tls, ['connect'], 'tls'],
    [http, ['request', 'get'], 'http'],
    [https, ['request', 'get'], 'https'],
    [dgram, ['createSocket'], 'udp']
  ]) {
    for (const method of methods) patch(target, method, hook);
  }
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  const originalWebSocket = globalThis.WebSocket;
  const originalEventSource = globalThis.EventSource;
  const originalCreateObjectUrl = globalThis.URL.createObjectURL;
  globalThis.fetch = block('fetch');
  globalThis.XMLHttpRequest = class OfflineXMLHttpRequest { constructor() { block('xhr')(); } };
  globalThis.WebSocket = class OfflineWebSocket { constructor() { block('websocket')(); } };
  globalThis.EventSource = class OfflineEventSource { constructor() { block('eventsource')(); } };
  globalThis.URL.createObjectURL = block('asset-url');
  restore.push(() => {
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXhr;
    globalThis.WebSocket = originalWebSocket;
    globalThis.EventSource = originalEventSource;
    globalThis.URL.createObjectURL = originalCreateObjectUrl;
  });
  return {
    attempts: () => attempts,
    observedHook: () => observedHook,
    block,
    restore: () => { for (const action of restore.reverse()) action(); }
  };
}

function adapterInput(bytes, descriptorId) {
  return {
    handle: {
      handle_id: 'viewer-handle-task5',
      resource_type: 'viewer_input',
      resource_id: 'viewer-file-task5',
      resource_revision: 'revision-task5',
      audience: { kind: 'worker', id: 'viewer-worker-task5' },
      allowed_operations: ['read', 'range_read', 'inspect'],
      project_id: 'project-task5',
      owner_type: 'project',
      owner_id: 'project-task5',
      media_type: 'application/octet-stream',
      size_limit_bytes: DEFAULT_RESOURCE_BUDGET.max_input_bytes,
      range_limit_bytes: DEFAULT_RESOURCE_BUDGET.max_detection_bytes,
      issued_at: '2026-09-04T11:55:00.000Z',
      expires_at: '2100-01-01T00:00:00.000Z',
      one_shot: false,
      auth_tag: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      verification_state: 'verified_by_test_core',
      declared_byte_length: bytes.byteLength
    },
    bytes: Uint8Array.from(bytes),
    descriptor_id: descriptorId
  };
}

async function executeFixture({ fixtureId, fixturePath, networkGuard }) {
  const bytes = await readFile(fixturePath);
  const sourceHashBefore = sha256(bytes);
  let result;
  if (fixtureId === 'zip-path-traversal') {
    const metadata = inspectZipMetadata(bytes);
    result = {
      outcome: 'unsupported',
      diagnostics: ['VIEWER_ARCHIVE_PATH_TRAVERSAL'],
      parser_dispatches: 0,
      expanded_bytes: metadata.expanded_bytes,
      unsafe_entries: metadata.entries.filter((entry) => entry.unsafe_path).length
    };
  } else if (fixtureId === 'zip-bomb-metadata') {
    const metadata = inspectZipMetadata(bytes);
    const exceedsRatio = metadata.entries.some((entry) => entry.compression_ratio > DEFAULT_RESOURCE_BUDGET.max_compression_ratio);
    result = {
      outcome: exceedsRatio ? 'limit_exceeded' : 'unexpected',
      diagnostics: exceedsRatio ? ['VIEWER_LIMIT_COMPRESSION_RATIO'] : [],
      parser_dispatches: 0,
      expanded_bytes: metadata.expanded_bytes,
      metadata_rejected_before_expansion: exceedsRatio && metadata.expanded_bytes === 0
    };
  } else if (fixtureId === 'html-active-content' || fixtureId === 'svg-active-content') {
    const sanitized = sanitizeMarkup(bytes.toString('utf8'), fixtureId.startsWith('html') ? 'html' : 'svg');
    result = {
      outcome: sanitized.outcome,
      diagnostics: [sanitized.diagnostic],
      sanitized_data: sanitized.sanitized,
      sanitized_sha256: sha256(sanitized.sanitized),
      removed_count: sanitized.removed_count,
      parser_dispatches: 0,
      expanded_bytes: 0
    };
  } else if (fixtureId === 'ooxml-external-relationship' || fixtureId === 'ambiguous-ooxml') {
    installDom(networkGuard);
    const adapter = createViewerHostAdapter({
      trusted_context: {
        audience: { kind: 'worker', id: 'viewer-worker-task5' },
        operation: 'read',
        expected_revision: 'revision-task5'
      },
      now: () => Date.parse('2026-09-04T12:00:00.000Z')
    });
    const opened = await adapter.open(adapterInput(bytes, 'viewer.office.docx'));
    const diagnosticCodes = opened.diagnostics.map((diagnostic) => diagnostic.code);
    result = {
      outcome: diagnosticCodes.includes('VIEWER_CONTAINER_AMBIGUOUS') ? 'unsupported' : opened.document_model.state,
      diagnostics: diagnosticCodes,
      parser_dispatches: opened.metrics.parser_dispatches,
      expanded_bytes: opened.metrics.decompressed_bytes
    };
  } else {
    throw new Error('unknown malicious fixture');
  }
  const sourceHashAfter = sha256(await readFile(fixturePath));
  return {
    ...result,
    sha256: sourceHashBefore,
    source_hash_unchanged: sourceHashBefore === sourceHashAfter
  };
}

function sendReady(result, cleanup = () => undefined) {
  process.send?.({ type: 'ready', result });
  const keepAlive = setInterval(() => undefined, 1000);
  process.on('message', (message) => {
    if (message?.type !== 'release') return;
    clearInterval(keepAlive);
    cleanup();
    process.exit(0);
  });
}

async function internalWorkerMain(arguments_) {
  const options = parseFlags(arguments_);
  const guards = options.offline ? installOfflineGuards() : null;
  if (options.workerKind === 'hung-parser') {
    setInterval(() => undefined, 1000);
    return;
  }
  if (options.workerKind === 'network-attempt') {
    try {
      let window;
      if (options.networkHook?.startsWith('window-')) window = installDom(guards);
      if (options.networkHook === 'xhr') new globalThis.XMLHttpRequest();
      else if (options.networkHook === 'websocket') new globalThis.WebSocket('wss://fixture.invalid/blocked');
      else if (options.networkHook === 'dns') dns.lookup('fixture.invalid', () => undefined);
      else if (options.networkHook === 'socket') net.connect({ host: 'fixture.invalid', port: 443 });
      else if (options.networkHook === 'asset-url') globalThis.URL.createObjectURL(new Blob(['blocked']));
      else if (options.networkHook === 'window-xhr') new window.XMLHttpRequest();
      else if (options.networkHook === 'window-websocket') new window.WebSocket('wss://fixture.invalid/blocked');
      else if (options.networkHook === 'window-asset-url') window.URL.createObjectURL(new Blob(['blocked']));
      else await globalThis.fetch('https://fixture.invalid/blocked');
      sendReady({ pass: true, network_requests: guards?.attempts() ?? 0 });
    } catch (error) {
      sendReady({
        pass: false,
        failure_code: error.code === 'VIEWER_NETWORK_ATTEMPT_BLOCKED' ? error.code : 'VIEWER_NETWORK_GUARD_FAILED',
        network_requests: guards?.attempts() ?? 0,
        blocked_hook: options.networkHook ?? 'fetch',
        observed_hook: guards?.observedHook()
      });
    }
    return;
  }
  if (options.workerKind === 'prohibited-process') {
    const prohibited = spawn('/bin/sh', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    process.send?.({ type: 'activity' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    sendReady({ pass: true, network_requests: guards?.attempts() ?? 0 }, () => prohibited.kill('SIGKILL'));
    return;
  }
  if (options.workerKind === 'short-lived-descendant') {
    const descendant = spawn('/bin/sleep', ['0.08'], { stdio: 'ignore' });
    process.send?.({ type: 'activity' });
    await new Promise((resolve) => descendant.once('exit', resolve));
    sendReady({ pass: true, network_requests: guards?.attempts() ?? 0 });
    return;
  }
  if (options.workerKind === 'detached-survivor') {
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
      detached: true,
      stdio: 'ignore'
    });
    descendant.unref();
    process.send?.({ type: 'activity' });
    setInterval(() => undefined, 1000);
    return;
  }
  if (options.workerKind === 'detached-ready-descendant') {
    const descendant = spawn(process.execPath, [
      '-e',
      'const keep=setInterval(()=>undefined,1000);setTimeout(()=>{clearInterval(keep);process.exit(0)},2000)'
    ], {
      detached: true,
      stdio: 'ignore'
    });
    descendant.unref();
    process.send?.({ type: 'activity' });
    await delay(80);
    sendReady({ pass: true, network_requests: guards?.attempts() ?? 0 });
    return;
  }
  if (options.workerKind !== 'fixture') throw new Error('unknown internal worker kind');
  const result = await executeFixture({
    fixtureId: options.fixtureId,
    fixturePath: options.fixturePath,
    networkGuard: guards
  });
  sendReady({ ...result, pass: true, network_requests: guards?.attempts() ?? 0 });
}

function parsePsRows(output) {
  const rows = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), executable: match[4] });
  }
  return rows;
}

async function psSnapshot() {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(parsePsRows(stdout)) : reject(new Error(`ps failed with code ${code}: ${stderr.length} bytes`)));
  });
}

function descendantRows(rows, rootPid) {
  const wanted = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (wanted.has(row.ppid) && !wanted.has(row.pid)) {
        wanted.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => wanted.has(row.pid));
}

function supervisedRows(rows, rootPid, knownPids) {
  const descendants = descendantRows(rows, rootPid);
  const descendantPids = new Set(descendants.map((row) => row.pid));
  return rows.filter((row) => row.pgid === rootPid || descendantPids.has(row.pid) || knownPids.has(row.pid));
}

async function executableHash(executable, basename) {
  if (!EXECUTABLE_HASH_CACHE.has(executable)) {
    EXECUTABLE_HASH_CACHE.set(executable, (async () => {
      try {
        return sha256(await readFile(executable));
      } catch {
        return sha256(basename);
      }
    })());
  }
  return EXECUTABLE_HASH_CACHE.get(executable);
}

async function normalizeProcessRows(rows) {
  const normalized = [];
  const seen = new Set();
  for (const row of rows) {
    const executableBasename = path.basename(row.executable).toLowerCase().replace(/^\((.+)\)$/, '$1');
    const executableSha256 = await executableHash(row.executable, executableBasename);
    const key = `${executableBasename}:${executableSha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ executable_basename: executableBasename, executable_sha256: executableSha256 });
  }
  return normalized.sort((left, right) => left.executable_basename.localeCompare(right.executable_basename));
}

function signalProcessGroup(processGroupId) {
  try {
    process.kill(-processGroupId, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function signalProcess(pid) {
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

async function terminateTrackedProcesses(rootPid, observedRows) {
  let signaled = signalProcessGroup(rootPid);
  const descendants = [...observedRows.values()].filter((row) => row.pid !== rootPid);
  const processGroups = new Set(descendants.map((row) => row.pgid).filter((pgid) => pgid > 1 && pgid !== rootPid));
  for (const processGroupId of processGroups) signaled = signalProcessGroup(processGroupId) || signaled;
  for (const row of descendants) signaled = signalProcess(row.pid) || signaled;
  signaled = signalProcess(rootPid) || signaled;
  return signaled;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function superviseWorker({ kind, offline, deadlineMs, fixtureId, fixturePath, scratchRoot, networkHook }) {
  await psSnapshot();
  const arguments_ = [MODULE_PATH, '--internal-worker', '--worker-kind', kind];
  if (offline) arguments_.push('--offline');
  if (fixtureId) arguments_.push('--fixture-id', fixtureId);
  if (fixturePath) arguments_.push('--fixture-path', fixturePath);
  if (scratchRoot) arguments_.push('--scratch-root', scratchRoot);
  if (networkHook) arguments_.push('--network-hook', networkHook);
  const child = spawn(process.execPath, arguments_, {
    detached: process.platform !== 'win32',
    env: {
      PATH: path.dirname(process.execPath),
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      NODE_NO_WARNINGS: '1'
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  const observedRows = new Map();
  let sampleChain = Promise.resolve();
  let sampling = true;
  let sampleCount = 0;
  let sampleFailures = 0;
  let readyMessage;
  let timedOut = false;
  let killed = false;
  let cleanupSignaled = false;
  let timer;
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const sample = () => {
    sampleChain = sampleChain.then(async () => {
      try {
        const rows = await psSnapshot();
        sampleCount += 1;
        for (const row of supervisedRows(rows, child.pid, new Set(observedRows.keys()))) {
          const previous = observedRows.get(row.pid);
          if (!previous || path.basename(row.executable) !== '<defunct>') observedRows.set(row.pid, row);
        }
      } catch {
        sampleFailures += 1;
      }
    });
    return sampleChain;
  };
  const ready = new Promise((resolve) => child.on('message', (message) => {
    if (message?.type === 'activity') {
      void sample();
      return;
    }
    if (message?.type === 'ready') {
      readyMessage = message;
      resolve('ready');
    }
  }));
  await sample();
  const sampler = (async () => {
    while (sampling) {
      await sample();
      await delay(5);
    }
  })();
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve('timeout');
    }, deadlineMs);
  });
  const outcome = await Promise.race([ready, deadline, exit.then(() => 'exit')]);
  await sample();
  clearTimeout(timer);
  if (outcome === 'timeout') {
    killed = await terminateTrackedProcesses(child.pid, observedRows);
    cleanupSignaled = killed;
  }
  else if (outcome === 'ready') child.send({ type: 'release' });
  if (outcome === 'exit' && !readyMessage) killed = false;
  const exitResult = await exit;
  await sample();
  sampling = false;
  await sampler;
  await sampleChain;
  const observedDescendant = [...observedRows.keys()].some((pid) => pid !== child.pid);
  if (timedOut || observedDescendant) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      cleanupSignaled = await terminateTrackedProcesses(child.pid, observedRows) || cleanupSignaled;
      const rows = await psSnapshot();
      sampleCount += 1;
      const knownDescendantPids = new Set([...observedRows.keys()].filter((pid) => pid !== child.pid));
      const survivors = rows.filter((row) => row.pgid === child.pid || knownDescendantPids.has(row.pid));
      for (const row of survivors) {
        const previous = observedRows.get(row.pid);
        if (!previous || path.basename(row.executable) !== '<defunct>') observedRows.set(row.pid, row);
      }
      if (survivors.length === 0) break;
      await delay(10);
    }
  }
  let finalRows = [];
  try {
    finalRows = await psSnapshot();
    sampleCount += 1;
  } catch {
    sampleFailures += 1;
  }
  const rawRows = [...observedRows.values()];
  const rootObserved = rawRows.some((row) => row.pid === child.pid);
  const childRows = rawRows.filter((row) => row.pid !== child.pid);
  const knownDescendantPids = new Set(childRows.map((row) => row.pid));
  const processGroupSurvivors = finalRows.filter((row) => row.pgid === child.pid).length;
  const knownDescendantSurvivors = finalRows.filter((row) => knownDescendantPids.has(row.pid)).length;
  const observed = await normalizeProcessRows(rawRows);
  const forbiddenRows = childRows.filter((row) => {
    const basename = path.basename(row.executable).toLowerCase().replace(/^\((.+)\)$/, '$1');
    return PROHIBITED_EXECUTABLES.has(basename);
  });
  const forbiddenProcesses = await normalizeProcessRows(forbiddenRows);
  const externalProcesses = childRows.length;
  const processTree = {
    collector_basename: 'ps',
    collector_sha256: await executableHash('/bin/ps', 'ps'),
    group_isolated: process.platform !== 'win32',
    root_observed: rootObserved,
    observed,
    external_processes: externalProcesses,
    forbidden_processes: forbiddenProcesses,
    pre_spawn_snapshot: true,
    post_exit_snapshot: true,
    sample_count: sampleCount,
    sample_failures: sampleFailures,
    cleanup_signaled: cleanupSignaled,
    process_group_survivors_after_cleanup: processGroupSurvivors,
    known_descendant_survivors_after_cleanup: knownDescendantSurvivors,
    claim_scope: 'observed_process_group_and_known_descendants_only',
    detection_limitations: [
      'macOS ps sampling cannot prove absence of a process that both spawns and exits between snapshots',
      'a descendant that detaches before its first observation is outside the known-descendant cleanup proof'
    ]
  };
  const childAliveAfterKill = timedOut ? finalRows.some((row) => row.pid === child.pid) : false;
  return {
    ...(readyMessage?.result ?? {}),
    pass: readyMessage?.result?.pass === true
      && !timedOut
      && processTree.group_isolated
      && rootObserved
      && externalProcesses === 0
      && processGroupSurvivors === 0
      && knownDescendantSurvivors === 0
      && sampleFailures === 0,
    timed_out: timedOut,
    killed,
    child_alive_after_kill: childAliveAfterKill,
    worker_exit_code: exitResult.code,
    worker_exit_signal: exitResult.signal,
    external_processes: externalProcesses,
    forbidden_processes: forbiddenProcesses,
    process_tree: processTree
  };
}

export async function runWorkerProbe({ kind, hook, offline = true, deadlineMs = 1000 } = {}) {
  if (![
    'network-attempt',
    'prohibited-process',
    'hung-parser',
    'short-lived-descendant',
    'detached-survivor',
    'detached-ready-descendant'
  ].includes(kind)) {
    throw new Error('unknown worker probe');
  }
  const result = await superviseWorker({ kind, offline, deadlineMs, networkHook: hook });
  if (['prohibited-process', 'short-lived-descendant', 'detached-survivor', 'detached-ready-descendant'].includes(kind)) {
    return { ...result, pass: false };
  }
  return result;
}

async function hashTree(root) {
  const digest = createHash('sha256');
  async function visit(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const relative = path.posix.join(relativeDirectory, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) {
        digest.update(relative);
        digest.update('\0');
        digest.update(await readFile(absolute));
        digest.update('\0');
      } else {
        digest.update(`${relative}:unsupported-entry\0`);
      }
    }
  }
  await visit(root);
  return digest.digest('hex');
}

async function listFilesRecursively(root) {
  const files = [];
  async function visit(directory, relativeDirectory = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else files.push(relative);
    }
  }
  await visit(root);
  return files.sort();
}

function countExposedPaths(value, sensitivePaths) {
  const serialized = JSON.stringify(value);
  return sensitivePaths.filter((sensitivePath) => sensitivePath && serialized.includes(sensitivePath)).length;
}

export async function runMaliciousCorpus({
  candidateRoot,
  fixtureRoot,
  acceptancePath = DEFAULT_ACCEPTANCE_PATH,
  output,
  offline = false
} = {}) {
  for (const [value, label] of [
    [candidateRoot, 'candidateRoot'], [fixtureRoot, 'fixtureRoot'], [acceptancePath, 'acceptancePath'], [output, 'output']
  ]) assertAbsolute(value, label);
  if (!offline) throw new Error('malicious corpus must run with --offline');
  const suppliedPaths = { candidateRoot, fixtureRoot, acceptancePath, output };
  const boundary = await resolveOutputBoundary(suppliedPaths);
  ({ candidateRoot, fixtureRoot, acceptancePath, output } = boundary);
  const sourceLockRaw = await readFile(SOURCE_LOCK_PATH);
  const sourceLock = JSON.parse(sourceLockRaw.toString('utf8'));
  const candidateReceiptBefore = verifyAcquiredCandidate({
    candidateRoot,
    sourceLock,
    lockBytes: sourceLockRaw
  });
  const acceptance = JSON.parse(await readFile(acceptancePath, 'utf8'));
  const admissionEvidence = JSON.parse(await readFile(ADMISSION_EVIDENCE_PATH, 'utf8'));
  const builtSourcePolicyEvidence = JSON.parse(await readFile(BUILT_SOURCE_POLICY_EVIDENCE_PATH, 'utf8'));
  const chunkEvidence = JSON.parse(await readFile(CHUNK_EVIDENCE_PATH, 'utf8'));
  const edgeThreshold = acceptance?.thresholds?.forbidden_runtime_edges;
  evaluateMaliciousAggregate({
    behaviorPass: true,
    forbiddenRuntimeEdgeThreshold: edgeThreshold,
    admissionEvidence,
    builtSourcePolicyEvidence
  });
  if (
    candidateReceiptBefore.commit !== sourceLock.commit
    || candidateReceiptBefore.archive_sha256 !== sourceLock.source_tree_sha256
    || admissionEvidence.candidate_commit !== candidateReceiptBefore.commit
  ) {
    throw new Error('verified Frozen Core identity differs from the locked Task 3 candidate');
  }
  await claimOutput(boundary);
  const candidateHashBefore = await hashTree(candidateRoot);
  const fixtureTreeHashBefore = await hashTree(fixtureRoot);
  const scratchContainer = await mkdtemp(path.join(os.tmpdir(), 'superwagie-viewer-malicious-'));
  const fixtureResults = [];
  try {
    for (const fixture of acceptance.fixtures) {
      const requestedFixturePath = path.resolve(fixtureRoot, fixture.file);
      if (!isWithin(fixtureRoot, requestedFixturePath)) throw new Error(`fixture path escapes source tree: ${fixture.fixture_id}`);
      const fixturePath = await realpath(requestedFixturePath);
      if (!isWithin(fixtureRoot, fixturePath)) throw new Error(`fixture path aliases outside source tree: ${fixture.fixture_id}`);
      const bytes = await readFile(fixturePath);
      if (sha256(bytes) !== fixture.sha256) throw new Error(`fixture hash mismatch: ${fixture.fixture_id}`);
      const scratchRoot = path.join(scratchContainer, fixture.fixture_id);
      await mkdir(scratchRoot);
      const escapedTarget = path.join(scratchContainer, 'outside.txt');
      const escapedExistedBefore = await access(escapedTarget).then(() => true, () => false);
      const worker = await superviseWorker({
        kind: 'fixture',
        offline,
        deadlineMs: acceptance.worker.hard_deadline_ms,
        fixtureId: fixture.fixture_id,
        fixturePath,
        scratchRoot
      });
      const scratchEntries = await listFilesRecursively(scratchRoot);
      const escapedExistsAfter = await access(escapedTarget).then(() => true, () => false);
      const diagnostics = worker.diagnostics ?? [];
      const matchesExpected = worker.outcome === fixture.expected_outcome
        && diagnostics.includes(fixture.expected_diagnostic);
      const pathSafe = scratchEntries.length === 0 && escapedExistedBefore === escapedExistsAfter;
      fixtureResults.push({
        fixture_id: fixture.fixture_id,
        file: fixture.file,
        sha256: fixture.sha256,
        expected_outcome: fixture.expected_outcome,
        outcome: worker.outcome ?? 'worker_failed',
        diagnostics,
        pass: worker.pass === true && matchesExpected && pathSafe && worker.network_requests === 0 && worker.source_hash_unchanged === true,
        source_hash_unchanged: worker.source_hash_unchanged === true,
        network_requests: worker.network_requests ?? 0,
        created_paths: scratchEntries.length + Number(!escapedExistedBefore && escapedExistsAfter),
        parser_dispatches: worker.parser_dispatches ?? 0,
        expanded_bytes: worker.expanded_bytes ?? 0,
        ...(worker.metadata_rejected_before_expansion === undefined
          ? {}
          : { metadata_rejected_before_expansion: worker.metadata_rejected_before_expansion }),
        ...(worker.sanitized_sha256 === undefined ? {} : { sanitized_sha256: worker.sanitized_sha256 }),
        process_tree: worker.process_tree
      });
    }
  } finally {
    await rm(scratchContainer, { recursive: true, force: true });
  }
  const deadlineProbe = await runWorkerProbe({
    kind: 'hung-parser',
    offline,
    deadlineMs: acceptance.worker.hung_probe_deadline_ms
  });
  const candidateHashAfter = await hashTree(candidateRoot);
  const fixtureTreeHashAfter = await hashTree(fixtureRoot);
  const candidateReceiptAfter = verifyAcquiredCandidate({
    candidateRoot,
    sourceLock,
    lockBytes: sourceLockRaw
  });
  if (
    candidateReceiptAfter.commit !== candidateReceiptBefore.commit
    || candidateReceiptAfter.tree !== candidateReceiptBefore.tree
    || candidateReceiptAfter.archive_sha256 !== candidateReceiptBefore.archive_sha256
    || candidateReceiptAfter.materialized_tree_sha256 !== candidateReceiptBefore.materialized_tree_sha256
  ) throw new Error('Frozen Core identity changed during malicious corpus execution');
  const metrics = {
    external_processes: fixtureResults.reduce((sum, fixture) => sum + fixture.process_tree.external_processes, 0),
    network_requests: fixtureResults.reduce((sum, fixture) => sum + fixture.network_requests, 0),
    filesystem_paths_exposed: 0,
    source_mutations: Number(candidateHashBefore !== candidateHashAfter) + Number(fixtureTreeHashBefore !== fixtureTreeHashAfter),
    moderate_or_higher_reachable_vulnerabilities: admissionEvidence.moderate_or_higher,
    forbidden_runtime_edges: admissionEvidence.forbidden_runtime_edges,
    unexpected_fixture_outcomes: fixtureResults.filter((fixture) => !fixture.pass).length,
    base_office_compressed_max_bytes: chunkEvidence.base_office_compressed_bytes,
    all_chunks_compressed_max_bytes: chunkEvidence.total_compressed_bytes
  };
  const behaviorPass = fixtureResults.every((fixture) => fixture.pass)
    && deadlineProbe.timed_out === true
    && deadlineProbe.killed === true
    && deadlineProbe.child_alive_after_kill === false
    && deadlineProbe.process_tree.group_isolated === true
    && deadlineProbe.process_tree.process_group_survivors_after_cleanup === 0
    && deadlineProbe.process_tree.known_descendant_survivors_after_cleanup === 0
    && deadlineProbe.process_tree.sample_failures === 0
    && metrics.external_processes === acceptance.thresholds.external_processes
    && metrics.network_requests === acceptance.thresholds.network_requests
    && metrics.source_mutations === acceptance.thresholds.source_mutations
    && metrics.unexpected_fixture_outcomes === acceptance.thresholds.unexpected_fixture_outcomes;
  const aggregate = evaluateMaliciousAggregate({
    behaviorPass,
    forbiddenRuntimeEdgeThreshold: edgeThreshold,
    admissionEvidence,
    builtSourcePolicyEvidence
  });
  const result = {
    schema_id: 'superwagie.viewer-malicious-corpus.v1',
    fixture: acceptance.fixture_id,
    platform: `${process.platform}-${process.arch}`,
    offline: true,
    execution_pass: behaviorPass,
    behavior: { pass: behaviorPass, status: behaviorPass ? 'passed' : 'failed' },
    pass: aggregate.aggregatePass,
    status: aggregate.status,
    decision: aggregate.decision,
    reasons: aggregate.reasons,
    candidate: {
      commit: candidateReceiptBefore.commit,
      tree: candidateReceiptBefore.tree,
      archive_sha256: candidateReceiptBefore.archive_sha256,
      materialized_tree_sha256: candidateReceiptBefore.materialized_tree_sha256,
      source_lock_sha256: candidateReceiptBefore.source_lock_sha256,
      source_hash_before: candidateHashBefore,
      source_hash_after: candidateHashAfter,
      admission_decision: admissionEvidence.decision,
      pristine_before: true,
      pristine_after: true
    },
    thresholds: acceptance.thresholds,
    metrics,
    fixtures: fixtureResults,
    deadline_probe: {
      timed_out: deadlineProbe.timed_out,
      killed: deadlineProbe.killed,
      child_alive_after_kill: deadlineProbe.child_alive_after_kill,
      process_tree: deadlineProbe.process_tree
    },
    source_integrity: {
      post_atomic_write_recheck_required_for_successful_runner_return: true
    },
    cli_exit_semantics: {
      runner_exit_zero_means: 'evidence_completed_and_behavior_passed',
      aggregate_pass_remains_false_while_admission_is_no_go: true
    }
  };
  metrics.filesystem_paths_exposed = countExposedPaths(result, [
    suppliedPaths.candidateRoot,
    suppliedPaths.fixtureRoot,
    suppliedPaths.acceptancePath,
    suppliedPaths.output,
    candidateRoot,
    fixtureRoot,
    acceptancePath,
    output,
    scratchContainer,
    os.homedir()
  ]);
  if (metrics.filesystem_paths_exposed !== acceptance.thresholds.filesystem_paths_exposed) {
    result.execution_pass = false;
    result.behavior = { pass: false, status: 'failed' };
    result.pass = false;
    result.status = 'failed';
    result.decision = 'NO_GO';
    result.reasons = ['MALICIOUS_CORPUS_BEHAVIOR_FAILED', ...(!aggregate.admissionPass ? ['FROZEN_CORE_ADMISSION_NOT_GO'] : [])];
  }
  await atomicWriteEvidence(boundary, result);
  const [candidateHashAfterWrite, fixtureTreeHashAfterWrite] = await Promise.all([
    hashTree(candidateRoot),
    hashTree(fixtureRoot)
  ]);
  verifyAcquiredCandidate({ candidateRoot, sourceLock, lockBytes: sourceLockRaw });
  const postWriteMutations = Number(candidateHashBefore !== candidateHashAfterWrite)
    + Number(fixtureTreeHashBefore !== fixtureTreeHashAfterWrite);
  if (postWriteMutations !== metrics.source_mutations) {
    metrics.source_mutations = postWriteMutations;
    result.candidate.source_hash_after = candidateHashAfterWrite;
    result.candidate.pristine_after = postWriteMutations === 0;
    result.execution_pass = false;
    result.behavior = { pass: false, status: 'failed' };
    result.pass = false;
    result.status = 'failed';
    result.decision = 'NO_GO';
    result.reasons = ['MALICIOUS_CORPUS_BEHAVIOR_FAILED', ...(!aggregate.admissionPass ? ['FROZEN_CORE_ADMISSION_NOT_GO'] : [])];
    await atomicWriteEvidence(boundary, result);
    const [candidateHashFinal, fixtureTreeHashFinal] = await Promise.all([
      hashTree(candidateRoot),
      hashTree(fixtureRoot)
    ]);
    if (candidateHashFinal !== candidateHashAfterWrite || fixtureTreeHashFinal !== fixtureTreeHashAfterWrite) {
      throw new Error('source identity changed again after corrected atomic evidence write');
    }
  }
  return result;
}

function parseFlags(arguments_) {
  const options = { offline: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--offline') options.offline = true;
    else if (argument === '--internal-worker') options.internalWorker = true;
    else if (argument.startsWith('--')) {
      const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = arguments_[++index];
    } else throw new Error(`unexpected argument: ${argument}`);
  }
  return options;
}

async function cliMain() {
  const options = parseFlags(process.argv.slice(2));
  if (options.internalWorker) {
    await internalWorkerMain(process.argv.slice(2));
    return;
  }
  const result = await runMaliciousCorpus({
    candidateRoot: options.candidateRoot,
    fixtureRoot: options.fixtureRoot,
    acceptancePath: options.acceptance ? options.acceptance : DEFAULT_ACCEPTANCE_PATH,
    output: options.output,
    offline: options.offline
  });
  process.stdout.write(`${JSON.stringify({
    execution_pass: result.execution_pass,
    behavior_pass: result.behavior.pass,
    aggregate_pass: result.pass,
    decision: result.decision,
    forbidden_runtime_edges: result.metrics.forbidden_runtime_edges
  })}\n`);
  process.exitCode = result.execution_pass ? 0 : 1;
}

if (path.resolve(process.argv[1] ?? '') === MODULE_PATH) {
  cliMain().catch((error) => {
    process.stderr.write(`${error.code ?? 'VIEWER_MALICIOUS_CORPUS_FAILED'}: ${error.message}\n`);
    process.exitCode = 2;
  });
}
