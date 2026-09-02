import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Checker, argValue, writeResults, envFail, rmrf, sha256 } from './lib.mjs';
import { assertContainedDirectoryChainSync, readStableRegularFileSync } from '../secure-file-read.mjs';

const FIXTURE_ID = 'G1-MARKDOWN-001';
const fixture = argValue(process.argv, '--fixture');
const resultsPath = argValue(process.argv, '--results-json');
const artifactsDir = argValue(process.argv, '--artifacts-dir');
const checklistResultPath = argValue(process.argv, '--checklist-result');
const obsidianVault = argValue(process.argv, '--obsidian-vault');
const platform = argValue(process.argv, '--platform');
if (fixture !== FIXTURE_ID || !resultsPath) {
  envFail('usage: markdown-gate.mjs --fixture ' + FIXTURE_ID + ' --results-json <path> [--platform <platform>] [--artifacts-dir <dir>] [--checklist-result <json>] [--obsidian-vault <vault-dir>]');
}
if (obsidianVault && !fs.existsSync(path.join(obsidianVault, '.obsidian'))) {
  envFail('--obsidian-vault must point to an Obsidian vault containing .obsidian: ' + obsidianVault);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixtureFile = path.join(repoRoot, 'fixtures', 'gate-1', FIXTURE_ID, 'fixtures', 'torture.md');
const fixtureAssetsDir = path.dirname(fixtureFile);
const fixturePng = path.join(fixtureAssetsDir, '图片素材.png');
const fixtureDrawing = path.join(fixtureAssetsDir, '系统架构.excalidraw.md');
const FENCE = String.fromCharCode(96, 96, 96);
const CHECKLIST_SCHEMA_ID = 'superwagie.g1-markdown-obsidian-checklist.v1';
const CHECKLIST_SCHEMA_VERSION = 1;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_REVIEW_BYTES = 16 * 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, allowedKeys, label, errors) {
  if (!isObject(value)) return;
  const allowed = new Set(allowedKeys);
  const extras = Object.keys(value).filter(function (key) { return !allowed.has(key); });
  if (extras.length > 0) errors.push(label + ' has undeclared fields: ' + extras.join(','));
}

function assertNoDuplicateJsonKeys(text) {
  let index = 0;
  function fail(message) { throw new Error(message + ' at byte ' + index); }
  function skipWhitespace() { while (/\s/.test(text[index] || '')) index += 1; }
  function parseString() {
    skipWhitespace();
    if (text[index] !== '"') fail('expected JSON string');
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      index += 1;
    }
    fail('unterminated JSON string');
  }
  function parseValue() {
    skipWhitespace();
    if (text[index] === '{') return parseObject();
    if (text[index] === '[') return parseArray();
    if (text[index] === '"') { parseString(); return; }
    const start = index;
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
    if (start === index) fail('expected JSON value');
    JSON.parse(text.slice(start, index));
  }
  function parseObject() {
    index += 1;
    skipWhitespace();
    const keys = new Set();
    if (text[index] === '}') { index += 1; return; }
    while (index < text.length) {
      const key = parseString();
      if (keys.has(key)) fail('duplicate JSON key: ' + key);
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ':') fail('expected colon');
      index += 1;
      parseValue();
      skipWhitespace();
      if (text[index] === '}') { index += 1; return; }
      if (text[index] !== ',') fail('expected object separator');
      index += 1;
    }
    fail('unterminated JSON object');
  }
  function parseArray() {
    index += 1;
    skipWhitespace();
    if (text[index] === ']') { index += 1; return; }
    while (index < text.length) {
      parseValue();
      skipWhitespace();
      if (text[index] === ']') { index += 1; return; }
      if (text[index] !== ',') fail('expected array separator');
      index += 1;
    }
    fail('unterminated JSON array');
  }
  parseValue();
  skipWhitespace();
  if (index !== text.length) fail('unexpected trailing JSON bytes');
}

