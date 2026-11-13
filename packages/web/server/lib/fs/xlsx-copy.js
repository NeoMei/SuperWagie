import * as fs from 'node:fs/promises';
import { isPlainObject, isString } from '../shared/guards.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const MAX_BYTES = 30 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_CELLS = 2000;
const fail = (message, reason = 'unsupported', status = 422) => { const error = new Error(message); error.reason = reason; error.status = status; throw error; };
const readonly = () => fail('This workbook is read-only: its format is unsupported for copy editing.');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const crc32 = (data) => {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
};

// Keep compressed bytes and local records for every untouched part. OOXML
// round-tripping through a spreadsheet library drops drawing/style extensions.
const readZip = (data) => {
  if (data.length > MAX_BYTES) fail('Office files support up to 30 MiB.', 'too-large', 413);
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== data.readUInt16LE(end + 10) || end + 22 + data.readUInt16LE(end + 20) !== data.length) readonly();
  const count = data.readUInt16LE(end + 10); const size = data.readUInt32LE(end + 12); const offset = data.readUInt32LE(end + 16);
  if (!count || count > 4096 || offset + size !== end) readonly();
  const entries = new Map(); let cursor = offset; let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50) readonly();
    const length = 46 + data.readUInt16LE(cursor + 28) + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32);
    const central = data.subarray(cursor, cursor + length); const flags = central.readUInt16LE(8); const method = central.readUInt16LE(10);
    const compressedSize = central.readUInt32LE(20); const plainSize = central.readUInt32LE(24); const localOffset = central.readUInt32LE(42);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(central.subarray(46, 46 + central.readUInt16LE(28)));
    if (cursor + length > end || flags & 1 || ![0, 8].includes(method) || localOffset + 30 > offset || data.readUInt32LE(localOffset) !== 0x04034b50 || entries.has(name) || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || plainSize === 0xffffffff || compressedSize === 0xffffffff) readonly();
    const bodyOffset = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
    if (bodyOffset + compressedSize > offset || data.readUInt16LE(localOffset + 8) !== method) readonly();
    const localName = data.subarray(localOffset + 30, localOffset + 30 + data.readUInt16LE(localOffset + 26)).toString('utf8');
    if (localName !== name) readonly();
    expanded += plainSize; if (expanded > MAX_EXPANDED) readonly();
    entries.set(name, { name, central, localOffset, bodyOffset, compressedSize, plainSize, method }); cursor += length;
  }
  if (cursor !== end) readonly();
  const ordered = [...entries.values()].sort((a, b) => a.localOffset - b.localOffset);
  if (ordered[0].localOffset !== 0) readonly();
  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i]; const next = ordered[i + 1]?.localOffset ?? offset;
    if (entry.bodyOffset + entry.compressedSize > next) readonly();
    entry.local = data.subarray(entry.localOffset, next);
  }
  const bytes = (name) => {
    const entry = entries.get(name); if (!entry) readonly();
    const compressed = data.subarray(entry.bodyOffset, entry.bodyOffset + entry.compressedSize);
    const plain = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.min(MAX_EXPANDED, entry.plainSize + 1) });
    if (plain.length !== entry.plainSize || crc32(plain) !== entry.central.readUInt32LE(16)) readonly();
    return plain;
  };
  return { entries, ordered, bytes, end: data.subarray(end) };
};

