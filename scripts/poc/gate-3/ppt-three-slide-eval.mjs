#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIXTURE_ID = 'G3-PPT-SUPERPPT-THREE-SLIDE-SPIKE-001';
const REQUIRED_SUPERPPT_ROOT = '/Users/neomei/项目/codexprojects/SuperPPT';
const REQUIRED_SUPERPPT_COMMIT = '2f71bbea5446c115decc29bdaffab859eeb44e72';
const SUPERWAGIE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REQUIRED_FIXTURE_PATH = join(SUPERWAGIE_ROOT, 'fixtures/gate-3/G3-PPT-001/fixtures/presentation-visual-1920x1080.png');
const REQUIRED_FIXTURE_SHA256 = '20d8e23f49f6d7fdb56491f694472d8898c22dec84ef399c51089a673989196f';
const SOURCE_FILES = ['src/deck/pptx.ts', 'src/deck/presentation-service.ts', 'scripts/test.ts'];
const FORBIDDEN_SOURCE_MARKERS = [
  '@oai/artifact-tool',
  'codex-primary-runtime',
  'codex-runtimes',
  'RUNTIME_NODE',
  'RUNTIME_NODE_MODULES',
  'RUNTIME_BIN_DIR',
];
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const LIMITATIONS = [
  'This child spike does not prove the SuperPPT seven-stage Guided UI workflow.',
  'The outline, slide-plan, and representative-sample human gates remain unverified here.',
  'The assembler and its Node dependency closure still require a read-only Signed Runtime Image.',
  'Windows 11 x64 WPS/PowerPoint generation and reopen acceptance remain unverified.',
  'WPS/PowerPoint Owner sign-off for visual fidelity, edit, undo, save/discard, and reopen remains required.',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function regularFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return readFile(path);
}

async function canonicalDirectory(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const resolved = resolve(path);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
  if (await realpath(resolved) !== resolved) {
    throw new Error(`${label} must be canonical and non-symlink`);
  }
  return resolved;
}

function runGit(root, args, label) {
  const completed = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (completed.status !== 0) {
    throw new Error(`${label}: ${(completed.stderr || completed.stdout).trim()}`);
  }
  return completed.stdout;
}

export async function inspectGitRevision(candidateRoot, expectedCommit) {
  const root = await canonicalDirectory(candidateRoot, 'SuperPPT root');
  const observedCommit = runGit(root, ['rev-parse', 'HEAD'], 'cannot identify SuperPPT commit').trim();
  if (!/^[a-f0-9]{40}$/.test(observedCommit) || observedCommit !== expectedCommit) {
    throw new Error(`SuperPPT HEAD must equal required commit ${expectedCommit}; received ${observedCommit}`);
  }
  const trackedStatus = runGit(
    root,
    ['status', '--porcelain=v1', '--untracked-files=no'],
    'cannot inspect SuperPPT tracked worktree',
  );
  if (trackedStatus.trim() !== '') {
    throw new Error(`SuperPPT tracked worktree must be clean; dirty entries: ${trackedStatus.trim()}`);
  }
  return {
    canonical_root: root,
    required_commit: expectedCommit,
    observed_commit: observedCommit,
    tracked_worktree_clean: true,
  };
}

export async function bindRequiredSuperPpt(candidateRoot) {
  const root = await canonicalDirectory(candidateRoot, 'SuperPPT root');
  if (root !== REQUIRED_SUPERPPT_ROOT) {
    throw new Error(`candidate must be the required SuperPPT worktree ${REQUIRED_SUPERPPT_ROOT}`);
  }
  return inspectGitRevision(root, REQUIRED_SUPERPPT_COMMIT);
}

