import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDocument } from '../../builtin-skills/supervideo-engine/src/inputs/documents.mjs';

const roots = [];
async function workspace() { const root = await mkdtemp(join(tmpdir(), 'supervideo-office-test-')); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('SuperVideo modern Office boundary', () => {
  it('rejects an invalid modern package before invoking a semantic executable', async () => {
    const root = await workspace(); const input = join(root, 'invalid.docx');
    await writeFile(input, Buffer.from('504b030400000000', 'hex'));
    await expect(extractDocument(input, { projectRoot: root, python: process.execPath, browserExecutable: process.execPath, playwrightModule: root }))
      .rejects.toMatchObject({ code: 'DOCUMENT_SIGNATURE_MISMATCH' });
  });

  it('retains the explicit dependency error for partial converters and legacy documents', async () => {
    const root = await workspace(); const input = join(root, 'legacy.doc');
    await writeFile(input, Buffer.from('d0cf11e0a1b11ae100000000', 'hex'));
    await expect(extractDocument(input, { projectRoot: root, python: process.execPath })).rejects.toMatchObject({ code: 'DEPENDENCY_MISSING' });
    expect(await readFile(input)).toEqual(Buffer.from('d0cf11e0a1b11ae100000000', 'hex'));
  });
});

import { fileURLToPath } from 'node:url';
import { chmod, mkdir, readdir } from 'node:fs/promises';
import { inspectZipDirectory } from '../../builtin-skills/supervideo-engine/src/inputs/office-package.mjs';
import { validatePages, validateSemanticNodes, validatePng, documentTimeout } from '../../builtin-skills/supervideo-engine/src/inputs/office-limits.mjs';
import { runDocumentProcess, probeMarkitdown } from '../../builtin-skills/supervideo-engine/src/inputs/document-process.mjs';
import { renderOfficePages } from '../../builtin-skills/supervideo-engine/src/inputs/office-renderer.mjs';

const inputFixture = fileURLToPath(new URL('./fixtures/office/modern.pptx', import.meta.url));

describe('Office resource limits', () => {
  it('validates real ZIP names before a parser can normalize unsafe or duplicate names', async () => {
    const original = await readFile(inputFixture);
    expect(inspectZipDirectory(original).has('ppt/presentation.xml')).toBe(true);
    const unsafe = Buffer.from(original);
    for (let i = 0; i < unsafe.length - 46; i++) if (unsafe.readUInt32LE(i) === 0x02014b50) { unsafe.write('../', i + 46); break; }
    expect(() => inspectZipDirectory(unsafe)).toThrow(/unsafe/);
    const oversized = Buffer.from(original);
    for (let i = 0; i < oversized.length - 46; i++) if (oversized.readUInt32LE(i) === 0x02014b50) { oversized.writeUInt32LE(600 * 1024 * 1024, i + 24); break; }
    expect(() => inspectZipDirectory(oversized)).toThrow(/size exceeds/);
    expect(() => inspectZipDirectory(original.subarray(0, -10))).toThrow(/ZIP directory/);
  });

  it('refuses excessive page work and invalid PNG dimensions before publication', () => {
    expect(() => validatePages([{ width: 1229, height: 692 }], 1)).not.toThrow();
    for (const pages of [[], Array(201).fill({ width: 1, height: 1 }), [{ width: 8193, height: 1 }], [{ width: 4001, height: 4000 }], Array(17).fill({ width: 4000, height: 4000 }), [{ width: NaN, height: 720 }]]) expect(() => validatePages(pages)).toThrow();
    expect(() => validatePages([{ width: 1, height: 1 }], 2)).toThrow(/slide count/);
    const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.write('IHDR', 12); png.writeUInt32BE(10, 16); png.writeUInt32BE(20, 20);
    expect(validatePng(png)).toEqual({ width: 10, height: 20 });
    expect(() => validatePng(png, { width: 11, height: 20 })).toThrow(/dimensions/);
    png.writeUInt32BE(0, 16); expect(() => validatePng(png)).toThrow();
  });

  it('bounds semantic reconstruction and refuses disabled deadlines', () => {
    validateSemanticNodes([{ text: '中文', locator: 'slide:1/a' }]);
    expect(() => validateSemanticNodes([{ text: 'a'.repeat(16385), locator: 'document' }])).toThrow();
    expect(() => validateSemanticNodes(Array(5001).fill({ text: 'x', locator: 'document' }))).toThrow();
    expect(() => validateSemanticNodes(Array(65).fill({ text: 'x'.repeat(16384), locator: 'document' }))).toThrow();
    for (const timeout of [0, -1, Infinity, NaN, 120001]) expect(() => documentTimeout({ documentTimeoutMs: timeout })).toThrow();
  });
});

describe('Document process boundary', () => {
  it('bounds conversion output and kills a timed out tool', async () => {
    const output = await runDocumentProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(17*1024*1024))"]);
    expect(output.outputLimited).toBe(true); expect(output.stdout.length).toBeLessThanOrEqual(16 * 1024 * 1024);
    const hang = await runDocumentProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 });
    expect(hang.timedOut).toBe(true); expect(hang.code).not.toBe(0);
  });

  it.skipIf(process.platform === 'win32')('rejects plausible MarkItDown versions on failed exit', async () => {
    const root = await workspace(); const executable = join(root, 'markitdown');
    for (const [exit, available] of [[0, true], [1, false]]) {
      await writeFile(executable, `#!${process.execPath}\nconsole.log('markitdown 0.1.7'); process.exit(${exit});\n`); await chmod(executable, 0o700);
      expect((await probeMarkitdown(executable)).available).toBe(available);
    }
    expect((await probeMarkitdown(join(root, 'missing'))).available).toBe(false);
  });
});

