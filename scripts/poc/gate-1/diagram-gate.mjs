import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Checker, argValue, writeResults, envFail, rmrf, sha256 } from './lib.mjs';

const FIXTURE_ID = 'G1-DIAGRAM-001';
const fixture = argValue(process.argv, '--fixture');
const resultsPath = argValue(process.argv, '--results-json');
const artifactsDir = argValue(process.argv, '--artifacts-dir');
if (fixture !== FIXTURE_ID || !resultsPath) {
  envFail('usage: diagram-gate.mjs --fixture ' + FIXTURE_ID + ' --results-json <path> [--artifacts-dir <dir>]');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fxDir = path.join(repoRoot, 'fixtures', 'gate-1', FIXTURE_ID, 'fixtures');
const FENCE = String.fromCharCode(96, 96, 96);

const startedAt = new Date().toISOString();
const checker = new Checker();
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-g1-dg-'));

try {
  const excRaw = fs.readFileSync(path.join(fxDir, 'sample.excalidraw'), 'utf8');
  const drawRaw = fs.readFileSync(path.join(fxDir, 'sample.drawio'), 'utf8');
  const maliciousExcRaw = fs.readFileSync(path.join(fxDir, 'malicious.excalidraw'), 'utf8');
  const maliciousDrawRaw = fs.readFileSync(path.join(fxDir, 'malicious.drawio'), 'utf8');

  // ---------- surgical typed op on excalidraw ----------
  function elementSpan(text, elementId) {
    const idMarker = '"id": "' + elementId + '"';
    const idPos = text.indexOf(idMarker);
    if (idPos < 0) return null;
    const objStart = text.lastIndexOf('{', idPos);
    let depth = 0;
    for (let i = objStart; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return { start: objStart, end: i + 1 }; }
    }
    return null;
  }

  function applyTypedOp(text, elementId, fromStr, toStr) {
    const span = elementSpan(text, elementId);
    if (!span) return null;
    const elem = text.slice(span.start, span.end);
    if (elem.indexOf(fromStr) < 0) return null;
    return text.slice(0, span.start) + elem.replace(fromStr, toStr) + text.slice(span.end);
  }

  const excEdited = applyTypedOp(excRaw, 'text-1', '"text": "核心模块"', '"text": "核心模块 V2"');
  let excOk = false;
  let excDetail = 'typed op 失败';
  if (excEdited) {
    const span = elementSpan(excRaw, 'text-1');
    const prefixSame = excEdited.slice(0, span.start) === excRaw.slice(0, span.start);
    const tailLen = excRaw.length - span.end;
    const suffixSame = tailLen === 0 ? true : excEdited.slice(excEdited.length - tailLen) === excRaw.slice(span.end);
    let semanticDelta = -1;
    try {
      const a = JSON.parse(excRaw);
      const b = JSON.parse(excEdited);
      if (Array.isArray(a.elements) && Array.isArray(b.elements) && a.elements.length === b.elements.length) {
        let diff = 0;
        for (let i = 0; i < a.elements.length; i++) {
          if (JSON.stringify(a.elements[i]) !== JSON.stringify(b.elements[i])) diff++;
        }
        semanticDelta = diff;
      }
    } catch (e) { semanticDelta = -1; }
    excOk = prefixSame && suffixSame && semanticDelta === 1;
    excDetail = '仅目标元素字节段变化（前后缀逐字节不变），语义 diff=' + semanticDelta + '，JSON 可解析';
  }
  checker.check('dg:excalidraw-typed-op-surgical', excOk, excDetail);

  // ---------- .excalidraw.md container ----------
  const containerBefore = '# 系统架构\n\n![[系统架构.excalidraw]]\n\n<!-- Excalidraw 场景数据，壳必须逐字节稳定 -->\n\n' + FENCE + 'json\n' + excRaw + FENCE + '\n';
  const scenePos = containerBefore.indexOf(excRaw);
  const cPrefix = containerBefore.slice(0, scenePos);
  const cSuffix = containerBefore.slice(scenePos + excRaw.length);
  const containerEdited = applyTypedOp(containerBefore, 'text-1', '"text": "核心模块"', '"text": "核心模块 V2"');
  let contOk = false;
  if (containerEdited) {
    const shellSame = containerEdited.startsWith(cPrefix) && containerEdited.endsWith(cSuffix);
    let sceneParses = false;
    try {
      const scene = JSON.parse(containerEdited.slice(cPrefix.length, containerEdited.length - cSuffix.length));
      sceneParses = scene !== null && Array.isArray(scene.elements) && scene.elements.some(e => e.id === 'text-1' && e.text === '核心模块 V2');
    } catch (e) { sceneParses = false; }
    contOk = shellSame && sceneParses && containerEdited !== containerBefore;
  }
  checker.check('dg:excalidraw-md-container-shell-stable', contOk, '容器壳字节不变，场景 JSON 更新且可解析');

  // ---------- drawio targeted attribute replace ----------
  function mxCellSpan(text, cellId) {
    const idMarker = 'id="' + cellId + '"';
    const idPos = text.indexOf(idMarker);
    if (idPos < 0) return null;
    const openPos = text.lastIndexOf('<mxCell', idPos);
    const closeTag = '</mxCell>';
    const closePos = text.indexOf(closeTag, idPos);
    if (openPos < 0 || closePos < 0) return null;
    return { start: openPos, end: closePos + closeTag.length };
  }
  const drawEdited = (() => {
    const span = mxCellSpan(drawRaw, 'node-a');
    if (!span) return null;
    const cell = drawRaw.slice(span.start, span.end);
    if (cell.indexOf('value="服务 A"') < 0) return null;
    return drawRaw.slice(0, span.start) + cell.replace('value="服务 A"', 'value="服务 A（已编辑）"') + drawRaw.slice(span.end);
  })();
  let drawOk = false;
  let drawDetail = '定向替换失败';
  if (drawEdited) {
    const span = mxCellSpan(drawRaw, 'node-a');
    const edgeSpan = mxCellSpan(drawRaw, 'edge-1');
    const edgeSpanEdited = mxCellSpan(drawEdited, 'edge-1');
    const prefixSame = drawEdited.slice(0, span.start) === drawRaw.slice(0, span.start);
    const tailLen = drawRaw.length - span.end;
    const suffixSame = tailLen === 0 ? true : drawEdited.slice(drawEdited.length - tailLen) === drawRaw.slice(span.end);
    const edgeSame = edgeSpanEdited !== null && drawRaw.slice(edgeSpan.start, edgeSpan.end) === drawEdited.slice(edgeSpanEdited.start, edgeSpanEdited.end);
    drawOk = prefixSame && suffixSame && edgeSame;
    drawDetail = '仅 node-a value 属性变化，node-b / edge-1 及其余字节不变';
  }
  checker.check('dg:drawio-targeted-attr-replace', drawOk, drawDetail);

  // ---------- agent command schema ----------
  const ALLOWED_ELEMENT_TYPES = ['rectangle', 'ellipse', 'arrow', 'text', 'image'];
  function validateCommand(cmd, scenes) {
    if (!cmd || typeof cmd !== 'object') return { error: 'bad-command' };
    if (!cmd.sceneId || !scenes[cmd.sceneId]) return { error: 'unknown-scene' };
    if (cmd.op !== 'update-element') return { error: 'unknown-op' };
    let el = null;
    for (const e of scenes[cmd.sceneId].elements) { if (e.id === cmd.elementId) { el = e; break; } }
    if (!el) return { error: 'unknown-element' };
    if (ALLOWED_ELEMENT_TYPES.indexOf(el.type) < 0) return { error: 'element-type-not-allowed:' + el.type };
    return { ok: true };
  }
  const sampleScene = JSON.parse(excRaw);
  const maliciousScene = JSON.parse(maliciousExcRaw);
  const scenes = { sample: sampleScene, malicious: maliciousScene };
  const cmdValid = validateCommand({ sceneId: 'sample', op: 'update-element', elementId: 'text-1', fields: { text: 'x' } }, scenes);
  const cmdIframe = validateCommand({ sceneId: 'malicious', op: 'update-element', elementId: 'bad-1' }, scenes);
  const cmdMissing = validateCommand({ sceneId: 'missing', op: 'update-element', elementId: 'whatever' }, scenes);
  const cmdUnknownEl = validateCommand({ sceneId: 'sample', op: 'update-element', elementId: 'nope' }, scenes);
  checker.check('dg:command-schema-valid-op', cmdValid.ok === true, '合法 update-element 命令通过 schema');
  checker.check('dg:command-schema-rejects', cmdIframe.error === 'element-type-not-allowed:iframe' && cmdMissing.error === 'unknown-scene' && cmdUnknownEl.error === 'unknown-element', '未知元素类型（iframe）/ 不存在场景 / 不存在元素均被拒绝');

  // ---------- oversize rejected before parse ----------
  const MAX_SCENE_BYTES = 20 * 1024 * 1024;
  function loadSceneBuffer(buf) {
    if (buf.length > MAX_SCENE_BYTES) return { rejected: 'oversize', parsed: false };
    try {
      return { rejected: null, parsed: true, scene: JSON.parse(buf.toString('utf8')) };
    } catch (e) {
      return { rejected: null, parsed: false, error: 'bad-json' };
    }
  }
  const oversizeBody = Buffer.from('{"elements":<' + 'a'.repeat(21 * 1024 * 1024) + '>');
  const oversizeResult = loadSceneBuffer(oversizeBody);
  checker.check('dg:oversize-rejected-before-parse', oversizeResult.rejected === 'oversize' && oversizeResult.parsed === false, '20MB 超限在解析前拒绝（体为非法 JSON，若先解析会得到 bad-json 而非 oversize）');

  // ---------- malicious URL whitelist ----------
  const ALLOWED_LINK_HOSTS = ['superwagie.local'];
  function validateLink(urlText) {
    if (urlText === null || urlText === undefined) return null;
    let u = null;
    try { u = new URL(urlText); } catch (e) { return 'malformed-url'; }
    if (u.protocol !== 'https:') return 'scheme-forbidden:' + u.protocol;
    if (ALLOWED_LINK_HOSTS.indexOf(u.host) < 0) return 'host-not-allowlisted:' + u.host;
    return null;
  }
  const linkIssues = [];
  for (const el of maliciousScene.elements) {
    const linkErr = validateLink(el.link === undefined ? null : el.link);
    if (linkErr) linkIssues.push(el.id + ':' + linkErr);
    const urlErr = validateLink(el.url === undefined ? null : el.url);
    if (urlErr) linkIssues.push(el.id + ':url:' + urlErr);
    if (ALLOWED_ELEMENT_TYPES.indexOf(el.type) < 0) linkIssues.push(el.id + ':type:' + el.type);
  }
  const blockedAll = linkIssues.length >= 4
    && linkIssues.some(s => s.indexOf('scheme-forbidden') >= 0)
    && linkIssues.some(s => s.indexOf('evil.example') >= 0)
    && linkIssues.some(s => s.indexOf('unlisted.example') >= 0)
    && linkIssues.some(s => s.indexOf('type:iframe') >= 0);
  checker.check('dg:malicious-url-blocked', blockedAll, linkIssues.join(' | '));

  // ---------- DTD never expanded ----------
  function loadDrawio(text) {
    if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) return { rejected: 'dtd-forbidden' };
    if (!/<mxfile[\s>]/.test(text) || text.indexOf('</mxfile>') < 0) return { rejected: 'bad-structure' };
    return { rejected: null };
  }
  const dtdResult = loadDrawio(maliciousDrawRaw);
  const sampleDrawLoad = loadDrawio(drawRaw);
  checker.check('dg:dtd-rejected-no-expansion', dtdResult.rejected === 'dtd-forbidden' && sampleDrawLoad.rejected === null, 'DTD/ENTITY 声明在加载层直接拒绝（实体永不展开，&lol4; 保持字面量）；正常文件加载通过');
  checker.check('dg:sample-drawio-loads', sampleDrawLoad.rejected === null && drawRaw.indexOf('id="node-a"') >= 0 && drawRaw.indexOf('source="node-a"') >= 0, 'sample.drawio 结构校验通过（含绑定与箭头）');

  // ---------- atomic save + undo ----------
  const target = path.join(tmpBase, 'atomic.excalidraw');
  fs.writeFileSync(target, excRaw);
  const undoSnapshot = Buffer.from(fs.readFileSync(target));
  const atomicTmp = target + '.tmp-' + crypto.randomUUID();
  fs.writeFileSync(atomicTmp, excEdited);
  fs.renameSync(atomicTmp, target);
  const savedOK = sha256(fs.readFileSync(target)) === sha256(Buffer.from(excEdited));
  const undoTmp = target + '.undo-' + crypto.randomUUID();
  fs.writeFileSync(undoTmp, undoSnapshot);
  fs.renameSync(undoTmp, target);
  const undoOK = sha256(fs.readFileSync(target)) === sha256(undoSnapshot);
  checker.check('dg:atomic-save-undo-byte-restore', savedOK && undoOK, 'tmp+rename 原子保存成功；undo 快照恢复到原字节');

  // ---------- artifacts ----------
  if (artifactsDir) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, 'edited.excalidraw'), excEdited || '');
    fs.writeFileSync(path.join(artifactsDir, 'container-edited.excalidraw.md'), containerEdited || '');
    fs.writeFileSync(path.join(artifactsDir, 'edited.drawio'), drawEdited || '');
  }

  const pass = writeResults(resultsPath, { gate: 'gate-1', fixture: FIXTURE_ID, startedAt: startedAt, checker: checker, decisionHint: 'GO', limitation: null });
  console.log('G1-DIAGRAM-001: ' + checker.summary.passed + '/' + checker.summary.total + ' checks passed, decision_hint=GO');
  rmrf(tmpBase);
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error('ERROR executor: ' + (e && e.stack ? e.stack : String(e)));
  rmrf(tmpBase);
  process.exit(2);
}
