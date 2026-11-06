import { createRequire } from 'node:module';
import { join } from 'node:path';
import { OFFICE_LIMITS as limits, officeError, validatePages } from './office-limits.mjs';

const invalid = message => officeError('DOCUMENT_SIGNATURE_MISMATCH', message);
const excessive = message => officeError('DOCUMENT_RESOURCE_LIMIT', message);
const decode = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid('OOXML parts must contain valid UTF-8'); } };

/** Inspect names before JSZip can normalize paths or replace duplicate entries. */
export function inspectZipDirectory(bytes) {
  if (bytes.length > limits.compressedBytes) throw excessive('Office input exceeds 256 MiB');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw invalid('Missing ZIP directory');
  const count = bytes.readUInt16LE(end + 10); const size = bytes.readUInt32LE(end + 12); const start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || start + size !== end) throw invalid('Unsupported multi-volume or ZIP64 package');
  if (!count || count > limits.entries) throw excessive('Office ZIP entry count exceeds the limit');
  const entries = new Map(); let offset = start; let inflated = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalid('Malformed ZIP directory');
    const flags = bytes.readUInt16LE(offset + 8); const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20); const uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28); const next = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    if (next > end || flags & 1 || ![0, 8].includes(method) || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid('Encrypted or malformed ZIP entry');
    const name = decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!name || name.length > 1024 || name.startsWith('/') || /[\\\x00-\x1f:]/.test(name) || name.split('/').some(part => part === '.' || part === '..') || entries.has(name)) throw invalid('Duplicate or unsafe Office part name');
    const localNameLength = bytes.readUInt16LE(local + 26); const dataStart = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || dataStart + compressed > start) throw invalid('ZIP local and central headers disagree');
    inflated += uncompressed;
    if (inflated > limits.inflatedBytes || (/\.(xml|rels)$/i.test(name) && uncompressed > limits.xmlBytes)) throw excessive('Office inflated size exceeds the limit');
    entries.set(name, { uncompressed, dataStart, dataEnd: dataStart + compressed }); offset = next;
  }
  if (offset !== end) throw invalid('ZIP directory size mismatch');
  const regions = [...entries.values()].sort((a, b) => a.dataStart - b.dataStart);
  for (let i = 1; i < regions.length; i++) if (regions[i].dataStart < regions[i - 1].dataEnd) throw invalid('Overlapping ZIP parts');
  return entries;
}