export async function auditCandidateSources(candidateRoot) {
  const root = await canonicalDirectory(candidateRoot, 'SuperPPT root');
  const sources = {};
  const findings = [];
  for (const relative of SOURCE_FILES) {
    const bytes = await regularFile(join(root, relative), relative);
    const text = bytes.toString('utf8');
    const forbidden = FORBIDDEN_SOURCE_MARKERS.filter((marker) => text.includes(marker));
    sources[relative] = { bytes: bytes.length, sha256: sha256(bytes), forbidden_markers: forbidden };
    findings.push(...forbidden.map((marker) => `${relative}:${marker}`));
  }
  if (findings.length > 0) {
    throw new Error(`Codex package/runtime coupling remains: ${findings.join(', ')}`);
  }
  const assembler = await regularFile(join(root, 'src/deck/assemble.ts'), 'src/deck/assemble.ts');
  if (!/export\s+async\s+function\s+assembleDeck\s*\(/.test(assembler.toString('utf8'))) {
    throw new Error('SuperPPT assembleDeck export is missing');
  }
  return {
    schema_id: 'superwagie.g3-ppt-source-audit.v2',
    schema_version: 2,
    fixture: FIXTURE_ID,
    forbidden_markers: FORBIDDEN_SOURCE_MARKERS,
    forbidden_marker_set_sha256: sha256(Buffer.from(JSON.stringify(FORBIDDEN_SOURCE_MARKERS))),
    assembler: {
      entrypoint: 'src/deck/assemble.ts#assembleDeck',
      sha256: sha256(assembler),
      bytes: assembler.length,
    },
    sources,
    findings: {
      direct_oai_artifact_tool_import: false,
      codex_primary_runtime_reference: false,
    },
  };
}

export async function assertSafeOutputDirectory(outputDirectory) {
  return canonicalDirectory(outputDirectory, 'PPTX output parent');
}

async function prepareOutputDirectory(outputDirectory) {
  if (!isAbsolute(outputDirectory)) throw new Error('evidence directory must be absolute');
  const requested = resolve(outputDirectory);
  try {
    return await assertSafeOutputDirectory(requested);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await canonicalDirectory(dirname(requested), 'evidence directory parent');
  await mkdir(requested, { mode: 0o700 });
  return assertSafeOutputDirectory(requested);
}

function inspectPngBytes(bytes, label) {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)
    || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`${label} must be a PNG with a valid IHDR`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== 1920 || height !== 1080) {
    throw new Error(`${label} must be exactly 1920x1080; received ${width}x${height}`);
  }
  return { width, height, bytes: bytes.length, sha256: sha256(bytes) };
}

export async function inspectFullSlidePng(path) {
  return inspectPngBytes(await regularFile(path, 'full-slide raster'), 'full-slide raster');
}

export async function inspectFixtureBinding(fixturePath, expectedPath, expectedSha256) {
  if (!isAbsolute(fixturePath) || !isAbsolute(expectedPath)) {
    throw new Error('fixture path and required canonical path must be absolute');
  }
  const requested = resolve(fixturePath);
  const required = resolve(expectedPath);
  const canonical = await realpath(requested);
  if (requested !== required || canonical !== required) {
    throw new Error(`fixture must use required canonical path ${required}`);
  }
  const raster = await inspectFullSlidePng(canonical);
  if (raster.sha256 !== expectedSha256) {
    throw new Error(`fixture must match required SHA-256 ${expectedSha256}; received ${raster.sha256}`);
  }
  return {
    canonical_path: canonical,
    required_sha256: expectedSha256,
    sha256: raster.sha256,
    width: raster.width,
    height: raster.height,
    bytes: raster.bytes,
  };
}

async function loadCandidateJsZip(candidateRoot) {
  const jszipPath = join(candidateRoot, 'node_modules/jszip/lib/index.js');
  await regularFile(jszipPath, 'SuperPPT JSZip entrypoint');
  const loaded = await import(pathToFileURL(jszipPath).href);
  return loaded.default;
}

async function loadCandidateSaxes(candidateRoot) {
  const saxesPath = join(candidateRoot, 'node_modules/saxes/saxes.js');
  await regularFile(saxesPath, 'SuperPPT saxes entrypoint');
  const loaded = await import(pathToFileURL(saxesPath).href);
  if (typeof loaded.SaxesParser !== 'function') throw new Error('SuperPPT saxes parser export is invalid');
  return loaded.SaxesParser;
}

