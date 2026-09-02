#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStableRegularFileSync } from '../secure-file-read.mjs';
import { readAndValidateWriterHumanReceipt } from './writer-human-receipt.mjs';
import {
  inspectImageBytes,
  readCleanDetachedGitSnapshot,
  validateGenerationReceiptBytes,
  validateWpsAutomationObservationBytes,
  verifyGenerationExecutableClosure,
  verifyInstalledWpsRendererIdentity,
} from './writer-evidence-trust.mjs';

const REQUIRED = [
  'outputDir', 'sourceMd', 'docx', 'pdf', 'restartDocx', 'semanticA', 'semanticB',
  'openedScreenshot', 'editedScreenshot', 'restoredScreenshot', 'discardPromptScreenshot',
  'automationObservation', 'superwriterRoot', 'wpscomposerRoot', 'canonicalBeforeSha256',
  'generationReceipt',
];
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;

function parseArgs(argv) {
  const aliases = new Map([
    ['--output-dir', 'outputDir'], ['--source-md', 'sourceMd'], ['--docx', 'docx'],
    ['--pdf', 'pdf'], ['--restart-docx', 'restartDocx'], ['--semantic-a', 'semanticA'],
    ['--semantic-b', 'semanticB'], ['--opened-screenshot', 'openedScreenshot'],
    ['--edited-screenshot', 'editedScreenshot'], ['--restored-screenshot', 'restoredScreenshot'],
    ['--discard-prompt-screenshot', 'discardPromptScreenshot'],
    ['--automation-observation', 'automationObservation'], ['--superwriter-root', 'superwriterRoot'],
    ['--wpscomposer-root', 'wpscomposerRoot'], ['--canonical-before-sha256', 'canonicalBeforeSha256'],
    ['--generation-receipt', 'generationReceipt'], ['--human-receipt', 'humanReceipt'],
  ]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = aliases.get(argv[index]);
    if (!key || argv[index + 1] === undefined || result[key] !== undefined) throw new Error(`invalid argument: ${argv[index] ?? ''}`);
    result[key] = argv[index + 1];
  }
  for (const key of REQUIRED) if (!result[key]) throw new Error(`missing argument: ${key}`);
  return result;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readRegular(file, label) {
  if (!isAbsolute(file)) throw new Error(`${label} must be absolute`);
  return readStableRegularFileSync(file, MAX_EVIDENCE_BYTES);
}

function run(command, args, options = {}) {
  const completed = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (completed.status !== 0) throw new Error(`${command} failed: ${(completed.stderr || completed.stdout).trim()}`);
  return completed.stdout;
}

function zipAudit(file, label) {
  run('unzip', ['-t', file]);
  const entries = run('unzip', ['-Z1', file]).split(/\r?\n/);
  for (const required of ['word/document.xml', 'word/media/image1.png']) {
    if (!entries.includes(required)) throw new Error(`${label} is missing ${required}`);
  }
}

function zipEntry(file, entry) {
  const completed = spawnSync('unzip', ['-p', file, entry], { encoding: null, maxBuffer: 20 * 1024 * 1024 });
  if (completed.status !== 0 || !Buffer.isBuffer(completed.stdout)) throw new Error(`cannot read ${entry} from ${basename(file)}`);
  return completed.stdout;
}

function copyArtifact(source, outputRoot, targetName) {
  const bytes = readRegular(source, targetName);
  const target = resolve(outputRoot, 'inputs', targetName);
  writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  return { path: `inputs/${targetName}`, sha256: sha256(bytes) };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!isAbsolute(args.outputDir)) throw new Error('output-dir must be absolute');
  if (!SHA256.test(args.canonicalBeforeSha256)) throw new Error('canonical-before-sha256 is invalid');
  const runId = basename(resolve(args.outputDir));
  const evaluationId = `writer-evaluation-${runId}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(evaluationId)) throw new Error('output directory does not provide valid run/evaluation identity');
  const sourceBytes = readRegular(args.sourceMd, 'source-md');
  const docxBytes = readRegular(args.docx, 'docx');
  const pdfBytes = readRegular(args.pdf, 'pdf');
  const restartBytes = readRegular(args.restartDocx, 'restart-docx');
  const semanticA = readRegular(args.semanticA, 'semantic-a');
  const semanticB = readRegular(args.semanticB, 'semantic-b');
  if (!semanticA.equals(semanticB)) throw new Error('restart semantic output differs');
  const semanticText = semanticA.toString('utf8');
  for (const required of ['SuperWagie 技术验证小型报告', '图目录', '| 阶段 | 输入 | 输出 | 验收重点 |', '真实 Review', '来源']) {
    if (!semanticText.includes(required)) throw new Error(`semantic output is missing ${required}`);
  }
  const sourceText = sourceBytes.toString('utf8');
  for (const required of [':::figure', '| 阶段 | 输入 | 输出 | 验收重点 |', '## 5. 来源']) {
    if (!sourceText.includes(required)) throw new Error(`source is missing ${required}`);
  }
  zipAudit(args.docx, 'docx');
  zipAudit(args.restartDocx, 'restart-docx');
  if (sha256(zipEntry(args.docx, 'word/media/image1.png')) !== sha256(zipEntry(args.restartDocx, 'word/media/image1.png'))) {
    throw new Error('embedded image differs after restart');
  }
  if (sha256(docxBytes) !== args.canonicalBeforeSha256) throw new Error('canonical DOCX changed after interrupt or GUI automation');
  if (!pdfBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('PDF header is invalid');
  const pdfInfo = run('pdfinfo', [args.pdf]);
  if (!/^Creator:\s+WPS/m.test(pdfInfo) || !/^Pages:\s+[3-9]\d*$/m.test(pdfInfo) || !/^Page size:.*A4/m.test(pdfInfo)) {
    throw new Error('PDF is not a 3+ page A4 document created by WPS');
  }
  const pdfPageCount = Number(pdfInfo.match(/^Pages:\s+(\d+)$/m)?.[1]);

  const superwriterSnapshot = readCleanDetachedGitSnapshot(args.superwriterRoot, 'SuperWriter');
  const wpscomposerSnapshot = readCleanDetachedGitSnapshot(args.wpscomposerRoot, 'WPSComposer');
  const acceptance = run('python3', [
    resolve(args.superwriterRoot, 'scripts/verify_acceptance.py'),
    resolve(args.superwriterRoot, '验收/模拟客户A/模拟标段1'),
  ]);
  if (!/PASS/i.test(acceptance)) throw new Error('SuperWriter acceptance verifier did not pass');
  const generationBytes = readRegular(args.generationReceipt, 'generation-receipt');
  const generationValidation = validateGenerationReceiptBytes(generationBytes, {
    fixture: 'G3-WRITER-001', platform: 'macos-15-arm64',
    superwriter: superwriterSnapshot, wpscomposer: wpscomposerSnapshot,
    artifacts: {
      source_md_sha256: sha256(sourceBytes), canonical_docx_sha256: sha256(docxBytes),
      restart_docx_sha256: sha256(restartBytes), pdf_sha256: sha256(pdfBytes),
    },
  });
  if (generationValidation.receipt.schema_version !== 2) throw new Error('trusted collection requires generation receipt v2 with the SuperWriter/WPSComposer executable closure');
  verifyGenerationExecutableClosure(generationValidation.receipt, {
    superwriter: { root: args.superwriterRoot, snapshot: superwriterSnapshot },
    wpscomposer: { root: args.wpscomposerRoot, snapshot: wpscomposerSnapshot },
  });

  const observationBytes = readRegular(args.automationObservation, 'automation-observation');
  const screenshots = {
    opened: args.openedScreenshot,
    edited: args.editedScreenshot,
    restored: args.restoredScreenshot,
    discard_prompt: args.discardPromptScreenshot,
  };
  const screenshotFacts = {};
  for (const [key, file] of Object.entries(screenshots)) {
    const bytes = readRegular(file, `${key} screenshot`);
    screenshotFacts[key] = {
      sha256: sha256(bytes),
      ...inspectImageBytes(bytes, `${key} WPS screenshot`, key === 'discard_prompt'
        ? { minWidth: 300, minHeight: 100 }
        : { minWidth: 640, minHeight: 480 }),
    };
  }
  const observationValidation = validateWpsAutomationObservationBytes(observationBytes, {
    fixture: 'G3-WRITER-001', platform: 'macos-15-arm64', run_id: runId,
    restart_docx_sha256: sha256(restartBytes), screenshots: screenshotFacts,
  });
  const observation = observationValidation.observation;
  verifyInstalledWpsRendererIdentity(observation.renderer_identity);
  for (const key of ['wps_opened_real_document', 'wps_edit_entered_dirty_state', 'wps_undo_restored_original_text', 'canonical_hash_unchanged']) {
    if (observation.observations[key] !== true) throw new Error(`automation observation did not confirm ${key}`);
  }

  mkdirSync(resolve(args.outputDir, 'inputs'), { recursive: true });
  const artifacts = {
    source_md: copyArtifact(args.sourceMd, args.outputDir, 'source.md'),
    docx: copyArtifact(args.docx, args.outputDir, 'writer.docx'),
    pdf: copyArtifact(args.pdf, args.outputDir, 'writer.pdf'),
    restart_docx: copyArtifact(args.restartDocx, args.outputDir, 'writer-restarted.docx'),
    automation_observation: copyArtifact(args.automationObservation, args.outputDir, 'automation-observation.json'),
    generation_receipt: copyArtifact(args.generationReceipt, args.outputDir, 'generation-receipt.json'),
    opened_screenshot: copyArtifact(args.openedScreenshot, args.outputDir, 'wps-opened.png'),
    edited_screenshot: copyArtifact(args.editedScreenshot, args.outputDir, 'wps-edited.png'),
    restored_screenshot: copyArtifact(args.restoredScreenshot, args.outputDir, 'wps-restored.png'),
    discard_prompt_screenshot: copyArtifact(args.discardPromptScreenshot, args.outputDir, 'wps-discard-prompt.png'),
  };
  let humanReceipt = null;
  let manualChecks = {
    seven_stage_receipts_complete: false,
    three_human_gates_complete: false,
    human_visual_review_approved: false,
    wps_discard_close_reopen_confirmed: false,
  };
  if (args.humanReceipt) {
    const validation = readAndValidateWriterHumanReceipt(args.humanReceipt, {
      fixture: 'G3-WRITER-001', platform: 'macos-15-arm64', run_id: runId, evaluation_id: evaluationId,
      operator_role: observation.operator_role,
      source_md_sha256: artifacts.source_md.sha256,
      canonical_docx_sha256: artifacts.docx.sha256,
      restart_docx_sha256: artifacts.restart_docx.sha256,
      pdf_sha256: artifacts.pdf.sha256,
      automation_observation_sha256: artifacts.automation_observation.sha256,
      superwriter_commit: superwriterSnapshot.commit, wpscomposer_commit: wpscomposerSnapshot.commit,
      wps_version: observation.renderer_identity.version, pdf_page_count: pdfPageCount,
      generation_receipt_sha256: artifacts.generation_receipt.sha256,
      renderer_identity_sha256: observationValidation.rendererIdentitySha256,
      wps_session_id: observationValidation.sessionId,
    });
    const receiptRoot = resolve(args.outputDir, 'inputs', 'human-receipt');
    mkdirSync(receiptRoot);
    writeFileSync(resolve(receiptRoot, 'receipt.json'), validation.receiptBytes, { flag: 'wx', mode: 0o600 });
    for (const evidence of validation.evidenceFiles) {
      writeFileSync(resolve(receiptRoot, evidence.name), evidence.bytes, { flag: 'wx', mode: 0o600 });
    }
    humanReceipt = {
      path: 'inputs/human-receipt/receipt.json',
      sha256: validation.receiptSha256,
      summary: validation.summary,
    };
    manualChecks = validation.facts;
  }
  const finalSuperwriterSnapshot = readCleanDetachedGitSnapshot(args.superwriterRoot, 'SuperWriter');
  const finalWpscomposerSnapshot = readCleanDetachedGitSnapshot(args.wpscomposerRoot, 'WPSComposer');
  if (JSON.stringify(finalSuperwriterSnapshot) !== JSON.stringify(superwriterSnapshot)
    || JSON.stringify(finalWpscomposerSnapshot) !== JSON.stringify(wpscomposerSnapshot)) {
    throw new Error('source snapshot changed during Writer collection');
  }
  const evaluation = {
    schema_id: 'superwagie.g3-writer-evaluation.v4',
    schema_version: 4,
    fixture: 'G3-WRITER-001',
    platform: 'macos-15-arm64',
    executed_at: new Date().toISOString(),
    operator_role: observation.operator_role,
    run_identity: { run_id: runId, evaluation_id: evaluationId },
    source_identity: {
      superwriter_commit: superwriterSnapshot.commit,
      superwriter_tree: superwriterSnapshot.tree,
      superwriter_snapshot: 'clean-detached-snapshot',
      wpscomposer_commit: wpscomposerSnapshot.commit,
      wpscomposer_tree: wpscomposerSnapshot.tree,
      wpscomposer_snapshot: 'clean-detached-snapshot',
      generation_id: generationValidation.receipt.generation_id,
      generation_receipt_sha256: artifacts.generation_receipt.sha256,
      host_skill_mirror_status: 'drift-detected',
    },
    renderer: {
      application: 'WPS Office',
      version: observation.renderer_identity.version,
      build: observation.renderer_identity.build,
      bundle_id: observation.renderer_identity.bundle_id,
      team_identifier: observation.renderer_identity.team_identifier,
      executable_sha256: observation.renderer_identity.executable_sha256,
      identity_sha256: observationValidation.rendererIdentitySha256,
      session_id: observationValidation.sessionId,
      pdf_creator: pdfInfo.match(/^Creator:\s+(.+)$/m)?.[1].trim() ?? 'WPS',
      page_count: pdfPageCount,
    },
    artifacts,
    checks: {
      superwriter_acceptance_example: true,
      wpscomposer_clean_preflight: true,
      docx_structure: true,
      pdf_structure: true,
      required_content_coverage: true,
      kill_preserved_existing_output: true,
      restart_semantically_equal: true,
      embedded_image_hash_equal: true,
      wps_opened_real_document: observation.observations.wps_opened_real_document,
      wps_edit_entered_dirty_state: observation.observations.wps_edit_entered_dirty_state,
      wps_undo_restored_original_text: observation.observations.wps_undo_restored_original_text,
      canonical_hash_unchanged: observation.observations.canonical_hash_unchanged,
    },
    manual_checks: manualChecks,
    human_receipt: humanReceipt,
  };
  const evaluationBytes = Buffer.from(`${JSON.stringify(evaluation, null, 2)}\n`);
  writeFileSync(resolve(args.outputDir, 'evaluation.json'), evaluationBytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(resolve(args.outputDir, 'collector-receipt.json'), `${JSON.stringify({
    schema_id: 'superwagie.g3-writer-collector-receipt.v5',
    schema_version: 5,
    fixture: 'G3-WRITER-001',
    platform: 'macos-15-arm64',
    run_identity: evaluation.run_identity,
    collected_at: new Date().toISOString(),
    collector_executable_sha256: sha256(readRegular(fileURLToPath(import.meta.url), 'collector executable')),
    evaluation_sha256: sha256(evaluationBytes),
    automation_observation_sha256: sha256(observationBytes),
    generation_receipt_sha256: generationValidation.receiptSha256,
    renderer_identity_sha256: observationValidation.rendererIdentitySha256,
    wps_session_id: observationValidation.sessionId,
    superwriter_commit: superwriterSnapshot.commit,
    superwriter_tree: superwriterSnapshot.tree,
    wpscomposer_commit: wpscomposerSnapshot.commit,
    wpscomposer_tree: wpscomposerSnapshot.tree,
    human_receipt_sha256: humanReceipt?.sha256 ?? null,
    attestation: null,
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(resolve(args.outputDir, 'evaluation.json'));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
