import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import JSZip from '../../../../ui/node_modules/jszip/lib/index.js';
import { inspectXlsxCopy, saveXlsxCopy } from './xlsx-copy.js';
import { registerFsRoutes } from './routes.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sheet = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="1"><v>4</v></c><c r="B1"><f>Other!A1+A1</f><v>9</v></c><c r="C1" t="inlineStr"><is><t>old</t></is></c></row><row r="2"><c r="A2"><v>8</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A2:B2"/></mergeCells><drawing r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></worksheet>';
const fixture = async (change = () => {}) => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>');
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Main" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/><sheet name="Hidden" sheetId="3" state="hidden" r:id="rId3"/></sheets><calcPr calcId="1"/></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/><Relationship Id="rId2" Target="worksheets/sheet2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/><Relationship Id="rId3" Target="worksheets/sheet3.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', sheet);
  zip.file('xl/worksheets/sheet2.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>5</v></c></row></sheetData></worksheet>');
  zip.file('xl/worksheets/sheet3.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>HIDDEN SECRET</t></is></c></row></sheetData></worksheet>');
  zip.file('xl/styles.xml', '<styleSheet><cellXfs count="2"><xf/><xf numFmtId="4"/></cellXfs></styleSheet>');
  change(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
};

test('selected literal save preserves source bytes, other XML, formulas, styles and merges', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xlsx-copy-')); t.onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'original.xlsx'); const original = await fixture(); await fs.writeFile(source, original);
  const inspected = await inspectXlsxCopy(source);
  assert.deepEqual(inspected.sheets.map((item) => item.name), ['Main', 'Other']);
  assert.ok(!JSON.stringify(inspected).includes('HIDDEN SECRET'));
  assert.equal(inspected.sheets[0].cells.find((cell) => cell.address === 'B1').editable, false);
  const saved = await saveXlsxCopy(source, { version: inspected.version, name: 'edited.xlsx', edits: [{ sheet: 'Main', address: 'A1', kind: 'number', value: '12' }] });
  assert.equal(hash(await fs.readFile(source)), hash(original));
  const before = await JSZip.loadAsync(original); const after = await JSZip.loadAsync(await fs.readFile(saved.path));
  for (const name of Object.keys(before.files).filter((name) => !before.files[name].dir)) {
    const actual = await after.file(name).async('string'); const expected = await before.file(name).async('string');
    if (name === 'xl/worksheets/sheet1.xml') assert.equal(actual, expected.replace('<c r="A1" s="1"><v>4</v></c>', '<c r="A1" s="1"><v>12</v></c>'));
    else if (name !== 'xl/workbook.xml') assert.equal(actual, expected, name);
  }
  assert.match(await after.file('xl/workbook.xml').async('string'), /fullCalcOnLoad="1"/);
});