function xmlAttribute(node, local, uri = null) {
  const attribute = Object.values(node.attributes).find((candidate) =>
    candidate.local === local && (uri === null || candidate.uri === uri));
  return attribute?.value ?? null;
}

function parseXml(SaxesParser, xml, label, handlers) {
  try {
    const parser = new SaxesParser({ xmlns: true });
    parser.on('opentag', (node) => handlers.open?.(node));
    parser.on('text', (text) => handlers.text?.(text));
    parser.on('closetag', (node) => handlers.close?.(node));
    parser.on('error', (error) => { throw error; });
    parser.write(xml).close();
  } catch (error) {
    throw new Error(`${label} is malformed XML`, { cause: error });
  }
}

function relationshipPart(sourcePart) {
  return posix.join(posix.dirname(sourcePart), '_rels', `${posix.basename(sourcePart)}.rels`);
}

function resolveRelationshipTarget(sourcePart, target) {
  if (!target || target.includes('\\') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
    throw new Error(`OOXML relationship target is unsafe: ${target}`);
  }
  const resolved = target.startsWith('/')
    ? posix.normalize(target.slice(1))
    : posix.normalize(posix.join(posix.dirname(sourcePart), target));
  if (!resolved || resolved === '..' || resolved.startsWith('../') || resolved.includes('/../')) {
    throw new Error(`OOXML relationship target escapes the package: ${target}`);
  }
  return resolved;
}

function parseRelationships(SaxesParser, xml, sourcePart) {
  const relationships = new Map();
  parseXml(SaxesParser, xml, relationshipPart(sourcePart), {
    open(node) {
      if (node.uri !== PACKAGE_REL_NS || node.local !== 'Relationship') return;
      const id = xmlAttribute(node, 'Id');
      const type = xmlAttribute(node, 'Type');
      const target = xmlAttribute(node, 'Target');
      const targetMode = xmlAttribute(node, 'TargetMode');
      if (!id || !type || !target || relationships.has(id)) {
        throw new Error('OOXML relationship must have unique Id, Type, and Target');
      }
      relationships.set(id, {
        id,
        type,
        targetMode,
        part: resolveRelationshipTarget(sourcePart, target),
      });
    },
  });
  return relationships;
}

function parsePresentationOrder(SaxesParser, xml, relationships) {
  const relationshipIds = [];
  parseXml(SaxesParser, xml, 'ppt/presentation.xml', {
    open(node) {
      if (node.uri !== PRESENTATION_NS || node.local !== 'sldId') return;
      const relationshipId = xmlAttribute(node, 'id', OFFICE_REL_NS);
      if (!relationshipId || relationshipIds.includes(relationshipId)) {
        throw new Error('presentation slide list must have unique relationship IDs');
      }
      relationshipIds.push(relationshipId);
    },
  });
  return relationshipIds.map((id) => {
    const relationship = relationships.get(id);
    if (!relationship || relationship.targetMode === 'External'
      || relationship.type !== `${OFFICE_REL_NS}/slide`) {
      throw new Error(`presentation slide ${id} lacks a valid internal slide relationship`);
    }
    return relationship.part;
  });
}

