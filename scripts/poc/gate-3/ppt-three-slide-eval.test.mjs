import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SUPERWAGIE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TEST_RUNTIME_ROOT = dirname(fileURLToPath(import.meta.url));
const EVALUATOR = join(SUPERWAGIE_ROOT, 'scripts/poc/gate-3/ppt-three-slide-eval.mjs');
const SUPERPPT_ROOT = '/Users/neomei/项目/codexprojects/SuperPPT';
const FIXTURE = join(SUPERWAGIE_ROOT, 'fixtures/gate-3/G3-PPT-001/fixtures/presentation-visual-1920x1080.png');
const EXPECTED_SUPERPPT_COMMIT = 'd7b2b1c515f6b385a41246d19fa74be99010dfb9';
const EXPECTED_FIXTURE_SHA256 = '20d8e23f49f6d7fdb56491f694472d8898c22dec84ef399c51089a673989196f';
const FIXTURE_IDENTITY = Object.freeze({ sha256: EXPECTED_FIXTURE_SHA256, width: 1920, height: 1080 });
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

async function evaluatorModule() {
  return import(`${pathToFileURL(EVALUATOR).href}?test=${Date.now()}-${Math.random()}`);
}

async function temporaryDirectory(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function candidateSources(pptxSource, testSource, adapterSource = 'safe') {
  const root = await temporaryDirectory('superwagie-three-slide-source-');
  await mkdir(join(root, 'src/deck'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'src/deck/pptx.ts'), pptxSource);
  await writeFile(join(root, 'src/deck/presentation-service.ts'), adapterSource);
  await writeFile(join(root, 'src/deck/assemble.ts'), 'export async function assembleDeck() {}');
  await writeFile(join(root, 'scripts/test.ts'), testSource);
  return root;
}

async function JSZip() {
  const loaded = await import(pathToFileURL(join(TEST_RUNTIME_ROOT, 'node_modules/jszip/lib/index.js')).href);
  return loaded.default;
}

async function pptxFixture(path, slides) {
  const Zip = await JSZip();
  const archive = new Zip();
  archive.file('[Content_Types].xml', '<Types/>');
  archive.file('ppt/presentation.xml', `
    <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${OFFICE_REL}">
      <p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst>
    </p:presentation>`);
  archive.file('ppt/_rels/presentation.xml.rels', `
    <Relationships xmlns="${PACKAGE_REL}">
      ${slides.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${OFFICE_REL}/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}
    </Relationships>`);
  slides.forEach((xml, index) => archive.file(`ppt/slides/slide${index + 1}.xml`, xml));
  await writeFile(path, await archive.generateAsync({ type: 'nodebuffer' }));
}

function slideXml(body) {
  return `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
}

function picture(name, relationshipId = 'rIdImage') {
  return `<p:pic><p:nvPicPr><p:cNvPr id="2" name="${name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relationshipId}"/></p:blipFill><p:spPr/></p:pic>`;
}

function textShape(name, text) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="3" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

async function semanticPptx(path, options = {}) {
  const Zip = await JSZip();
  const archive = new Zip();
  const fixtureBytes = options.mediaBytes ?? await readFile(FIXTURE);
  const targets = options.presentationTargets ?? ['slides/slide1.xml', 'slides/slide2.xml', 'slides/slide3.xml'];
  const slides = options.slides ?? [
    slideXml(picture('page-image-1')),
    slideXml(`${picture('background-editable-2')}${textShape('text-title-edit', 'TITLE EDIT')}`),
    slideXml(picture('page-image-3')),
  ];
  archive.file('[Content_Types].xml', '<Types/>');
  archive.file('ppt/presentation.xml', `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${OFFICE_REL}"><p:sldIdLst>${targets.map((_, index) => `<p:sldId id="${256 + index}" r:id="rIdSlide${index + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`);
  archive.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="${PACKAGE_REL}">${targets.map((target, index) => `<Relationship Id="rIdSlide${index + 1}" Type="${OFFICE_REL}/slide" Target="${target}"/>`).join('')}</Relationships>`);
  slides.forEach((xml, index) => {
    archive.file(`ppt/slides/slide${index + 1}.xml`, xml);
    const relationshipType = options.imageRelationshipType ?? `${OFFICE_REL}/image`;
    archive.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rIdImage" Type="${relationshipType}" Target="../media/image-${index + 1}.png"/></Relationships>`);
    archive.file(`ppt/media/image-${index + 1}.png`, fixtureBytes);
  });
  await writeFile(path, await archive.generateAsync({ type: 'nodebuffer' }));
}

function git(root, args) {
  const completed = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  return completed.stdout.trim();
}

async function gitFixture() {
  const root = await temporaryDirectory('superwagie-three-slide-git-');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Test']);
  await writeFile(join(root, 'tracked.txt'), 'one\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-qm', 'fixture']);
  return { root, commit: git(root, ['rev-parse', 'HEAD']) };
}