describe('Office worker cleanup', () => {
  it.each(['newPage', 'script', 'screenshot', 'hang', 'empty-fallback'])('closes its owned browser when %s fails', async stage => {
    const root = await workspace(); const module = join(root, 'playwright'); await mkdir(module);
    const closed = join(root, 'closed');
    await writeFile(join(module, 'index.mjs'), `
      import {writeFile} from 'node:fs/promises';
      const stage=${JSON.stringify(stage)};let evaluations=0;
      const fail=()=>{throw new Error('fixture '+stage)};
      const page={setDefaultTimeout(){},setDefaultNavigationTimeout(){},async setContent(){},async addScriptTag(){if(stage==='script')fail()},async evaluate(fn,arg){if(stage==='empty-fallback'&&++evaluations===1)fail();if(stage==='hang')await new Promise(()=>{setInterval(()=>{},1000)});},locator(){return {async evaluateAll(){return [{x:0,y:0,width:10,height:10}]},nth(){return {async scrollIntoViewIfNeeded(){},async screenshot(){if(stage!=='empty-fallback')fail();const png=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.write('IHDR',12);png.writeUInt32BE(10,16);png.writeUInt32BE(10,20);return png}}}}},isClosed(){return false}};
      const browser={async newContext(){return {async route(){},async newPage(){if(stage==='newPage')fail();return page}}},async close(){await writeFile(${JSON.stringify(closed)},'closed')},isConnected(){return true}};
      export const chromium={async launchServer(options){if(!options.args.includes('--disable-features=MacAppCodeSignClone'))throw Error('missing mandatory flag'); return {process(){return {pid:0}},wsEndpoint(){return 'fixture'},async close(){}}},async connect(){return browser}};
    `);
    await expect(renderOfficePages(inputFixture, 'pptx', root, { browserExecutable: process.execPath, playwrightModule: module, documentTimeoutMs: stage === 'hang' ? 100 : 5000 }, [], { slideCount: 1 }))
      .rejects.toMatchObject({ code: stage === 'hang' ? 'DOCUMENT_TIMEOUT' : 'DOCUMENT_RENDER_FAILED' });
    if (stage !== 'hang') expect(await readFile(closed, 'utf8')).toBe('closed');
    expect((await readdir(root)).some(name => name.endsWith('.png'))).toBe(false);
  });
});

it('counts fractional page edges in the actual raster dimensions', async () => {
  const limits = await import('../../builtin-skills/supervideo-engine/src/inputs/office-limits.mjs');
  expect(limits.pageRasterSize?.({ x: 199.59375, y: 24, width: 1230.8125, height: 693.1875 })).toEqual({ width: 1232, height: 694 });
});