function parseSlideObjects(SaxesParser, xml, label) {
  const pictures = [];
  const shapes = [];
  let picture = null;
  let shape = null;
  let runDepth = 0;
  let text = null;
  parseXml(SaxesParser, xml, label, {
    open(node) {
      if (node.uri === PRESENTATION_NS && node.local === 'pic') {
        if (picture) throw new Error('nested picture objects are invalid');
        picture = { name: null, embed: null };
      } else if (node.uri === PRESENTATION_NS && node.local === 'sp') {
        if (shape) throw new Error('nested shape objects are invalid');
        shape = { name: null, runs: [] };
      } else if (node.uri === PRESENTATION_NS && node.local === 'cNvPr') {
        if (picture) picture.name = xmlAttribute(node, 'name');
        if (shape) shape.name = xmlAttribute(node, 'name');
      } else if (node.uri === DRAWING_NS && node.local === 'blip' && picture) {
        picture.embed = xmlAttribute(node, 'embed', OFFICE_REL_NS);
      } else if (node.uri === DRAWING_NS && node.local === 'r' && shape) {
        runDepth += 1;
      } else if (node.uri === DRAWING_NS && node.local === 't' && shape && runDepth > 0) {
        text = '';
      }
    },
    text(value) {
      if (text !== null) text += value;
    },
    close(node) {
      if (node.uri === DRAWING_NS && node.local === 't' && text !== null && shape) {
        shape.runs.push(text);
        text = null;
      } else if (node.uri === DRAWING_NS && node.local === 'r' && shape) {
        runDepth -= 1;
      } else if (node.uri === PRESENTATION_NS && node.local === 'pic' && picture) {
        pictures.push(picture);
        picture = null;
      } else if (node.uri === PRESENTATION_NS && node.local === 'sp' && shape) {
        shapes.push(shape);
        shape = null;
        runDepth = 0;
        text = null;
      }
    },
  });
  return { pictures, shapes };
}

async function archiveText(archive, part, label = part) {
  const entry = archive.file(part);
  if (!entry) throw new Error(`generated PPTX lacks ${label}`);
  return entry.async('string');
}

async function validateFixturePicture(archive, slide, relationships, expectedName, fixtureBinding, label) {
  const picture = slide.pictures.find(({ name }) => name === expectedName);
  if (!picture) throw new Error(`${label} must contain picture object ${expectedName}`);
  const relationship = picture.embed ? relationships.get(picture.embed) : null;
  if (!relationship || relationship.targetMode === 'External'
    || relationship.type !== `${OFFICE_REL_NS}/image`) {
    throw new Error(`${label} picture object ${expectedName} must use a valid image relationship`);
  }
  const media = archive.file(relationship.part);
  if (!media) throw new Error(`${label} picture image relationship target is missing`);
  const bytes = await media.async('nodebuffer');
  const identity = inspectPngBytes(bytes, `${label} embedded picture ${expectedName}`);
  if (identity.sha256 !== fixtureBinding.sha256) {
    throw new Error(`${label} embedded picture ${expectedName} must match required fixture SHA-256 ${fixtureBinding.sha256}`);
  }
  return { relationship_id: picture.embed, media_part: relationship.part, ...identity };
}

export async function inspectThreeSlidePptx(candidateRoot, pptxPath, fixtureBinding = null) {
  const root = await canonicalDirectory(candidateRoot, 'SuperPPT root');
  const expectedFixture = fixtureBinding ?? await inspectFixtureBinding(
    REQUIRED_FIXTURE_PATH,
    REQUIRED_FIXTURE_PATH,
    REQUIRED_FIXTURE_SHA256,
  );
  const bytes = await regularFile(pptxPath, 'generated PPTX');
  const [JSZip, SaxesParser] = await Promise.all([
    loadCandidateJsZip(root),
    loadCandidateSaxes(root),
  ]);
  let archive;
  try {
    archive = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new Error('generated PPTX must be a readable ZIP/OOXML package', { cause: error });
  }
  if (!archive.file('[Content_Types].xml')) throw new Error('generated PPTX lacks [Content_Types].xml');
  const presentationPart = 'ppt/presentation.xml';
  const presentationRelationships = parseRelationships(
    SaxesParser,
    await archiveText(archive, relationshipPart(presentationPart)),
    presentationPart,
  );
  const slidePaths = parsePresentationOrder(
    SaxesParser,
    await archiveText(archive, presentationPart),
    presentationRelationships,
  );
  if (slidePaths.length !== 3) {
    throw new Error(`generated PPTX must contain exactly 3 slides; received ${slidePaths.length}`);
  }
  const slides = await Promise.all(slidePaths.map(async (part) => ({
    part,
    objects: parseSlideObjects(SaxesParser, await archiveText(archive, part), part),
    relationships: parseRelationships(
      SaxesParser,
      await archiveText(archive, relationshipPart(part)),
      part,
    ),
  })));
  const titleShape = slides[1].objects.shapes.find((shape) =>
    shape.runs.join('').trim() === 'TITLE EDIT');
  if (!titleShape) {
    throw new Error('generated PPTX slide 2 must contain TITLE EDIT in an editable text run');
  }
  const embeddedPictures = await Promise.all([
    validateFixturePicture(archive, slides[0].objects, slides[0].relationships, 'page-image-1', expectedFixture, 'slide 1'),
    validateFixturePicture(archive, slides[1].objects, slides[1].relationships, 'background-editable-2', expectedFixture, 'slide 2'),
    validateFixturePicture(archive, slides[2].objects, slides[2].relationships, 'page-image-3', expectedFixture, 'slide 3'),
  ]);
  return {
    slideCount: slidePaths.length,
    slide2TitleEdit: true,
    slide2EditableTextRun: true,
    slide1ImagePage: true,
    slide3ImagePage: true,
    presentationSlideParts: slidePaths,
    embeddedPictures,
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
}

function childEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith('RUNTIME_') && !name.startsWith('CODEX_RUNTIME_')));
}