const xmlCodePoint = (code) => code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff;
const xmlCharacters = (text) => { for (const character of text) if (!xmlCodePoint(character.codePointAt(0))) return false; return true; };
const decode = (text, attribute = false) => (attribute ? text.replace(/\r\n?/g, '\n').replace(/[\t\n]/g, ' ') : text.replace(/\r\n?/g, '\n')).replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_match, entity) => {
  if (entity[0] === '#') { const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10); if (!xmlCodePoint(code)) readonly(); return String.fromCodePoint(code); }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
});
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r/g, '&#13;');
const parseXml = (bytes) => {
  if (bytes.length > 16 * 1024 * 1024) readonly();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('<!') || /&(?!#x[\da-fA-F]+;|#\d+;|amp;|lt;|gt;|quot;|apos;)/.test(text) || !xmlCharacters(text)) readonly();
  for (const reference of text.matchAll(/&#(x[\da-fA-F]+|\d+);/g)) if (!xmlCodePoint(reference[1][0] === 'x' ? parseInt(reference[1].slice(1), 16) : parseInt(reference[1], 10))) readonly();
  const root = { name: '', children: [] }; const stack = [root]; let last = 0;
  for (const match of text.matchAll(/<[^>]*>/g)) {
    if (text.slice(last, match.index).includes('<')) readonly();
    const tag = match[0]; last = match.index + tag.length;
    if (tag.startsWith('<?')) { if (!tag.startsWith('<?xml ') || stack.length !== 1) readonly(); continue; }
    if (tag.startsWith('</')) {
      const node = stack.pop(); if (!node || node.name !== tag.slice(2, -1).trim()) readonly();
      node.closeStart = match.index; node.end = last; continue;
    }
    const opening = /^<([\w:.-]+)([\s\S]*?)(\/?)>$/.exec(tag); if (!opening) readonly();
    const attributes = {}; let remaining = opening[2];
    while (remaining.trim()) {
      const attribute = /^\s+([\w:.-]+)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/.exec(remaining);
      if (!attribute || Object.hasOwn(attributes, attribute[1])) readonly();
      attributes[attribute[1]] = decode(attribute[2] ?? attribute[3], true); remaining = remaining.slice(attribute[0].length);
    }
    const node = { name: opening[1], attributes, children: [], start: match.index, openEnd: last, closeStart: last, end: last };
    stack[stack.length - 1].children.push(node);
    if (!opening[3]) { if (stack.length >= 64) readonly(); stack.push(node); }
  }
  if (stack.length !== 1 || root.children.length !== 1 || text.slice(last).trim()) readonly();
  return { text, root: root.children[0] };
};
const descendants = (node, name) => node.children.flatMap((child) => [...(child.name === name ? [child] : []), ...descendants(child, name)]);
const containsLocalTag = (node, names) => names.includes(node.name.split(':').pop()) || node.children.some((child) => containsLocalTag(child, names));
const excludedFeature = (value) => /externalLink|vba|macroEnabled|binary|encrypted|digital-signature|xmlsignature|oleObject|activeX|customXml|pivot|slicer|timeline|webExtension|customUI|ctrlProp|controlproperties|\/control(?:$|\/)|connections|queryTable|chart|\/ui\/extensibility|\/package$|\/model$|model\+data/i.test(value);
const content = (xml, node) => decode(xml.text.slice(node.openEnd, node.closeStart));
const addressValid = (address) => /^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address) && Number(address.match(/\d+/)[0]) <= 1048576 && address.match(/[A-Z]+/)[0].split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) <= 16384;
const model = (data) => {
  const zip = readZip(data);
  for (const name of zip.entries.keys()) if (/vba|\.bin$|_xmlsignatures|externalLinks|activeX|embeddings|customXml|connections\.xml|queryTables|pivot|slicer|timeline|webExtensions|customUI|ctrlProp|chart/i.test(name)) readonly();
  const types = parseXml(zip.bytes('[Content_Types].xml'));
  const workbookType = types.root.children.filter((node) => node.name === 'Override' && node.attributes.PartName === '/xl/workbook.xml');
  if (workbookType.length !== 1 || workbookType[0].attributes.ContentType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml') readonly();
  for (const node of types.root.children) {
    if (node.name === 'Override' && excludedFeature(node.attributes.ContentType ?? '')) readonly();
    if (node.name === 'Default' && excludedFeature(node.attributes.ContentType ?? '') && [...zip.entries.keys()].some((name) => !name.endsWith('/') && path.posix.extname(name).slice(1).toLowerCase() === (node.attributes.Extension ?? '').toLowerCase())) readonly();
  }
  // OPC relationship types describe the feature even when its author chooses
  // an unconventional part name. Inspect every relationship part, not just
  // workbook.xml.rels; nested external-link and drawing relations live there.
  for (const name of zip.entries.keys()) {
    if (!name.toLowerCase().endsWith('.rels')) continue;
    const relationships = parseXml(zip.bytes(name));
    if (relationships.root.name.split(':').pop() !== 'Relationships') readonly();
    for (const rel of relationships.root.children) {
      if (rel.name.split(':').pop() !== 'Relationship' || !rel.attributes.Type || !rel.attributes.Target || rel.attributes.TargetMode && rel.attributes.TargetMode !== 'Internal' || excludedFeature(rel.attributes.Type) || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(rel.attributes.Target)) readonly();
    }
  }
  const workbook = parseXml(zip.bytes('xl/workbook.xml'));
  if (workbook.root.name !== 'workbook' || workbook.root.attributes.xmlns !== 'http://schemas.openxmlformats.org/spreadsheetml/2006/main' || containsLocalTag(workbook.root, ['workbookProtection', 'fileSharing', 'externalReferences', 'externalReference', 'externalLink', 'externalBook'])) readonly();
  const calc = descendants(workbook.root, 'calcPr'); if (calc.length > 1 || calc[0]?.attributes.calcMode === 'manual') readonly();
  const rels = parseXml(zip.bytes('xl/_rels/workbook.xml.rels'));
  const relationships = new Map();
  for (const rel of rels.root.children) {
    if (rel.name !== 'Relationship' || relationships.has(rel.attributes.Id) || rel.attributes.TargetMode === 'External') readonly();
    relationships.set(rel.attributes.Id, rel.attributes);
  }
  let shared = [];
  if (zip.entries.has('xl/sharedStrings.xml')) { const strings = parseXml(zip.bytes('xl/sharedStrings.xml')); shared = strings.root.children.map((item) => ({ value: descendants(item, 't').map((text) => content(strings, text)).join(''), plain: item.children.length === 1 && item.children[0].name === 't' && !item.children[0].children.length })); }
  const sheets = []; const names = new Set();
  for (const sheet of descendants(workbook.root, 'sheet')) {
    if (!sheet.attributes.name || names.has(sheet.attributes.name)) readonly(); names.add(sheet.attributes.name);
    const rel = relationships.get(sheet.attributes['r:id']); if (!rel || !rel.Type.endsWith('/worksheet')) readonly();
    const part = path.posix.normalize(path.posix.join('xl', rel.Target)); if (!part.startsWith('xl/worksheets/')) readonly();
    const xml = parseXml(zip.bytes(part));
    if (xml.root.name !== 'worksheet' || xml.root.attributes.xmlns !== 'http://schemas.openxmlformats.org/spreadsheetml/2006/main' || containsLocalTag(xml.root, ['sheetProtection', 'chart', 'chartSpace', 'externalReferences', 'externalReference', 'externalLink', 'externalBook', 'oleObjects', 'controls', 'pivotTableParts'])) readonly();
    if (sheet.attributes.state && sheet.attributes.state !== 'visible') continue;
    const rows = descendants(xml.root, 'row'); const cells = []; const seen = new Set();
    const hiddenColumns = descendants(xml.root, 'col').filter((col) => ['1', 'true'].includes(col.attributes.hidden));
    const merges = descendants(xml.root, 'mergeCell');
    for (const row of rows) {
      if (row.attributes.hidden === '1' || row.attributes.hidden === 'true') continue;
      for (const node of row.children.filter((child) => child.name === 'c')) {
        const address = node.attributes.r; if (!address || !addressValid(address) || seen.has(address)) readonly(); seen.add(address);
        const column = address.match(/[A-Z]+/)[0].split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
        const hidden = hiddenColumns.some((col) => column >= Number(col.attributes.min) && column <= Number(col.attributes.max));
        if (hidden) continue;
        const type = node.attributes.t ?? 'n'; const valueNode = node.children.find((child) => child.name === 'v');
        let value = valueNode ? content(xml, valueNode) : ''; let plain = node.children.length <= 1 && node.children.every((child) => child.name === 'v' && !child.children.length);
        if (type === 's') { const item = shared[Number(value)]; if (!item) readonly(); value = item.value; plain = plain && item.plain; }
        if (type === 'inlineStr') { const inline = node.children.find((child) => child.name === 'is'); value = inline ? descendants(inline, 't').map((text) => content(xml, text)).join('') : ''; plain = !!inline && node.children.length === 1 && inline.children.length === 1 && inline.children[0].name === 't' && !inline.children[0].children.length; }
        const merged = merges.some((merge) => { const [first, end] = (merge.attributes.ref ?? '').split(':'); if (!first || !end || !addressValid(first) || !addressValid(end)) readonly(); const col = (a) => a.match(/[A-Z]+/)[0].split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0); return column >= col(first) && column <= col(end) && Number(address.match(/\d+/)[0]) >= Number(first.match(/\d+/)[0]) && Number(address.match(/\d+/)[0]) <= Number(end.match(/\d+/)[0]); });
        const editable = plain && !merged && !/_x[\da-f]{4}_/i.test(value) && ['n', 's', 'inlineStr', 'b'].includes(type) && Object.keys(node.attributes).every((key) => ['r', 's', 't'].includes(key));
        const displayValue = value.replace(/_x([\da-f]{4})_/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
        if (cells.length < MAX_CELLS) cells.push({ address, value: displayValue.slice(0, 32767), editable, node });
      }
    }
    sheets.push({ name: sheet.attributes.name, part, xml, cells, truncated: seen.size > cells.length });
  }
  if (!sheets.length) readonly();
  return { zip, workbook, calc, sheets };
};
const snapshot = async (source) => {
  if (Buffer.isBuffer(source)) return { data: source, version: sha(source) };
  if (path.extname(source).toLowerCase() !== '.xlsx') readonly();
  const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_BYTES) readonly();
    const data = Buffer.alloc(stat.size); let offset = 0;
    while (offset < data.length) { const { bytesRead } = await handle.read(data, offset, data.length - offset, offset); if (!bytesRead) fail('The source file changed. Reopen it before saving.', 'source-changed', 409); offset += bytesRead; }
    const after = await handle.stat();
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) fail('The source file changed. Reopen it before saving.', 'source-changed', 409);
    return { data, version: `${sha(data)}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
  } finally { await handle.close(); }
};
export const inspectXlsxCopy = async (source) => {
  const { data, version } = await snapshot(source); const workbook = model(data);
  return { version, sheets: workbook.sheets.map((sheet) => ({ name: sheet.name, truncated: sheet.truncated, cells: sheet.cells.map(({ address, value, editable }) => ({ address, value, editable })) })) };
};
const replaceParts = (zip, replacements) => {
  const local = []; const central = []; let offset = 0;
  for (const entry of zip.ordered) {
    const record = Buffer.from(entry.central); const replacement = replacements.get(entry.name); let bytes = entry.local;
    if (replacement !== undefined) {
      const plain = Buffer.from(replacement); const compressed = deflateRawSync(plain); const checksum = crc32(plain);
      const header = Buffer.from(entry.local.subarray(0, entry.bodyOffset - entry.localOffset));
      header.writeUInt16LE(header.readUInt16LE(6) & ~8, 6); header.writeUInt16LE(8, 8); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(plain.length, 22);
      record.writeUInt16LE(record.readUInt16LE(8) & ~8, 8); record.writeUInt16LE(8, 10); record.writeUInt32LE(checksum, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(plain.length, 24);
      bytes = Buffer.concat([header, compressed]);
    }
    record.writeUInt32LE(offset, 42); local.push(bytes); central.push(record); offset += bytes.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.from(zip.end); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
};
// Shared isString also recognizes boxed strings; a JSON scalar must equal its primitive value.
const parseCopyName = (request) => {
  if (!isPlainObject(request) || !isString(request.name) || request.name !== String(request.name)) return null;
  return { name: request.name };
};
const parseEditIdentity = (edit) => {
  if (!isPlainObject(edit) || !isString(edit.sheet) || edit.sheet !== String(edit.sheet) || !isString(edit.address) || edit.address !== String(edit.address)) return null;
  return { sheet: edit.sheet, address: edit.address };
};
const parseEditValue = (edit) => {
  if (!isPlainObject(edit) || (edit.kind !== 'string' && edit.kind !== 'number') || !isString(edit.value) || edit.value !== String(edit.value) || edit.value.length > 32767) return null;
  return { kind: edit.kind, value: edit.value };
};

export const saveXlsxCopy = async (source, request, io = fs) => {
  const parsedName = parseCopyName(request);
  if (!parsedName) fail('Choose a new XLSX filename.', 'invalid-name', 400);
  const name = parsedName.name;
  if (path.basename(name) !== name || !name.toLowerCase().endsWith('.xlsx') || /[\\/:\x00-\x1f]/.test(name)) fail('Choose a new XLSX filename.', 'invalid-name', 400);
  const destination = path.join(path.dirname(source), name);
  if (destination === source || name.toLowerCase() === path.basename(source).toLowerCase()) fail('Choose a distinct filename. The original cannot be overwritten.', 'original', 400);
  const original = await snapshot(source);
  if (original.version !== request.version) fail('The source file changed. Reopen it before saving.', 'source-changed', 409);
  const workbook = model(original.data);
  if (!Array.isArray(request.edits) || !request.edits.length || request.edits.length > 100) fail('Select between 1 and 100 cells.', 'selection', 400);
  const replacements = new Map(); const selections = new Set();
  for (const rawEdit of request.edits) {
    const identity = parseEditIdentity(rawEdit);
    if (!identity) fail('This selection is unavailable.', 'selection', 400);
    const sheet = workbook.sheets.find((item) => item.name === identity.sheet); const cell = sheet?.cells.find((item) => item.address === identity.address);
    if (!cell || selections.has(`${identity.sheet}!${identity.address}`)) fail('This selection is unavailable.', 'selection', 400);
    if (!cell.editable) fail('This cell is read-only.', 'readonly', 422);
    const suppliedValue = parseEditValue(rawEdit);
    if (!suppliedValue) fail('This cell value is unsupported.', 'value', 400);
    const edit = { ...identity, ...suppliedValue };
    if (!xmlCharacters(edit.value) || /_x[\da-f]{4}_/i.test(edit.value)) fail('This cell value is unsupported.', 'value', 400);
    if (edit.kind === 'number' && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(edit.value) || !Number.isFinite(Number(edit.value)))) fail('Enter a finite number.', 'value', 400);
    selections.add(`${edit.sheet}!${edit.address}`);
    const startTag = sheet.xml.text.slice(cell.node.start, cell.node.openEnd).replace(/\s+t\s*=\s*(?:"[^"]*"|'[^']*')/, '').replace(/\s*\/?>$/, edit.kind === 'string' ? ' t="inlineStr">' : '>');
    const updated = `${startTag}${edit.kind === 'string' ? `<is><t xml:space="preserve">${escape(edit.value)}</t></is>` : `<v>${edit.value}</v>`}</c>`;
    const list = replacements.get(sheet.part) ?? []; list.push({ start: cell.node.start, end: cell.node.end, updated }); replacements.set(sheet.part, list);
  }
  const parts = new Map();
  for (const [part, edits] of replacements) { let xml = workbook.sheets.find((sheet) => sheet.part === part).xml.text; for (const edit of edits.sort((a, b) => b.start - a.start)) xml = xml.slice(0, edit.start) + edit.updated + xml.slice(edit.end); parts.set(part, xml); }
  const calc = workbook.calc[0]; const calcXml = calc ? workbook.workbook.text.slice(calc.start, calc.openEnd) : '<calcPr/>';
  const updatedCalc = calcXml.replace(/\s+(?:fullCalcOnLoad|forceFullCalc)\s*=\s*(?:"[^"]*"|'[^']*')/g, '').replace(/\s*\/?>/, ' fullCalcOnLoad="1" forceFullCalc="1"/>');
  parts.set('xl/workbook.xml', calc ? workbook.workbook.text.slice(0, calc.start) + updatedCalc + workbook.workbook.text.slice(calc.end) : workbook.workbook.text.replace('</workbook>', `${updatedCalc}</workbook>`));
  const candidate = replaceParts(workbook.zip, parts); model(candidate);
  const temp = path.join(path.dirname(source), `.xlsx-copy-${randomUUID()}.tmp`); let created = false;
  try {
    const handle = await io.open(temp, 'wx'); created = true;
    try { await handle.writeFile(candidate); await handle.sync(); } finally { await handle.close(); }
    if ((await snapshot(source)).version !== original.version) fail('The source file changed. Reopen it before saving.', 'source-changed', 409);
    await io.link(temp, destination);
    return { success: true, path: destination };
  } catch (error) {
    if (error.code === 'EEXIST') fail('File already exists. Choose another filename.', 'already-exists', 409);
    throw error;
  } finally { if (created) await io.unlink(temp).catch(() => {}); }
};