function validateChecklistBinding(checklistPath) {
  const errors = [];
  let checklistBytes = null;
  let preparationBytes = null;
  let checklist = null;
  let preparation = null;
  let evidenceBinding = null;

  try {
    checklistBytes = readStableRegularFileSync(checklistPath, MAX_RECEIPT_BYTES);
    const checklistText = checklistBytes.toString('utf8');
    assertNoDuplicateJsonKeys(checklistText);
    checklist = JSON.parse(checklistText);
  } catch (error) {
    errors.push('checklist unreadable: ' + error.message);
    return { valid: false, errors, checklistBytes, preparationBytes, evidenceBinding };
  }

  if (!isObject(checklist)) errors.push('checklist must be an object');
  if (errors.length > 0) return { valid: false, errors, checklistBytes, preparationBytes, evidenceBinding };

  assertExactKeys(checklist, [
    'schema_id', 'schema_version', 'fixture', 'reviewed_run', 'platform', 'host',
    'executed_at', 'executed_by', 'all_passed', 'items', 'artifact_binding',
    'owner_signature', 'notes'
  ], 'checklist', errors);
  if (checklist.schema_id !== CHECKLIST_SCHEMA_ID) errors.push('schema_id mismatch');
  if (checklist.schema_version !== CHECKLIST_SCHEMA_VERSION) errors.push('schema_version mismatch');
  if (checklist.fixture !== FIXTURE_ID) errors.push('fixture mismatch');
  if (checklist.platform !== platform || typeof platform !== 'string' || platform.length === 0) errors.push('platform mismatch');
  if (typeof checklist.reviewed_run !== 'string' || !/^\d{8}T\d{6}Z-\d+$/.test(checklist.reviewed_run)) errors.push('reviewed_run invalid');
  if (!isObject(checklist.host)) errors.push('host missing');
  if (isObject(checklist.host)) {
    assertExactKeys(checklist.host, ['application', 'version', 'vault'], 'host', errors);
    if (checklist.host.application !== 'Obsidian') errors.push('host.application must be Obsidian');
    if (typeof checklist.host.version !== 'string' || checklist.host.version.trim() === '') errors.push('host.version missing');
    if (typeof checklist.host.vault !== 'string' || !path.isAbsolute(checklist.host.vault)) errors.push('host.vault must be absolute');
  }
  if (typeof checklist.executed_at !== 'string' || !Number.isFinite(Date.parse(checklist.executed_at))) errors.push('executed_at invalid');
  if (typeof checklist.executed_by !== 'string' || checklist.executed_by.trim() === '') errors.push('executed_by missing');
  if (checklist.all_passed !== true) errors.push('all_passed must be true');
  if (!Array.isArray(checklist.items) || checklist.items.length !== 4) {
    errors.push('items must contain exactly four entries');
  } else {
    for (const item of checklist.items) assertExactKeys(item, ['id', 'passed', 'evidence'], 'item', errors);
    const ids = checklist.items.map(function (item) { return isObject(item) ? item.id : null; });
    if (new Set(ids).size !== 4 || ![1, 2, 3, 4].every(function (id) { return ids.includes(id); })) errors.push('items must have unique ids 1..4');
    if (!checklist.items.every(function (item) {
      return isObject(item) && item.passed === true && typeof item.evidence === 'string' && item.evidence.trim() !== '';
    })) errors.push('each checklist item must pass with evidence');
  }
  if (!isObject(checklist.artifact_binding)) errors.push('artifact_binding missing');
  const shaPattern = /^[0-9a-f]{64}$/;
  if (isObject(checklist.artifact_binding)) {
    assertExactKeys(checklist.artifact_binding, ['prepared_vault_sha256', 'saved_vault_sha256', 'review_path'], 'artifact_binding', errors);
    if (!shaPattern.test(checklist.artifact_binding.prepared_vault_sha256 || '')) errors.push('prepared_vault_sha256 invalid');
    if (!shaPattern.test(checklist.artifact_binding.saved_vault_sha256 || '')) errors.push('saved_vault_sha256 invalid');
    if (typeof checklist.artifact_binding.review_path !== 'string' || !path.isAbsolute(checklist.artifact_binding.review_path)) errors.push('review_path must be absolute');
  }
  if (!Object.prototype.hasOwnProperty.call(checklist, 'owner_signature')) errors.push('owner_signature field missing');
  else if (checklist.owner_signature !== null) errors.push('owner_signature must remain null in an execution receipt');
  if (errors.length > 0) return { valid: false, errors, checklistBytes, preparationBytes, evidenceBinding };

  const reviewedRun = checklist.reviewed_run;
  const vault = checklist.host.vault;
  const reviewPath = checklist.artifact_binding.review_path;
  const expectedReviewPath = path.join(vault, 'SuperWagie验收', FIXTURE_ID, reviewedRun, 'torture-edited.md');
  if (reviewPath !== expectedReviewPath) errors.push('review_path escapes the declared Vault/run identity');

  const preparationPath = path.join(repoRoot, 'evidence', 'gate-1', reviewedRun, 'artifacts', 'obsidian-review.json');
  const evidenceRoot = path.join(repoRoot, 'evidence', 'gate-1');
  const relativePreparation = path.relative(evidenceRoot, preparationPath);
  if (relativePreparation.startsWith('..' + path.sep) || path.isAbsolute(relativePreparation)) errors.push('reviewed_run escapes evidence root');

  try {
    assertContainedDirectoryChainSync(evidenceRoot, [reviewedRun, 'artifacts']);
    preparationBytes = readStableRegularFileSync(preparationPath, MAX_RECEIPT_BYTES);
    const preparationText = preparationBytes.toString('utf8');
    assertNoDuplicateJsonKeys(preparationText);
    preparation = JSON.parse(preparationText);
  } catch (error) {
    errors.push('preparation receipt unreadable: ' + error.message);
  }

  if (!isObject(preparation)) {
    errors.push('preparation receipt must be an object');
  } else {
    assertExactKeys(preparation, ['fixture', 'run_id', 'vault', 'review_path', 'sha256', 'source_sha256', 'dependency_files'], 'preparation receipt', errors);
    if (preparation.fixture !== FIXTURE_ID) errors.push('preparation fixture mismatch');
    if (preparation.run_id !== reviewedRun) errors.push('preparation run mismatch');
    if (preparation.vault !== vault) errors.push('preparation Vault mismatch');
    if (preparation.review_path !== reviewPath) errors.push('preparation review_path mismatch');
    if (preparation.sha256 !== checklist.artifact_binding.prepared_vault_sha256) errors.push('prepared SHA-256 mismatch');
    if (!shaPattern.test(preparation.source_sha256 || '')) errors.push('preparation source_sha256 invalid');
    if (!Array.isArray(preparation.dependency_files) || !preparation.dependency_files.every(function (dependency) {
      return typeof dependency === 'string' && path.isAbsolute(dependency);
    })) errors.push('preparation dependency_files invalid');
  }

  let reviewBytes = null;
  try {
    assertContainedDirectoryChainSync(vault, ['SuperWagie验收', FIXTURE_ID, reviewedRun]);
    reviewBytes = readStableRegularFileSync(reviewPath, MAX_REVIEW_BYTES);
  } catch (error) {
    errors.push('review file rejected: ' + error.message);
  }
  if (reviewBytes !== null && sha256(reviewBytes) !== checklist.artifact_binding.saved_vault_sha256) errors.push('saved SHA-256 mismatch');
  if (checklist.artifact_binding.prepared_vault_sha256 === checklist.artifact_binding.saved_vault_sha256) errors.push('saved review must differ from prepared review after the host edit');

  if (errors.length === 0) {
    evidenceBinding = {
      reviewed_run: reviewedRun,
      checklist_sha256: sha256(checklistBytes),
      prepared_vault_sha256: checklist.artifact_binding.prepared_vault_sha256,
      saved_vault_sha256: checklist.artifact_binding.saved_vault_sha256,
      review_path: reviewPath,
      host: {
        application: checklist.host.application,
        version: checklist.host.version,
        vault: checklist.host.vault
      },
      owner_signature_status: 'unsigned'
    };
  }
  return { valid: errors.length === 0, errors, checklistBytes, preparationBytes, evidenceBinding };
}