test('rejects Codex package/runtime coupling in either audited SuperPPT source', async () => {
  const { auditCandidateSources } = await evaluatorModule();
  for (const [pptxSource, testSource] of [
    ['import "@oai/artifact-tool";', 'safe'],
    ['safe', 'const runtime = "codex-primary-runtime";'],
  ]) {
    const root = await candidateSources(pptxSource, testSource);
    await assert.rejects(auditCandidateSources(root), /Codex package\/runtime coupling/);
  }
});

test('a clean delegate cannot hide a coupled presentation-service adapter', async () => {
  const { auditCandidateSources } = await evaluatorModule();
  const root = await candidateSources(
    'import { writePresentation } from "./presentation-service";',
    'safe',
    'const runtime = process.env.RUNTIME_NODE_MODULES;',
  );
  await assert.rejects(auditCandidateSources(root), /presentation-service\.ts:RUNTIME_NODE_MODULES/);
});

test('source audit records the adapter and complete forbidden-marker set hashes', async () => {
  const { auditCandidateSources } = await evaluatorModule();
  const root = await candidateSources('safe', 'safe', 'safe');
  const audit = await auditCandidateSources(root);
  assert.match(audit.sources['src/deck/presentation-service.ts'].sha256, /^[a-f0-9]{64}$/);
  assert.match(audit.forbidden_marker_set_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(audit.forbidden_markers, [
    '@oai/artifact-tool',
    'codex-primary-runtime',
    'codex-runtimes',
    'RUNTIME_NODE',
    'RUNTIME_NODE_MODULES',
    'RUNTIME_BIN_DIR',
  ]);
});

test('rejects a generated PPTX whose slide count is not exactly three', async () => {
  const { inspectThreeSlidePptx } = await evaluatorModule();
  const root = await temporaryDirectory('superwagie-three-slide-count-');
  const pptx = join(root, 'two-slides.pptx');
  await pptxFixture(pptx, ['<p:sld/>', '<p:sld><a:t>TITLE EDIT</a:t></p:sld>']);
  await assert.rejects(inspectThreeSlidePptx(TEST_RUNTIME_ROOT, pptx), /exactly 3 slides/);
});

test('rejects a generated PPTX whose second slide lacks editable TITLE EDIT text', async () => {
  const { inspectThreeSlidePptx } = await evaluatorModule();
  const root = await temporaryDirectory('superwagie-three-slide-title-');
  const pptx = join(root, 'missing-title.pptx');
  await semanticPptx(pptx, { slides: [
    slideXml(picture('page-image-1')),
    slideXml(`${picture('background-editable-2')}${textShape('text-title-edit', 'NOT EDITABLE')}`),
    slideXml(picture('page-image-3')),
  ] });
  await assert.rejects(inspectThreeSlidePptx(TEST_RUNTIME_ROOT, pptx), /TITLE EDIT/);
});

test('rejects a symlink used as the generated PPTX output parent', async () => {
  const { assertSafeOutputDirectory } = await evaluatorModule();
  const root = await temporaryDirectory('superwagie-three-slide-parent-');
  const physical = join(root, 'physical');
  const linked = join(root, 'linked');
  await mkdir(physical);
  await symlink(physical, linked);
  await assert.rejects(assertSafeOutputDirectory(linked), /non-symlink/);
});

test('rejects a full-slide raster below 1920x1080', async () => {
  const { inspectFullSlidePng } = await evaluatorModule();
  const root = await temporaryDirectory('superwagie-three-slide-raster-');
  const png = join(root, 'small.png');
  const header = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(header);
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(720, 20);
  await writeFile(png, header);
  await assert.rejects(inspectFullSlidePng(png), /1920x1080/);
});

test('rejects a SuperPPT checkout outside the required canonical worktree', async () => {
  const { bindRequiredSuperPpt } = await evaluatorModule();
  const { root } = await gitFixture();
  await assert.rejects(bindRequiredSuperPpt(root), /required SuperPPT worktree/);
});

test('rejects a SuperPPT revision that does not equal the required commit', async () => {
  const { inspectGitRevision } = await evaluatorModule();
  const { root } = await gitFixture();
  await assert.rejects(inspectGitRevision(root, EXPECTED_SUPERPPT_COMMIT), /required commit/);
});

test('rejects tracked worktree changes even when HEAD equals the required commit', async () => {
  const { inspectGitRevision } = await evaluatorModule();
  const { root, commit } = await gitFixture();
  await writeFile(join(root, 'tracked.txt'), 'dirty\n');
  await assert.rejects(inspectGitRevision(root, commit), /tracked worktree.*dirty/i);
});

test('rejects a fixture copied away from the required canonical path', async () => {
  const { inspectFixtureBinding } = await evaluatorModule();
  const root = await temporaryDirectory('superwagie-three-slide-fixture-path-');
  const copied = join(root, 'presentation-visual-1920x1080.png');
  await copyFile(FIXTURE, copied);
  await assert.rejects(inspectFixtureBinding(copied, FIXTURE, EXPECTED_FIXTURE_SHA256), /required canonical path/);
});

test('rejects a canonical fixture whose SHA-256 does not match the required identity', async () => {
  const { inspectFixtureBinding } = await evaluatorModule();
  await assert.rejects(inspectFixtureBinding(FIXTURE, FIXTURE, '0'.repeat(64)), /required SHA-256/);
});

test('uses the presentation slide list instead of numeric slide filenames', async () => {
  const { inspectThreeSlidePptx } = await evaluatorModule();
  const root = await temporaryDirectory('superwagie-three-slide-order-');
  const pptx = join(root, 'wrong-order.pptx');
  await semanticPptx(pptx, { presentationTargets: ['slides/slide1.xml', 'slides/slide3.xml', 'slides/slide2.xml'] });
  await assert.rejects(inspectThreeSlidePptx(TEST_RUNTIME_ROOT, pptx, FIXTURE_IDENTITY), /slide 2.*editable text run/i);
});

test('rejects expected strings that appear only in non-visual metadata', async () => {
  const { inspectThreeSlidePptx } = await evaluatorModule();
  const root = await temporaryDirectory('superwagie-three-slide-metadata-');
  const pptx = join(root, 'metadata-only.pptx');
  await semanticPptx(pptx, { slides: [
    slideXml('<p:sp><p:nvSpPr><p:cNvPr id="2" name="page-image-1"/></p:nvSpPr></p:sp>'),
    slideXml('<p:sp><p:nvSpPr><p:cNvPr id="2" name="text-title-edit" descr="TITLE EDIT background-editable-2"/></p:nvSpPr></p:sp>'),
    slideXml('<p:sp><p:nvSpPr><p:cNvPr id="2" name="page-image-3"/></p:nvSpPr></p:sp>'),
  ] });
  await assert.rejects(inspectThreeSlidePptx(TEST_RUNTIME_ROOT, pptx, FIXTURE_IDENTITY), /slide 2.*editable text run/i);
});

test('rejects image markers placed on ordinary shapes instead of picture objects', async () => {
  const { inspectThreeSlidePptx } = await evaluatorModule();
  const root = await temporaryDirectory('superwagie-three-slide-shapes-');
  const pptx = join(root, 'shape-images.pptx');
  await semanticPptx(pptx, { slides: [
    slideXml(textShape('page-image-1', 'not a picture')),
    slideXml(`${textShape('background-editable-2', 'not a picture')}${textShape('text-title-edit', 'TITLE EDIT')}`),
    slideXml(textShape('page-image-3', 'not a picture')),
  ] });
  await assert.rejects(inspectThreeSlidePptx(TEST_RUNTIME_ROOT, pptx, FIXTURE_IDENTITY), /picture object/i);
});

test('rejects picture objects whose relationships are not image relationships', async () => {
  const { inspectThreeSlidePptx } = await evaluatorModule();
  const root = await temporaryDirectory('superwagie-three-slide-rel-');
  const pptx = join(root, 'bad-image-rel.pptx');
  await semanticPptx(pptx, { imageRelationshipType: `${OFFICE_REL}/hyperlink` });
  await assert.rejects(inspectThreeSlidePptx(TEST_RUNTIME_ROOT, pptx, FIXTURE_IDENTITY), /valid image relationship/i);
});

test('rejects embedded picture media whose hash or dimensions do not match the bound fixture', async () => {
  const { inspectThreeSlidePptx } = await evaluatorModule();
  const root = await temporaryDirectory('superwagie-three-slide-media-');
  const pptx = join(root, 'wrong-media.pptx');
  const small = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(small);
  small.writeUInt32BE(1280, 16);
  small.writeUInt32BE(720, 20);
  await semanticPptx(pptx, { mediaBytes: small });
  await assert.rejects(inspectThreeSlidePptx(TEST_RUNTIME_ROOT, pptx, FIXTURE_IDENTITY), /embedded picture.*1920x1080|required fixture SHA-256/i);
});

test('real SuperPPT assembleDeck creates the three-page mixed deck without Codex RUNTIME env', {
  skip: process.platform !== 'darwin' || !existsSync(SUPERPPT_ROOT),
}, async () => {
  const evidence = await temporaryDirectory('superwagie-three-slide-evidence-');
  const completed = spawnSync(process.execPath, [
    EVALUATOR,
    '--superppt-root', SUPERPPT_ROOT,
    '--fixture-image', FIXTURE,
    '--evidence-dir', evidence,
  ], {
    encoding: 'utf8',
    env: { ...process.env, RUNTIME_NODE: '/forbidden/codex/node', RUNTIME_FAKE_TEST: 'forbidden' },
  });
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);

  const result = JSON.parse(await readFile(join(evidence, 'results.json'), 'utf8'));
  assert.equal(result.pass, true);
  assert.equal(result.decision_hint, 'CONDITIONAL_GO');
  assert.equal(result.parent_gate_signed, false);
  assert.equal(result.production_implementation_admission_changed, false);
  assert.deepEqual(result.metrics.runtime_environment_keys, []);
  assert.equal(result.metrics.slide_count, 3);
  assert.equal(result.metrics.slide_2_title_edit, true);
  for (const expected of ['seven-stage', 'human gates', 'Signed Runtime', 'Windows', 'Owner sign-off']) {
    assert.match(result.limitations.join('\n'), new RegExp(expected, 'i'));
  }
  assert.equal(result.provenance.assembler, 'src/deck/assemble.ts#assembleDeck');
  assert.equal(result.provenance.superppt_binding.required_commit, EXPECTED_SUPERPPT_COMMIT);
  assert.equal(result.provenance.superppt_binding.observed_commit, EXPECTED_SUPERPPT_COMMIT);
  assert.equal(result.provenance.superppt_binding.tracked_worktree_clean, true);
  assert.equal(result.provenance.fixture_binding.canonical_path, FIXTURE);
  assert.equal(result.provenance.fixture_binding.sha256, EXPECTED_FIXTURE_SHA256);

  const { inspectThreeSlidePptx, inspectFixtureBinding } = await evaluatorModule();
  const fixture = await inspectFixtureBinding(FIXTURE, FIXTURE, EXPECTED_FIXTURE_SHA256);
  const inspection = await inspectThreeSlidePptx(SUPERPPT_ROOT, join(evidence, 'mixed-deck.pptx'), fixture);
  assert.equal(inspection.slideCount, 3);
  assert.equal(inspection.slide2TitleEdit, true);
  assert.equal(inspection.slide1ImagePage, true);
  assert.equal(inspection.slide3ImagePage, true);
});