test('excluded features are classified by OOXML semantics under nonconventional part names', async () => {
  for (const feature of [
    { type: 'externalLink', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml' },
    { type: 'chart', mime: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml' },
    { type: 'pivotTable', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml' },
    { type: 'oleObject', mime: 'application/vnd.openxmlformats-officedocument.oleObject' },
    { type: 'customXml', mime: 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml' },
    { type: 'activeXControl', mime: 'application/vnd.ms-office.activeX+xml' },
    { type: 'control', mime: 'application/vnd.ms-excel.controlproperties+xml' },
    { type: 'vbaProject', mime: 'application/vnd.ms-office.vbaProject' },
    { type: 'digital-signature/signature', mime: 'application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml' },
  ]) {
    for (const via of ['relationship', 'content-type']) {
    const bytes = await fixture((zip) => {
      zip.file('xl/ordinary/item.xml', '<item/>');
      zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="special" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + (via === 'relationship' ? feature.type : 'customData') + '" Target="ordinary/item.xml"/></Relationships>');
      zip.file('[Content_Types].xml', '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/ordinary/item.xml" ContentType="' + (via === 'content-type' ? feature.mime : 'application/xml') + '"/></Types>');
    });
    await assert.rejects(inspectXlsxCopy(bytes), /read.only|unsupported/i, `${feature.type}/${via}`);
    }
  }
});

test('workbook external references and nested external targets are refused independently of part filenames', async () => {
  for (const via of ['workbook-tag', 'nested-relationship']) {
    const zip = await JSZip.loadAsync(await fixture());
    if (via === 'workbook-tag') zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml').async('string')).replace('</workbook>', '<externalReferences><externalReference r:id="special"/></externalReferences></workbook>'));
    else zip.file('xl/ordinary/_rels/item.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="outside" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="file:///offline/source.xlsx" TargetMode="External"/></Relationships>');
    await assert.rejects(inspectXlsxCopy(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })), /read.only|unsupported/i, via);
  }
});

test('charts are refused before editing even when only a chart relationship or content type identifies them', async () => {
  for (const semantic of ['relationship', 'content-type', 'filename']) {
    const bytes = await fixture((zip) => {
      zip.file(semantic === 'filename' ? 'xl/charts/chart1.xml' : 'xl/ordinary/visual.xml', '<chartSpace/>');
      if (semantic === 'relationship') zip.file('xl/drawings/_rels/ordinary.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="chart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../ordinary/visual.xml"/></Relationships>');
      if (semantic === 'content-type') zip.file('[Content_Types].xml', '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/ordinary/visual.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>');
    });
    await assert.rejects(inspectXlsxCopy(bytes), /read.only|unsupported/i, semantic);
  }
});

test('XML1.0 forbidden characters are rejected and carriage returns roundtrip through an independent XML parser', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xlsx-xml-text-')); t.onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'original.xlsx'); const original = await fixture(); await fs.writeFile(source, original);
  const inspected = await inspectXlsxCopy(source);
  for (const value of ['a\uFFFEb', 'a\uFFFFb', 'a\u0001b', 'a\uD800b']) {
    await assert.rejects(saveXlsxCopy(source, { version: inspected.version, name: 'invalid.xlsx', edits: [{ sheet: 'Main', address: 'C1', kind: 'string', value }] }), /unsupported/i);
  }
  const value = 'a\r\nb\rc\n\t<>&😀';
  const result = await saveXlsxCopy(source, { version: inspected.version, name: 'text.xlsx', edits: [{ sheet: 'Main', address: 'C1', kind: 'string', value }] });
  const zip = await JSZip.loadAsync(await fs.readFile(result.path));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const readback = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys,json,xml.etree.ElementTree as ET; root=ET.fromstring(sys.stdin.buffer.read()); cell=next(cell for cell in root.iter() if cell.tag.endswith("}c") and cell.attrib.get("r")=="C1"); print(json.dumps("".join(cell.itertext()), ensure_ascii=True))'], { input: xml, encoding: 'utf8' });
  assert.equal(JSON.parse(readback), value);
  assert.equal((await inspectXlsxCopy(result.path)).sheets[0].cells.find((cell) => cell.address === 'C1').value, value);
  assert.equal(hash(await fs.readFile(source)), hash(original));
  assert.deepEqual((await fs.readdir(dir)).sort(), ['original.xlsx', 'text.xlsx']);
});