const startedAt = new Date().toISOString();
const checker = new Checker();
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-g1-md-'));

try {
  const originalBuf = fs.readFileSync(fixtureFile);
  const original = originalBuf.toString('utf8');

  // ---------- 1. byte roundtrip through the write path ----------
  const rtPath = path.join(tmpBase, 'roundtrip.md');
  fs.writeFileSync(rtPath, originalBuf);
  const rtBuf = fs.readFileSync(rtPath);
  checker.check('md:roundtrip-byte-identical', sha256(rtBuf) === sha256(originalBuf), '写入后再读取 sha256 一致（无编辑往返字节一致）');

  // ---------- helpers ----------
  function lineStartOffsets(text) {
    const offs = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') offs.push(i + 1);
    }
    return offs;
  }

  function fencedSpan(text, lang) {
    const open = FENCE + lang;
    const lines = text.split('\n');
    const offs = lineStartOffsets(text);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith(open)) continue;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith(FENCE)) {
          return text.slice(offs[i], offs[j] + lines[j].length);
        }
      }
    }
    return null;
  }

  const REGION_KEYS = ['frontmatter', 'fenced:dataview', 'fenced:unknown-plugin', 'fenced:mermaid', 'math-block', 'html-comment', 'raw-html'];

  function extractRegions(text) {
    const regions = { frontmatter: null };
    if (text.startsWith('---\n')) {
      const end = text.indexOf('\n---\n', 4);
      if (end >= 0) regions.frontmatter = text.slice(0, end + 5);
    }
    regions['fenced:dataview'] = fencedSpan(text, 'dataview');
    regions['fenced:unknown-plugin'] = fencedSpan(text, 'unknown-plugin');
    regions['fenced:mermaid'] = fencedSpan(text, 'mermaid');
    const lines = text.split('\n');
    const offs = lineStartOffsets(text);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== '$$') continue;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] === '$$') { regions['math-block'] = text.slice(offs[i], offs[j] + 2); break; }
      }
      if (regions['math-block']) break;
    }
    const cStart = text.indexOf('<!--');
    if (cStart >= 0) {
      const cEnd = text.indexOf('-->', cStart);
      if (cEnd >= 0) regions['html-comment'] = text.slice(cStart, cEnd + 3);
    }
    const dStart = text.indexOf('<div class="raw-html-keep">');
    if (dStart >= 0) {
      const dEnd = text.indexOf('</div>', dStart);
      if (dEnd >= 0) regions['raw-html'] = text.slice(dStart, dEnd + 6);
    }
    return regions;
  }

  function countOccurrences(haystack, needle) {
    if (needle === null) return 0;
    let n = 0;
    let i = 0;
    while ((i = haystack.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
    return n;
  }

  // ---------- 2. protected regions located ----------
  const baseRegions = extractRegions(original);
  const missing = REGION_KEYS.filter(k => !baseRegions[k]);
  checker.check('md:protected-regions-defined', missing.length === 0, missing.length === 0 ? '7 个保护区域全部定位（frontmatter/dataview/unknown-plugin/mermaid/块公式/HTML 注释/原生 HTML）' : '缺失: ' + missing.join(','));
  checker.check('md:frontmatter-custom-field', baseRegions.frontmatter !== null && baseRegions.frontmatter.indexOf('custom_plugin_field: keep-me') >= 0, '自定义字段位于 frontmatter 保护区内');

  // ---------- 3. three semantic edits, protected regions byte-stable ----------
  let edited = original;
  const e1From = '结束段落，用于追加编辑锚点。';
  const e1To = '结束段落，用于追加编辑锚点。（PoC 语义编辑一）';
  const e2From = '- [ ] 未完成任务 一 📅 2026-09-05 ^task-t1';
  const e2To = '- [x] 未完成任务 一 📅 2026-09-05 ^task-t1';
  if (edited.indexOf(e1From) >= 0) edited = edited.replace(e1From, e1To);
  if (edited.indexOf(e2From) >= 0) edited = edited.replace(e2From, e2To);
  edited = edited + '\n新增段落：PoC 语义编辑三。\n';
  const editsApplied = edited.indexOf('（PoC 语义编辑一）') >= 0 && edited.indexOf('- [x] 未完成任务 一') >= 0 && edited.indexOf('新增段落：PoC 语义编辑三。') >= 0;
  checker.check('md:semantic-edits-applied', editsApplied, '三处语义编辑生效（普通段落/任务勾选/文件尾追加）');

  const editedRegions = extractRegions(edited);
  const broken = [];
  const preserved = [];
  for (const k of REGION_KEYS) {
    const before = baseRegions[k];
    const after = editedRegions[k];
    if (before === null || after === null) { broken.push(k + ':missing'); continue; }
    if (before !== after) { broken.push(k + ':changed'); continue; }
    if (countOccurrences(original, before) !== countOccurrences(edited, before)) { broken.push(k + ':count'); continue; }
    preserved.push(k);
  }
  checker.check('md:protected-after-edits', broken.length === 0, broken.length === 0 ? preserved.length + '/7 个保护区域编辑后逐字节不变' : broken.join(', '));

  // ---------- 4. excalidraw.md container: shell byte-stable ----------
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

  function surgicalJsonEdit(text, elementId, fromStr, toStr) {
    const span = elementSpan(text, elementId);
    if (!span) return null;
    const elem = text.slice(span.start, span.end);
    if (elem.indexOf(fromStr) < 0) return null;
    return text.slice(0, span.start) + elem.replace(fromStr, toStr) + text.slice(span.end);
  }

  const sceneRaw = fs.readFileSync(path.join(repoRoot, 'fixtures', 'gate-1', 'G1-DIAGRAM-001', 'fixtures', 'sample.excalidraw'), 'utf8');
  const containerBefore = '# 系统架构\n\n![[系统架构.excalidraw]]\n\n<!-- Excalidraw 场景数据，壳必须逐字节稳定 -->\n\n' + FENCE + 'json\n' + sceneRaw + FENCE + '\n';
  const scenePos = containerBefore.indexOf(sceneRaw);
  const cPrefix = containerBefore.slice(0, scenePos);
  const cSuffix = containerBefore.slice(scenePos + sceneRaw.length);
  const containerEdited = surgicalJsonEdit(containerBefore, 'text-1', '"text": "核心模块"', '"text": "核心模块 V2"');
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
  checker.check('md:excalidraw-container-shell-stable', contOk, contOk ? '容器壳字节不变，场景 JSON 更新且可解析' : 'surgical edit 失败');

  // ---------- 5. stale revision rejected, block-id re-anchor ----------
  const conflictPath = path.join(tmpBase, 'conflict.md');
  let conflictText = '- [ ] 外部可见任务（供冲突场景使用） ^task-conflict\n';
  fs.writeFileSync(conflictPath, conflictText);
  let currentRevision = 1;
  conflictText = conflictText.replace('（供冲突场景使用）', '（外部已修改标题）');
  fs.writeFileSync(conflictPath, conflictText);
  currentRevision = 2;
  const staleRejected = 1 !== currentRevision;
  checker.check('md:stale-revision-rejected', staleRejected, '过期 revision 1 提交被拒（当前 revision 2）');

  const cLines = conflictText.split('\n');
  const cIdx = cLines.findIndex(l => l.indexOf('^task-conflict') >= 0);
  let reanchorOK = false;
  let externalPreserved = false;
  if (cIdx >= 0 && cLines[cIdx].indexOf('- [ ]') === 0) {
    cLines[cIdx] = cLines[cIdx].replace('- [ ]', '- [x]');
    conflictText = cLines.join('\n');
    fs.writeFileSync(conflictPath, conflictText);
    currentRevision += 1;
    reanchorOK = conflictText.indexOf('^task-conflict') >= 0 && conflictText.indexOf('- [x] 外部可见任务') >= 0;
    externalPreserved = conflictText.indexOf('（外部已修改标题）') >= 0;
  }
  checker.check('md:block-id-reanchor-success', reanchorOK, '按 ^task-conflict 块 ID 重定位后提交成功');
  checker.check('md:external-edit-preserved', externalPreserved, '外部标题修改在重定位提交后保留');

  // ---------- 6. index counts ----------
  const wikilinkRe = /\[\[([^\]]+)\]\]/g;
  const nonEmbed = new Set();
  let embedCount = 0;
  let m2 = wikilinkRe.exec(edited);
  while (m2 !== null) {
    const prev = m2.index > 0 ? edited[m2.index - 1] : '';
    if (prev === '!') embedCount++;
    else nonEmbed.add(m2[1]);
    m2 = wikilinkRe.exec(edited);
  }
  const taskLines = edited.split('\n').filter(l => /^- \[[ x]\] /.test(l));
  const stripped = edited.replace(/\[\[[^\]]+\]\]/g, '');
  // Obsidian 块 ID 定义必须位于行尾；脚注 [^1] 与行内公式 mc^2 均不满足
  const blockIds = new Set();
  for (const line of stripped.split('\n')) {
    const m3 = line.match(/\^([A-Za-z0-9-]+)\s*$/);
    if (m3) blockIds.add(m3[1]);
  }
  const headings = edited.split('\n').filter(l => /^#{1,6} /.test(l)).length;
  const countsOK = nonEmbed.size === 4 && embedCount === 3 && taskLines.length === 4 && blockIds.size === 4 && headings === 7;
  checker.check('md:index-counts', countsOK, '非嵌入 wikilink=' + nonEmbed.size + '/4, embed=' + embedCount + '/3, task=' + taskLines.length + '/4, blockId=' + blockIds.size + '/4, heading=' + headings + '/7');

  // ---------- 7. checklist result (R-QS-02) ----------
  let decisionHint = 'CONDITIONAL_GO';
  let limitation = 'Obsidian 真宿主人工验收（R-QS-02）待完成：按 fixtures/gate-1/G1-MARKDOWN-001/fixtures/checklist.md 四步执行后，以 --checklist-result 复跑翻正为 GO';
  let checklistValid = false;
  let checklistBinding = null;
  if (checklistResultPath) {
    checklistBinding = validateChecklistBinding(checklistResultPath);
    checklistValid = checklistBinding.valid;
    if (checklistValid) {
      decisionHint = 'GO';
      limitation = null;
    } else {
      decisionHint = 'NO_GO';
      limitation = '已提供的 Obsidian 真宿主清单未通过强绑定校验：' + checklistBinding.errors.join('; ');
    }
  }
  checker.check('md:checklist-result', checklistResultPath ? checklistValid : true, checklistResultPath ? (checklistValid ? '人工验收清单与 preparation run、Vault 文件和前后 SHA-256 强绑定，执行 decision=GO（Owner 未签署）' : limitation) : '未提供 checklist-result，按 R-QS-02 维持 CONDITIONAL_GO');

  // ---------- artifacts ----------
  if (artifactsDir) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, 'torture-edited.md'), edited);
    fs.writeFileSync(path.join(artifactsDir, 'conflict-resolved.md'), conflictText);
    fs.writeFileSync(path.join(artifactsDir, 'container-edited.excalidraw.md'), containerEdited || '');
    fs.copyFileSync(fixturePng, path.join(artifactsDir, '图片素材.png'));
    fs.copyFileSync(fixtureDrawing, path.join(artifactsDir, '系统架构.excalidraw.md'));
    if (checklistValid && checklistBinding) {
      fs.writeFileSync(path.join(artifactsDir, 'checklist-result.json'), checklistBinding.checklistBytes);
      fs.writeFileSync(path.join(artifactsDir, 'reviewed-obsidian-review.json'), checklistBinding.preparationBytes);
    }
  }
  if (obsidianVault) {
    const runId = path.basename(path.dirname(resultsPath));
    const reviewRoot = path.join(obsidianVault, 'SuperWagie验收', FIXTURE_ID);
    const reviewDir = path.join(reviewRoot, runId);
    const reviewPath = path.join(reviewDir, 'torture-edited.md');
    const scopedLinkedPage = 'SuperWagie验收/' + FIXTURE_ID + '/' + runId + '/核心内容';
    const reviewEdited = edited
      .replaceAll('![[核心内容#小节]]', '![[' + scopedLinkedPage + '#小节]]')
      .replaceAll('[[核心内容|显示名]]', '[[' + scopedLinkedPage + '|显示名]]')
      .replaceAll('[[核心内容#小节]]', '[[' + scopedLinkedPage + '#小节|核心内容#小节]]')
      .replaceAll('[[核心内容#^block-anchor]]', '[[' + scopedLinkedPage + '#^block-anchor|核心内容#^block-anchor]]')
      .replaceAll('[[核心内容]]', '[[' + scopedLinkedPage + '|核心内容]]');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(reviewPath, reviewEdited);
    const linkedPage = [
      '# 核心内容',
      '',
      '这是 WikiLink、标题锚点、块引用与文档嵌入的配套验收页面。',
      '',
      '## 小节',
      '',
      '如果这段内容能嵌入主文档，说明标题锚点解析正常。',
      '',
      '这是块引用的目标段落。 ^block-anchor',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(reviewDir, '核心内容.md'), linkedPage);
    fs.copyFileSync(fixturePng, path.join(reviewDir, '图片素材.png'));
    fs.copyFileSync(fixtureDrawing, path.join(reviewDir, '系统架构.excalidraw.md'));
    const wikiTarget = 'SuperWagie验收/' + FIXTURE_ID + '/' + runId + '/torture-edited';
    const pointer = [
      '# SuperWagie Markdown 当前验收',
      '',
      '- Fixture：' + FIXTURE_ID,
      '- Run：' + runId,
      '- 打开：[[' + wikiTarget + ']]',
      '',
      '按 SuperWagie 仓库内 fixtures/gate-1/G1-MARKDOWN-001/fixtures/checklist.md 完成四项人工验收。',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(reviewRoot, '当前验收.md'), pointer);
    if (artifactsDir) {
      fs.writeFileSync(path.join(artifactsDir, 'obsidian-review.json'), JSON.stringify({
        fixture: FIXTURE_ID,
        run_id: runId,
        vault: obsidianVault,
        review_path: reviewPath,
        sha256: sha256(Buffer.from(reviewEdited, 'utf8')),
        source_sha256: sha256(Buffer.from(edited, 'utf8')),
        dependency_files: [
          path.join(reviewDir, '核心内容.md'),
          path.join(reviewDir, '图片素材.png'),
          path.join(reviewDir, '系统架构.excalidraw.md')
        ]
      }, null, 2) + '\n');
    }
  }

  const pass = writeResults(resultsPath, {
    gate: 'gate-1',
    fixture: FIXTURE_ID,
    startedAt: startedAt,
    checker: checker,
    decisionHint: decisionHint,
    limitation: limitation,
    evidenceBinding: checklistValid && checklistBinding ? checklistBinding.evidenceBinding : null
  });
  console.log('G1-MARKDOWN-001: ' + checker.summary.passed + '/' + checker.summary.total + ' checks passed, decision_hint=' + decisionHint);
  rmrf(tmpBase);
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error('ERROR executor: ' + (e && e.stack ? e.stack : String(e)));
  rmrf(tmpBase);
  process.exit(2);
}