it('uses one bounded browser probe for browser and Office capabilities', async () => {
  const { doctorDocuments } = await import('../../builtin-skills/supervideo-engine/src/providers/doctor.mjs');
  const root = await workspace(); const module = join(root, 'browser'); await mkdir(module);
  const launches = join(root, 'launches');
  await writeFile(join(module, 'index.mjs'), `
    import {appendFile} from 'node:fs/promises';
    export const chromium={async launchServer(options){await appendFile(${JSON.stringify(launches)},JSON.stringify(options)+'\\n');return {process(){return {pid:0}},wsEndpoint(){return 'fixture'},async close(){}}},async connect(){return {version(){return '156-fixture'},async close(){}}}};
  `);
  const result = await doctorDocuments({ browserExecutable: process.execPath, playwrightModule: module, markitdown: join(root, 'missing') });
  expect(result.find(item => item.id === 'playwright-browser').available).toBe(true);
  expect(result.find(item => item.id === 'office-browser-renderer').available).toBe(true);
  expect(result.find(item => item.id === 'markitdown').available).toBe(false);
  const records = (await readFile(launches, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(records).toHaveLength(1);
  expect(records[0].args).toContain('--disable-features=MacAppCodeSignClone');
});

it('passes the required macOS flag to the existing website browser launch', async () => {
  const { openWebsiteBrowser } = await import('../../builtin-skills/supervideo-engine/src/inputs/website.mjs');
  const root = await workspace(); const module = join(root, 'browser'); await mkdir(module);
  const launch = join(root, 'launch');
  await writeFile(join(module, 'index.mjs'), `import {writeFile} from 'node:fs/promises';export const chromium={async launch(options){await writeFile(${JSON.stringify(launch)},JSON.stringify(options));throw Error('fixture launch refusal')}};`);
  await expect(openWebsiteBrowser(root, { width: 320, height: 240 }, { playwrightModule: module })).rejects.toThrow('fixture launch refusal');
  expect(JSON.parse(await readFile(launch, 'utf8')).args).toContain('--disable-features=MacAppCodeSignClone');
});

it('keeps reconstructed-page diagnostics in PPT planning receipts and cached source copies', async () => {
  const { createProject } = await import('../../builtin-skills/supervideo-engine/src/core/store.mjs');
  const { buildPptScenes, validatePptPlan } = await import('../../builtin-skills/supervideo-engine/src/modes/ppt.mjs');
  const project = await createProject(await workspace(), { mode: 'ppt', output: { width: 1280, height: 720, fps: 30 } });
  project.assets.push({ id: 'page-asset', path: 'page.png', sha256: 'b'.repeat(64), mediaType: 'image/png', origin: { kind: 'source', reference: 'fixture', version: '1' } });
  project.sources.push({ id: 'source', kind: 'pptx', original: 'fixture.pptx', hash: 'a'.repeat(64), warnings: [{ code: 'OFFICE_RENDER_FALLBACK', locator: 'document', detail: 'Reconstructed text only. Fixture unsupported chart' }], nodes: [{ id: 'page', kind: 'page', text: 'Slide', order: 0, locator: 'slide:1', assetIds: ['page-asset'] }, { id: 'text', kind: 'paragraph', text: 'Source-grounded narration', order: 1, locator: 'slide:1/text', parentId: 'page', assetIds: [] }] });
  project.scenes = buildPptScenes(project, { sourceId: 'source', pages: [{ pageId: 'page', segments: [{ id: 'scene', objective: 'Explain the source', sourceNodeIds: ['text'], sentences: [{ id: 'sentence', text: 'Source-grounded narration', voiceId: 'host' }] }] }] });
  for (const value of [project, JSON.parse(JSON.stringify(project))]) {
    const receipt = validatePptPlan(value); expect(receipt.status).toBe('succeeded');
    const evidence = receipt.checks.find(check => check.name === 'static-page-visuals').evidence;
    expect(evidence).toContain('OFFICE_RENDER_FALLBACK');
    expect(evidence).toContain('reconstructed text');
    expect(evidence).not.toContain('Original rendered static pages');
  }
});

it.skipIf(process.platform === 'win32')('runs browser-owner exit cleanup when launch has not returned a PID', async () => {
  const root = await workspace(); const module = join(root, 'browser'); await mkdir(module); const pidFile = join(root, 'browser-pid');
  await writeFile(join(module, 'index.mjs'), `
    import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
    export const chromium={async launchServer(){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.once('exit',()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}});await new Promise(()=>{setInterval(()=>{},1000)});}};
  `);
  let pid;
  try {
    await expect(renderOfficePages(inputFixture, 'pptx', root, { browserExecutable: process.execPath, playwrightModule: module, documentTimeoutMs: 200 }, [], { slideCount: 1 })).rejects.toMatchObject({ code: 'DOCUMENT_TIMEOUT' });
    pid = Number(await readFile(pidFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 25 && alive; attempt++) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  } finally { if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} } }
});