test('inspection normalizes literal XML line endings but preserves referenced carriage returns', async () => {
  const bytes = await fixture((zip) => zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a\r\nb\rc&#13;d</t></is></c></row></sheetData></worksheet>'));
  assert.equal((await inspectXlsxCopy(bytes)).sheets[0].cells[0].value, 'a\nb\nc\rd');
});

test('macros, protection and signed packages are refused before edits', async () => {
  for (const change of [
    (zip) => zip.file('xl/vbaProject.bin', 'macro'),
    (zip) => zip.file('xl/worksheets/sheet2.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetProtection sheet="1"/><sheetData/></worksheet>'),
    (zip) => zip.file('_xmlsignatures/sig1.xml', '<Signature/>'),
    (zip) => zip.file('xl/pivotTables/pivotTable1.xml', '<pivotTableDefinition/>'),
    (zip) => zip.file('xl/worksheets/sheet2.xml', '<worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetProtection sheet="1"/><sheetData/></worksheet>'),
  ]) await assert.rejects(inspectXlsxCopy(await fixture(change)), /read.only|unsupported/i);
});

test('inspection excludes hidden rows and columns and quotes only resolved visible cell values', async () => {
  const bytes = await fixture((zip) => zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="2" max="2" hidden="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Visible &amp; exact</t></is></c><c r="B1" t="inlineStr"><is><t>HIDDEN COLUMN</t></is></c></row><row r="2" hidden="1"><c r="A2" t="inlineStr"><is><t>HIDDEN ROW</t></is></c></row></sheetData></worksheet>'));
  const result = await inspectXlsxCopy(bytes);
  assert.equal(result.sheets[0].cells[0].value, 'Visible & exact');
  assert.deepEqual(result.sheets[0].cells.map((cell) => cell.address), ['A1']);
  assert.ok(!JSON.stringify(result).includes('HIDDEN'));
});

test('an unused binary content-type default does not classify an ordinary XLSX as macro enabled', async () => {
  const bytes = await fixture((zip) => zip.file('[Content_Types].xml', '<Types><Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'));
  assert.equal((await inspectXlsxCopy(bytes)).sheets[0].name, 'Main');
});

test('conflicts and failure leave source and existing destination intact and remove candidates', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xlsx-copy-')); t.onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'original.xlsx'); const bytes = await fixture(); await fs.writeFile(source, bytes);
  const inspected = await inspectXlsxCopy(source);
  const request = { version: inspected.version, name: 'edited.xlsx', edits: [{ sheet: 'Main', address: 'A1', kind: 'string', value: '<changed>&' }] };
  await fs.writeFile(path.join(dir, 'edited.xlsx'), 'keep');
  await assert.rejects(saveXlsxCopy(source, request), /exists/i);
  assert.equal(await fs.readFile(path.join(dir, 'edited.xlsx'), 'utf8'), 'keep');
  await assert.rejects(saveXlsxCopy(source, { ...request, name: 'original.xlsx' }), /distinct|original/i);
  await assert.rejects(saveXlsxCopy(source, { ...request, name: '../escape.xlsx' }), /name/i);
  await assert.rejects(saveXlsxCopy(source, { ...request, name: 'formula.xlsx', edits: [{ sheet: 'Main', address: 'B1', kind: 'number', value: '1' }] }), /read.only/i);
  await assert.rejects(saveXlsxCopy(source, { ...request, name: 'hidden.xlsx', edits: [{ sheet: 'Hidden', address: 'A1', kind: 'string', value: 'leak' }] }), /selection/i);
  await fs.appendFile(source, 'changed');
  await assert.rejects(saveXlsxCopy(source, { ...request, name: 'conflict.xlsx' }), /changed/i);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['edited.xlsx', 'original.xlsx']);
});