function childRunnerSource() {
  return `
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

async function main() {
  const [assemblePath, fixture, editableRoot, output, environmentReport] = process.argv.slice(2);
  const runtimeEnvironmentKeys = Object.keys(process.env).filter((name) => name.startsWith("RUNTIME_") || name.startsWith("CODEX_RUNTIME_")).sort();
  await writeFile(environmentReport, JSON.stringify({ schema_id: "superwagie.g3-ppt-child-environment.v1", schema_version: 1, runtime_environment_keys: runtimeEnvironmentKeys }, null, 2) + "\\n");
  if (runtimeEnvironmentKeys.length > 0) throw new Error("Codex RUNTIME environment reached the SuperPPT assembler child");
  const { assembleDeck } = await import(pathToFileURL(assemblePath).href);
  await assembleDeck([
    { id: "image-1", order: 0, mode: "image", render: fixture },
    {
      id: "editable-2", order: 1, mode: "editable", render: fixture, editableRoot,
      manifest: {
        manifestVersion: 1,
        canvas: { width: 1280, height: 720 },
        elements: [{
          kind: "text", id: "title-edit", text: "TITLE EDIT",
          bbox: { x: 100, y: 96, width: 1080, height: 120 },
          rotation: 0, color: "#17324D", fontSizePx: 48,
          bold: true, align: "left", zIndex: 1
        }],
        warnings: []
      }
    },
    { id: "image-3", order: 2, mode: "image", render: fixture }
  ], output, { trustedRoot: ${JSON.stringify('__TRUSTED_ROOT__')} });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
`;
}

