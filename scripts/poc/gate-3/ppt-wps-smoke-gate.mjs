#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const FIXTURE_ID = 'G3-PPT-WPS-MACOS-SMOKE-001';
const SOURCE_SHA256 = '853f89c05733671a6351bcbb7f1df2d0a7e55bec9c84ed56c4e78417ca3aa9e3';
const REQUIRED_ASSERTIONS = [
  'opened_without_document_repair_dialog',
  'slide_count_3',
  'slide_order_preserved',
  'aspect_ratio_16_9',
  'slide_1_visible',
  'slide_2_visible',
  'slide_3_visible',
  'visual_quality_accepted_at_displayed_zoom',
  'native_title_editable',
  'undo_restored_title_edit',
  'saved_reopen_title_saved',
  'discard_reopen_title_edit',
  'discard_hash_unchanged',
  'source_hash_unchanged',
];
const REQUIRED_EVIDENCE = [
  'source.pptx',
  'save-copy.pptx',
  'discard-copy.pptx',
  'wps-identity.txt',
  'opened-slide-1.jpeg',
  'editable-title.jpeg',
  'undo-restored.jpeg',
  'saved-reopen.jpeg',
  'discard-prompt.jpeg',
  'discard-reopen.jpeg',
  'opened-slide-3.jpeg',
];

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeResult(path, document) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

function result(decision, reasons, limitations = [], metrics = {}) {
  return {
    schema_id: 'superwagie.g3-ppt-wps-macos-smoke-result.v1',
    schema_version: 1,
    gate: 'gate-3-subprobe',
    parent_gate: 'gate-3',
    admission_effect: 'none',
    fixture: FIXTURE_ID,
    parent_fixture: 'G3-PPT-001',
    pass: decision === 'GO' || decision === 'CONDITIONAL_GO',
    status: decision === 'BLOCKED_ENVIRONMENT' ? 'blocked' : decision === 'NO_GO' ? 'failed' : 'passed',
    decision_hint: decision,
    reasons,
    limitations,
    metrics,
  };
}