function xmlElements(text) {
  // OOXML needs no DTD or custom entities. Reject them before either parser runs.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw invalid('OOXML declarations may not define entities');
  const stack = []; const elements = []; let rootSeen = false; let offset = 0;
  const checkText = value => {
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(value)) throw invalid('Malformed XML text');
  };
  while (offset < text.length) {
    const opening = text.indexOf('<', offset);
    const content = text.slice(offset, opening < 0 ? text.length : opening); checkText(content);
    if (!stack.length && content.trim()) throw invalid('XML text outside its root');
    if (opening < 0) break;
    if (text.startsWith('<!--', opening)) { const end = text.indexOf('-->', opening + 4); if (end < 0) throw invalid('Unclosed XML comment'); offset = end + 3; continue; }
    if (text.startsWith('<?', opening)) { const end = text.indexOf('?>', opening + 2); if (end < 0) throw invalid('Unclosed XML instruction'); offset = end + 2; continue; }
    if (text.startsWith('<![CDATA[', opening)) { const end = text.indexOf(']]>', opening + 9); if (end < 0 || !stack.length) throw invalid('Malformed XML CDATA'); offset = end + 3; continue; }
    let end = opening + 1; let quote = '';
    for (; end < text.length; end++) { const c = text[end]; if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break; }
    if (end === text.length) throw invalid('Unclosed XML tag');
    const tag = text.slice(opening + 1, end); offset = end + 1;
    if (tag.startsWith('/')) { const name = tag.slice(1).trim(); if (!stack.length || stack.pop().name !== name) throw invalid('Mismatched XML tag'); continue; }
    const match = tag.match(/^([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)$/); if (!match) throw invalid('Malformed XML tag');
    const [, name, tail, closed] = match; const attrs = {}; let cursor = 0;
    while (cursor < tail.length) {
      if (!tail.slice(cursor).trim()) break;
      const attr = tail.slice(cursor).match(/^\s+([A-Za-z_][\w.:-]*)\s*=\s*(["'])([^]*?)\2/);
      if (!attr || Object.hasOwn(attrs, attr[1]) || attr[3].includes('<')) throw invalid('Malformed XML attributes');
      checkText(attr[3]); attrs[attr[1]] = attr[3]; cursor += attr[0].length;
    }
    const namespaces = { ...(stack.at(-1)?.namespaces ?? {}) };
    for (const [key, value] of Object.entries(attrs)) { if (key === 'xmlns') namespaces[''] = value; else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value; }
    for (const key of Object.keys(attrs)) {
      const prefix = key.includes(':') ? key.split(':')[0] : '';
      if (prefix && prefix !== 'xml' && prefix !== 'xmlns' && !namespaces[prefix]) throw invalid('Undeclared XML attribute namespace');
    }
    const names = name.split(':'); if (names.length > 2 || (names.length === 2 && !namespaces[names[0]])) throw invalid('Undeclared XML namespace');
    const element = { name, local: names.at(-1), namespace: namespaces[names.length === 2 ? names[0] : ''], attrs, namespaces, depth: stack.length };
    if (!stack.length) { if (rootSeen) throw invalid('Multiple XML roots'); rootSeen = true; }
    elements.push(element); if (elements.length > 100000) throw excessive('Office XML element count exceeds the limit');
    if (!closed) { stack.push(element); if (stack.length > 256) throw excessive('Office XML nesting exceeds the limit'); }
  }
  if (!rootSeen || stack.length) throw invalid('Incomplete XML document');
  return elements;
}

export async function inspectOfficePackage(bytes, kind, config = {}) {
  const entries = inspectZipDirectory(bytes);
  const main = kind === 'pptx' ? 'ppt/presentation.xml' : 'word/document.xml';
  if (!entries.has(main) || !entries.has('[Content_Types].xml') || !entries.has('_rels/.rels')) throw invalid('Missing required OOXML package parts');
  let JSZip;
  try { JSZip = createRequire(import.meta.url)('jszip'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || !config.playwrightModule) throw officeError('DEPENDENCY_MISSING', 'The pinned Office JSZip runtime is missing');
    try { JSZip = createRequire(join(config.playwrightModule, 'index.js'))('jszip'); }
    catch { throw officeError('DEPENDENCY_MISSING', 'The configured browser runtime lacks the pinned JSZip dependency'); }
  }
  let zip; try { zip = await JSZip.loadAsync(bytes); } catch { throw invalid('Invalid OOXML ZIP package'); }
  const parts = new Map(); let total = 0;
  for (const [name, declared] of entries) {
    const entry = zip.files[name]; if (!entry) throw invalid('OOXML part identity changed during ZIP parsing');
    if (entry.dir) continue;
    const xml = /\.(xml|rels)$/i.test(name); let size = 0; const chunks = [];
    await new Promise((resolve, reject) => {
      const stream = entry.internalStream('nodebuffer');
      stream.on('data', chunk => {
        size += chunk.length; total += chunk.length;
        if (total > limits.inflatedBytes || (xml && size > limits.xmlBytes)) { stream.pause(); reject(excessive('Actual Office inflation exceeds the limit')); return; }
        if (xml) chunks.push(chunk);
      }).on('error', () => reject(invalid('Office part inflation failed'))).on('end', resolve).resume();
    });
    if (size !== declared.uncompressed) throw invalid('Office part inflated size differs from the directory');
    if (xml) { const elements = xmlElements(decode(Buffer.concat(chunks))); if ([main, '[Content_Types].xml', '_rels/.rels', 'ppt/_rels/presentation.xml.rels'].includes(name)) parts.set(name, elements); }
  }
  const types = parts.get('[Content_Types].xml');
  if (types[0].local !== 'Types' || types[0].namespace !== 'http://schemas.openxmlformats.org/package/2006/content-types') throw invalid('Invalid OOXML content types root');
  if (types.some(e => /macroEnabled|vbaProject/i.test(e.attrs.ContentType ?? '')) || [...entries.keys()].some(name => /vbaProject|EncryptionInfo|EncryptedPackage/i.test(name))) throw invalid('Encrypted or macro-enabled package does not match the extension');
  const expected = kind === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
  if (!types.some(e => e.local === 'Override' && e.attrs.PartName === `/${main}` && e.attrs.ContentType === expected)) throw invalid('OOXML main content type does not match the extension');
  const document = parts.get(main); const namespace = `http://schemas.openxmlformats.org/${kind === 'pptx' ? 'presentationml' : 'wordprocessingml'}/2006/main`;
  if (document[0].local !== (kind === 'pptx' ? 'presentation' : 'document') || document[0].namespace !== namespace) throw invalid('OOXML main root does not match the extension');
  const rootRels = parts.get('_rels/.rels');
  if (rootRels[0].local !== 'Relationships' || rootRels[0].namespace !== 'http://schemas.openxmlformats.org/package/2006/relationships' || !rootRels.some(e => e.attrs.Type?.endsWith('/officeDocument') && e.attrs.Target?.replace(/^\//, '') === main && e.attrs.TargetMode !== 'External')) throw invalid('Missing OOXML main relationship');
  if (kind === 'docx') return { kind };
  const slides = document.filter(e => e.namespace === namespace && e.local === 'sldId');
  const relationships = parts.get('ppt/_rels/presentation.xml.rels') ?? [];
  for (const slide of slides) {
    const id = Object.entries(slide.attrs).find(([key]) => key.endsWith(':id'))?.[1];
    const rel = relationships.find(e => e.attrs.Id === id && e.attrs.Type?.endsWith('/slide'));
    if (!rel || rel.attrs.TargetMode === 'External' || !entries.has(`ppt/${rel.attrs.Target}`)) throw invalid('Missing or external slide relationship');
  }
  const geometry = document.find(e => e.namespace === namespace && e.local === 'sldSz');
  const width = Math.ceil(Number(geometry?.attrs.cx) * 96 / 914400); const height = Math.ceil(Number(geometry?.attrs.cy) * 96 / 914400);
  validatePages(slides.map(() => ({ width, height })));
  return { kind, slideCount: slides.length, width, height };
}