async function runAssembler(candidateRoot, fixtureImage, evidenceDirectory) {
  const editableRoot = join(evidenceDirectory, 'editable-page');
  await mkdir(editableRoot, { mode: 0o700 });
  await copyFile(fixtureImage, join(editableRoot, 'clean-background.png'));
  const temporary = await mkdtemp(join(evidenceDirectory, '.assembler-runner-'));
  const runner = join(temporary, 'run.ts');
  const output = join(evidenceDirectory, 'mixed-deck.pptx');
  const environmentReport = join(evidenceDirectory, 'child-environment.json');
  const assemblePath = join(candidateRoot, 'src/deck/assemble.ts');
  const source = childRunnerSource().replace(JSON.stringify('__TRUSTED_ROOT__'), JSON.stringify(evidenceDirectory));
  await writeFile(runner, source, { mode: 0o600 });
  try {
    const tsxCli = join(candidateRoot, 'node_modules/tsx/dist/cli.mjs');
    await regularFile(tsxCli, 'SuperPPT tsx CLI');
    const completed = spawnSync(process.execPath, [
      tsxCli, runner, assemblePath, fixtureImage, editableRoot, output, environmentReport,
    ], {
      cwd: candidateRoot,
      env: childEnvironment(),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (completed.status !== 0) {
      throw new Error(`SuperPPT assembleDeck child failed (${completed.status}): ${completed.stderr || completed.stdout}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const environment = JSON.parse(await readFile(environmentReport, 'utf8'));
  return { output, environment };
}

export async function runEvaluation({ superpptRoot, fixtureImage, evidenceDirectory }) {
  const superpptBinding = await bindRequiredSuperPpt(superpptRoot);
  const candidateRoot = superpptBinding.canonical_root;
  const fixtureBinding = await inspectFixtureBinding(
    fixtureImage,
    REQUIRED_FIXTURE_PATH,
    REQUIRED_FIXTURE_SHA256,
  );
  const outputDirectory = await prepareOutputDirectory(evidenceDirectory);
  const sourceAudit = await auditCandidateSources(candidateRoot);
  await writeFile(join(outputDirectory, 'source-audit.json'), `${JSON.stringify(sourceAudit, null, 2)}\n`, { mode: 0o600 });

  const assembled = await runAssembler(candidateRoot, fixtureBinding.canonical_path, outputDirectory);
  const inspection = await inspectThreeSlidePptx(candidateRoot, assembled.output, fixtureBinding);
  const postAssemblyBinding = await inspectGitRevision(candidateRoot, REQUIRED_SUPERPPT_COMMIT);
  if (JSON.stringify(postAssemblyBinding) !== JSON.stringify(superpptBinding)) {
    throw new Error('SuperPPT revision binding changed during assembly');
  }
  const result = {
    schema_id: 'superwagie.g3-ppt-three-slide-evaluation.v2',
    schema_version: 2,
    gate: 'gate-3',
    fixture: FIXTURE_ID,
    evidence_kind: 'child_spike',
    pass: true,
    status: 'passed',
    decision_hint: 'CONDITIONAL_GO',
    parent_gate_signed: false,
    production_implementation_admission_changed: false,
    reasons: ['SUPERPPT_OWNED_ASSEMBLER_THREE_SLIDE_MIXED_DECK_PASSED'],
    limitations: LIMITATIONS,
    metrics: {
      slide_count: inspection.slideCount,
      slide_2_title_edit: inspection.slide2TitleEdit,
      slide_1_image_page: inspection.slide1ImagePage,
      slide_3_image_page: inspection.slide3ImagePage,
      presentation_slide_relationships_valid: true,
      slide_2_editable_text_run: inspection.slide2EditableTextRun,
      embedded_fixture_picture_count: inspection.embeddedPictures.length,
      source_raster_width_px: fixtureBinding.width,
      source_raster_height_px: fixtureBinding.height,
      runtime_environment_keys: assembled.environment.runtime_environment_keys,
    },
    provenance: {
      product: 'SuperPPT',
      commit: superpptBinding.observed_commit,
      assembler: 'src/deck/assemble.ts#assembleDeck',
      runner: 'SuperPPT node_modules/tsx/dist/cli.mjs',
      source_audit: 'source-audit.json',
      superppt_binding: superpptBinding,
      fixture_binding: fixtureBinding,
    },
    artifacts: {
      pptx: { path: 'mixed-deck.pptx', sha256: inspection.sha256, bytes: inspection.bytes },
      editable_background: {
        path: 'editable-page/clean-background.png',
        sha256: fixtureBinding.sha256,
        bytes: fixtureBinding.bytes,
      },
      child_environment: { path: 'child-environment.json' },
    },
  };
  await writeFile(join(outputDirectory, 'results.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}

function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

async function main() {
  const superpptRoot = value('--superppt-root');
  const fixtureImage = value('--fixture-image');
  const evidenceDirectory = value('--evidence-dir');
  if (![superpptRoot, fixtureImage, evidenceDirectory].every(isAbsolute)) {
    throw new Error('usage: ppt-three-slide-eval.mjs --superppt-root ABS --fixture-image ABS --evidence-dir ABS');
  }
  const result = await runEvaluation({ superpptRoot, fixtureImage, evidenceDirectory });
  process.stdout.write(`${JSON.stringify({ pass: result.pass, decision_hint: result.decision_hint })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