function regularFile(path, label) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    const current = statSync(path);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error(`${label} changed during validation`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function containedEvidencePath(root, requested, label) {
  if (typeof requested !== 'string' || !requested || isAbsolute(requested)
    || requested.split(/[\\/]/).includes('..')) throw new Error(`${label} path must be relative and contained`);
  const path = resolve(root, requested);
  const rel = relative(root, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error(`${label} path escapes evaluation directory`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const real = realpathSync(path);
  const realRel = relative(realpathSync(root), real);
  if (!realRel || realRel.startsWith(`..${sep}`) || realRel === '..' || isAbsolute(realRel)) {
    throw new Error(`${label} resolves outside evaluation directory`);
  }
  return path;
}

function slideXml(path, slide = 2) {
  return execFileSync('/usr/bin/unzip', ['-p', path, `ppt/slides/slide${slide}.xml`], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

function presentationXml(path) {
  return execFileSync('/usr/bin/unzip', ['-p', path, 'ppt/presentation.xml'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

function pptxEntries(path) {
  execFileSync('/usr/bin/unzip', ['-tqq', path], { stdio: ['ignore', 'ignore', 'pipe'] });
  return execFileSync('/usr/bin/unzip', ['-Z1', path], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
}

function assertSlideOrder(path) {
  const entries = pptxEntries(path);
  const slides = entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry)).sort();
  if (slides.length !== 3 || slides.join('|') !== 'ppt/slides/slide1.xml|ppt/slides/slide2.xml|ppt/slides/slide3.xml') {
    throw new Error(`${basename(path)} must contain exactly slide1.xml through slide3.xml`);
  }
  const presentation = presentationXml(path);
  const slideList = presentation.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/)?.[1] ?? '';
  const relationshipIds = [...slideList.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*\/>/g)].map((match) => match[1]);
  if (relationshipIds.length !== 3) throw new Error(`${basename(path)} must declare exactly three slide relationships`);
  const rels = execFileSync('/usr/bin/unzip', ['-p', path, 'ppt/_rels/presentation.xml.rels'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const targets = new Map([...rels.matchAll(/<Relationship\b([^>]*)\/>/g)].map((match) => {
    const id = match[1].match(/\bId="([^"]+)"/)?.[1];
    const type = match[1].match(/\bType="([^"]+)"/)?.[1];
    const target = match[1].match(/\bTarget="([^"]+)"/)?.[1];
    return type?.endsWith('/slide') ? [id, target] : [undefined, undefined];
  }).filter(([id]) => id));
  const orderedTargets = relationshipIds.map((id) => targets.get(id));
  if (orderedTargets.join('|') !== 'slides/slide1.xml|slides/slide2.xml|slides/slide3.xml') {
    throw new Error(`${basename(path)} slide relationship order is invalid`);
  }
}

function assertPptxContent(source, saved, discard) {
  const sourceTitle = slideXml(source);
  const savedTitle = slideXml(saved);
  const discardTitle = slideXml(discard);
  if (!/<a:t(?:\s[^>]*)?>TITLE EDIT<\/a:t>/.test(sourceTitle) || sourceTitle.includes('TITLE SAVED')) throw new Error('source title is not TITLE EDIT');
  if (!/<a:t(?:\s[^>]*)?>TITLE SAVED<\/a:t>/.test(savedTitle) || savedTitle.includes('TITLE EDIT')) throw new Error('saved copy did not persist TITLE SAVED');
  if (!/<a:t(?:\s[^>]*)?>TITLE EDIT<\/a:t>/.test(discardTitle) || discardTitle.includes('TITLE DISCARD')) throw new Error('discard copy did not restore TITLE EDIT');
  for (const file of [source, saved, discard]) {
    assertSlideOrder(file);
    const xml = presentationXml(file);
    const size = xml.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
    if (!size || Math.abs(Number(size[1]) / Number(size[2]) - 16 / 9) > 0.001) {
      throw new Error(`${basename(file)} is not 16:9`);
    }
  }
}

function assertScreenshot(path, bytes, label) {
  const jpeg = bytes.length >= 32 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  const png = bytes.length >= 32 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!jpeg && !png) throw new Error(`${label} is not a non-empty JPEG or PNG`);
  const properties = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { encoding: 'utf8' });
  const width = Number(properties.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(properties.match(/pixelHeight:\s*(\d+)/)?.[1]);
  const dialogCrop = label === 'discard-prompt.jpeg';
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || (dialogCrop && (width < 400 || height < 140)) || (!dialogCrop && (width < 1000 || height < 600))) {
    throw new Error(`${label} is not a decodable ${dialogCrop ? 'dialog' : 'full-window'} screenshot`);
  }
}

function plistValue(appPath, key) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', resolve(appPath, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
}

function probeWpsHost(expected) {
  const appPath = '/Applications/wpsoffice.app';
  const executablePath = '/Applications/wpsoffice.app/Contents/MacOS/wpsoffice';
  if (expected.app_path !== appPath || expected.executable_path !== executablePath
    || realpathSync(appPath) !== appPath || realpathSync(executablePath) !== executablePath) {
    throw new Error('WPS canonical app or executable path is invalid');
  }
  const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
  if (signature.status !== 0) throw new Error('WPS signature metadata probe failed');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  const signatureText = `${signature.stdout ?? ''}\n${signature.stderr ?? ''}`;
  const pids = execFileSync('/usr/bin/pgrep', ['-x', 'wpsoffice'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  if (pids.length < 1) throw new Error('WPS feature probe requires a running wpsoffice process');
  const processCommand = execFileSync('/bin/ps', ['-p', pids[0], '-o', 'command='], { encoding: 'utf8' }).trim();
  const probe = {
    app_path: appPath,
    executable_path: executablePath,
    bundle_id: plistValue(appPath, 'CFBundleIdentifier'),
    version: plistValue(appPath, 'CFBundleShortVersionString'),
    build: plistValue(appPath, 'CFBundleVersion'),
    executable_name: plistValue(appPath, 'CFBundleExecutable'),
    team_identifier: signatureText.match(/TeamIdentifier=([^\s]+)/)?.[1] ?? '',
    signature_identifier: signatureText.match(/Identifier=([^\s]+)/)?.[1] ?? '',
    executable_sha256: sha256(regularFile(executablePath, 'WPS executable')),
    codesign_valid: true,
    running_pid: Number(pids[0]),
    running_command_matches: processCommand === executablePath,
  };
  for (const field of ['app_path', 'executable_path', 'bundle_id', 'version', 'build', 'team_identifier', 'executable_sha256']) {
    if (probe[field] !== expected[field]) throw new Error(`live WPS identity mismatch: ${field}`);
  }
  if (probe.executable_name !== 'wpsoffice' || probe.signature_identifier !== expected.bundle_id
    || !probe.running_command_matches) throw new Error('live WPS feature probe failed');
  return probe;
}

const fixture = arg('--fixture');
const platform = arg('--platform');
const resultsPath = arg('--results-json');
const artifactsDir = arg('--artifacts-dir');
const evaluationPath = arg('--evaluation-result');

if (fixture !== FIXTURE_ID || platform !== 'macos-15-arm64' || !isAbsolute(resultsPath)
  || !isAbsolute(artifactsDir) || !isAbsolute(evaluationPath)) {
  console.error(`usage: ppt-wps-smoke-gate.mjs --fixture ${FIXTURE_ID} --platform macos-15-arm64 --results-json ABS --artifacts-dir ABS --evaluation-result ABS`);
  process.exit(2);
}

let failureReason = 'WPS_SMOKE_EVIDENCE_INVALID';
try {
  const evaluationBytes = regularFile(evaluationPath, 'evaluation result');
  const evaluation = JSON.parse(evaluationBytes.toString('utf8'));
  const root = dirname(evaluationPath);
  if (evaluation.schema_id !== 'superwagie.g3-ppt-wps-macos-smoke-evaluation.v1'
    || evaluation.schema_version !== 1 || evaluation.gate !== 'gate-3-subprobe'
    || evaluation.fixture !== FIXTURE_ID || evaluation.platform !== platform
    || typeof evaluation.operator_role !== 'string' || !evaluation.operator_role
    || !Number.isFinite(Date.parse(evaluation.executed_at))) throw new Error('evaluation identity is invalid');
  if (evaluation.source_sha256 !== SOURCE_SHA256) throw new Error('canonical source hash is invalid');
  if (evaluation.zoom?.requested_percent !== 100 || evaluation.zoom?.displayed_percent !== 101
    || evaluation.zoom?.device_scale_adjusted !== true) throw new Error('WPS zoom evidence is incomplete');
  if (evaluation.wps?.bundle_id !== 'com.kingsoft.wpsoffice.mac'
    || !/^\d+(?:\.\d+){2,}$/.test(evaluation.wps?.version ?? '')
    || !/^\d+$/.test(evaluation.wps?.build ?? '')
    || !/^[A-Z0-9]{10}$/.test(evaluation.wps?.team_identifier ?? '')
    || evaluation.wps?.app_path !== '/Applications/wpsoffice.app'
    || evaluation.wps?.executable_path !== '/Applications/wpsoffice.app/Contents/MacOS/wpsoffice'
    || !/^[a-f0-9]{64}$/.test(evaluation.wps?.executable_sha256 ?? '')) throw new Error('WPS identity is incomplete');
  for (const name of REQUIRED_ASSERTIONS) {
    if (evaluation.assertions?.[name] !== true) throw new Error(`required assertion is not true: ${name}`);
  }
  if (!Array.isArray(evaluation.evidence)) throw new Error('evidence list is missing');

  const byName = new Map();
  for (const entry of evaluation.evidence) {
    const name = basename(entry?.path ?? '');
    if (!name || byName.has(name)) throw new Error(`duplicate or empty evidence name: ${name}`);
    const path = containedEvidencePath(root, entry.path, name);
    const bytes = regularFile(path, name);
    if (entry.sha256 !== sha256(bytes)) throw new Error(`evidence hash mismatch: ${name}`);
    byName.set(name, { path, bytes, sha256: entry.sha256 });
  }
  for (const name of REQUIRED_EVIDENCE) {
    if (!byName.has(name)) throw new Error(`required evidence is missing: ${name}`);
  }
  for (const name of REQUIRED_EVIDENCE.filter((name) => /\.(?:jpe?g|png)$/i.test(name))) {
    assertScreenshot(byName.get(name).path, byName.get(name).bytes, name);
  }
  if (byName.get('source.pptx').sha256 !== SOURCE_SHA256
    || byName.get('discard-copy.pptx').sha256 !== SOURCE_SHA256) throw new Error('source or discard copy hash changed');
  const identityText = byName.get('wps-identity.txt').bytes.toString('utf8');
  for (const expected of [
    `bundle_id=${evaluation.wps.bundle_id}`,
    `version=${evaluation.wps.version}`,
    `build=${evaluation.wps.build}`,
    `team_identifier=${evaluation.wps.team_identifier}`,
    `app_path=${evaluation.wps.app_path}`,
    `executable_path=${evaluation.wps.executable_path}`,
    `executable_sha256=${evaluation.wps.executable_sha256}`,
    'codesign_valid=true',
  ]) {
    if (!identityText.split(/\r?\n/).includes(expected)) throw new Error(`WPS identity evidence is missing ${expected}`);
  }
  const liveWpsProbe = probeWpsHost(evaluation.wps);

  failureReason = 'WPS_SMOKE_CONTENT_INVALID';
  assertPptxContent(
    byName.get('source.pptx').path,
    byName.get('save-copy.pptx').path,
    byName.get('discard-copy.pptx').path,
  );

  mkdirSync(artifactsDir, { recursive: true });
  const screenshotsDir = resolve(artifactsDir, '..', 'screenshots');
  mkdirSync(screenshotsDir, { recursive: true });
  for (const name of REQUIRED_EVIDENCE) {
    const targetDir = /\.(?:jpe?g|png)$/i.test(name) ? screenshotsDir : artifactsDir;
    copyFileSync(byName.get(name).path, resolve(targetDir, name));
  }
  writeFileSync(resolve(artifactsDir, 'evaluation.json'), evaluationBytes, { mode: 0o600 });
  writeFileSync(resolve(artifactsDir, 'live-wps-host-probe.json'), `${JSON.stringify(liveWpsProbe, null, 2)}\n`, { mode: 0o600 });
  const receipt = {
    ...evaluation,
    evaluation_sha256: sha256(evaluationBytes),
    evidence: REQUIRED_EVIDENCE.map((name) => ({ name, sha256: byName.get(name).sha256 })),
  };
  writeFileSync(resolve(artifactsDir, 'evaluation-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  writeResult(resultsPath, result('CONDITIONAL_GO', ['REAL_WPS_MACOS_HOST_AND_EVIDENCE_VALIDATED', 'OWNER_SIGNATURE_REQUIRED_FOR_GO'], [
    'Manual UI assertions and screenshot semantics remain owner-signature evidence; an unsigned evaluation cannot produce GO.',
    'This is a macOS WPS subprobe only; it does not upgrade G3-PPT-001 or Production Implementation Admission.',
    'Windows WPS/PowerPoint, signed runtime, actual SuperPPT integration, seven stages, Human Gates, and local invalidation remain unproven.',
    'WPS is an External Host and is not part of the Signed Runtime Image.',
  ], {
    parent_fixture_upgraded: false,
    source_sha256: SOURCE_SHA256,
    saved_copy_sha256: byName.get('save-copy.pptx').sha256,
    discard_copy_sha256: byName.get('discard-copy.pptx').sha256,
    wps: evaluation.wps,
    live_wps_probe: liveWpsProbe,
    evidence_files: REQUIRED_EVIDENCE.length,
    owner_signature_status: 'unsigned',
  }));
  console.log('CONDITIONAL_GO: live WPS identity and evidence integrity passed; owner signature is still required');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeResult(resultsPath, result('NO_GO', [failureReason], [message], { parent_fixture_upgraded: false }));
  console.error(message);
  process.exit(1);
}