test('filesystem route applies workspace authorization and publishes a distinct copy', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xlsx-route-')); t.onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'xlsx-outside-')); t.onTestFinished(() => fs.rm(outside, { recursive: true, force: true }));
  const source = path.join(dir, 'original.xlsx'); const bytes = await fixture(); await fs.writeFile(source, bytes);
  const routes = new Map();
  registerFsRoutes({ get() {}, post(route, handler) { routes.set(route, handler); } }, {
    path, os, fsPromises: fs, crypto: globalThis.crypto, spawn() {}, normalizeDirectoryPath: (value) => value,
    resolveProjectDirectory: async () => ({ directory: dir }), buildAugmentedPath: () => '/usr/bin', openchamberUserConfigRoot: path.join(dir, 'config'),
  });
  const server = createServer(async (req, res) => {
    const body = []; for await (const chunk of req) body.push(chunk);
    req.body = JSON.parse(Buffer.concat(body).toString());
    res.status = (code) => { res.statusCode = code; return res; }; res.json = (payload) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); };
    await routes.get(req.url)(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.onTestFinished(() => new Promise((resolve) => server.close(resolve)));
  const post = (operation, body) => fetch(`http://127.0.0.1:${server.address().port}/api/fs/xlsx-copy/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const inspected = await (await post('inspect', { path: source })).json();
  assert.equal(inspected.sheets[0].name, 'Main');
  const request = { path: source, version: inspected.version, name: 'copy.xlsx', edits: [{ sheet: 'Main', address: 'C1', kind: 'string', value: '<new>& "value"' }] };
  const saved = await post('save', request); assert.equal(saved.status, 200);
  const copy = await JSZip.loadAsync(await fs.readFile(path.join(dir, 'copy.xlsx')));
  assert.match(await copy.file('xl/worksheets/sheet1.xml').async('string'), /&lt;new&gt;&amp; &quot;value&quot;/);
  assert.equal(hash(await fs.readFile(source)), hash(bytes));
  assert.equal((await post('save', request)).status, 409);
  const outer = path.join(outside, 'other.xlsx'); await fs.writeFile(outer, bytes); await fs.symlink(outer, path.join(dir, 'link.xlsx'));
  assert.equal((await post('inspect', { path: path.join(dir, 'link.xlsx') })).status, 403);
  assert.equal((await post('save', { ...request, path: outer })).status, 403);
  assert.equal(hash(await fs.readFile(outer)), hash(bytes));
});

test('a source changed while the candidate is written prevents publication', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xlsx-during-save-')); t.onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'original.xlsx'); await fs.writeFile(source, await fixture());
  const inspection = await inspectXlsxCopy(source);
  const io = { ...fs, async open(filename, flags) { const handle = await fs.open(filename, flags); await fs.appendFile(source, 'external edit'); return handle; } };
  await assert.rejects(saveXlsxCopy(source, { version: inspection.version, name: 'conflict.xlsx', edits: [{ sheet: 'Main', address: 'A1', kind: 'number', value: '17' }] }, io), /changed/i);
  assert.deepEqual(await fs.readdir(dir), ['original.xlsx']);
  assert.equal((await fs.readFile(source)).subarray(-13).toString(), 'external edit');
});

test('an interrupted candidate write preserves the original and removes the partial candidate', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xlsx-write-error-')); t.onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'original.xlsx'); const original = await fixture(); await fs.writeFile(source, original);
  const inspection = await inspectXlsxCopy(source);
  const io = { ...fs, async open(filename, flags) {
    const handle = await fs.open(filename, flags);
    return { async writeFile(bytes) { await handle.writeFile(bytes.subarray(0, 10)); throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); }, sync: () => handle.sync(), close: () => handle.close() };
  } };
  await assert.rejects(saveXlsxCopy(source, { version: inspection.version, name: 'partial.xlsx', edits: [{ sheet: 'Main', address: 'A1', kind: 'number', value: '17' }] }, io), /Disk full/);
  assert.equal(hash(await fs.readFile(source)), hash(original)); assert.deepEqual(await fs.readdir(dir), ['original.xlsx']);
});

test('numeric rejection and malformed or oversized archives cannot produce a copy', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xlsx-invalid-')); t.onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'original.xlsx'); await fs.writeFile(source, await fixture());
  const inspected = await inspectXlsxCopy(source);
  await assert.rejects(saveXlsxCopy(source, { version: inspected.version, name: 'bad.xlsx', edits: [{ sheet: 'Main', address: 'A1', kind: 'number', value: '=2+2' }] }), /finite number/i);
  await assert.rejects(inspectXlsxCopy(Buffer.alloc(30 * 1024 * 1024 + 1)), /30 MiB/);
  await assert.rejects(inspectXlsxCopy(Buffer.from('invalid')), /read.only/i);
  assert.deepEqual(await fs.readdir(dir), ['original.xlsx']);
});
