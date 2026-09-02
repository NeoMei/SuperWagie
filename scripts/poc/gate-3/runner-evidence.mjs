import { constants, readFileSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readStableRegularFileSync } from '../secure-file-read.mjs';

function sha(value) { return createHash('sha256').update(value).digest('hex'); }

export function redactedGateCommand(input) {
  const fields = [`gate:${input.gate}`, `platform:${input.platform}`, `fixture:${input.fixture || 'none'}`];
  for (const [label, value] of [['wps-python', input.wpsPython], ['wpscomposer-root', input.wpsComposerRoot], ['wps-application', input.wpsApplication], ['wps-node', input.wpsNode], ['wps-home', input.wpsHome], ['baseline-results', input.baselineResults], ['machine-profile', input.machineProfile], ['scenario-attestation', input.scenarioAttestation], ['isolation-result', input.isolationResult], ['isolation-evidence-root', input.isolationEvidenceRoot], ['candidate-root', input.candidateRoot]]) {
    if (value) fields.push(`${label}-sha256:${sha(Buffer.from(value))}`);
  }
  if (input.checklist) fields.push(`checklist-content-sha256:${sha(readStableRegularFileSync(input.checklist, 16 * 1024 * 1024))}`);
  if (input.evaluationResult) fields.push(`evaluation-result-content-sha256:${sha(readFileSync(input.evaluationResult))}`);
  return `${fields.join(' ')}\n`;
}

export function writeRedactedGateCommandExclusive(input, destination) {
  if (!path.isAbsolute(destination)) throw new Error('command evidence destination must be absolute');
  writeFileSync(destination, redactedGateCommand(input), { flag: 'wx', mode: 0o600 });
}

function commandInput(argv) {
  const [gate, platform, fixture, wpsPython, wpsComposerRoot, wpsApplication, wpsNode, wpsHome, checklist, baselineResults, machineProfile, scenarioAttestation, isolationResult, isolationEvidenceRoot, evaluationResult, candidateRoot] = argv;
  return { gate, platform, fixture, wpsPython, wpsComposerRoot, wpsApplication, wpsNode, wpsHome, checklist, baselineResults, machineProfile, scenarioAttestation, isolationResult, isolationEvidenceRoot, evaluationResult, candidateRoot };
}

export async function copyChecklistEvidence(checklistFile, destination) {
  if (!path.isAbsolute(checklistFile) || !path.isAbsolute(destination)) throw new Error('evidence paths must be absolute');
  const checklistRoot = await realpath(path.dirname(checklistFile));
  const checklist = JSON.parse(await readFile(checklistFile, 'utf8'));
  if (!Array.isArray(checklist.evidence)) throw new Error('checklist evidence invalid');
  await mkdir(destination, { recursive: true });
  const used = new Set();
  for (const entry of checklist.evidence) {
    if (typeof entry !== 'string' || !entry || path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) throw new Error('evidence entry invalid');
    const name = path.basename(entry);
    if (used.has(name)) throw new Error(`destination basename collision: ${name}`);
    used.add(name);
  }
  const receipts = [];
  for (const entry of checklist.evidence) {
    const name = path.basename(entry);
    const requested = path.resolve(checklistRoot, entry);
    const before = await lstat(requested);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error('evidence must be a contained regular non-symlink file');
    const source = await realpath(requested);
    if (!source.startsWith(`${checklistRoot}${path.sep}`)) throw new Error('evidence must be contained under checklist directory');
    const sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await sourceHandle.stat();
      const current = await stat(source);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('evidence changed during validation');
      const bytes = await sourceHandle.readFile();
      const target = path.join(destination, name);
      const targetHandle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await targetHandle.writeFile(bytes); } finally { await targetHandle.close(); }
      receipts.push({ name, sha256: sha(bytes) });
    } finally { await sourceHandle.close(); }
  }
  return receipts;
}

if (process.argv[1]?.endsWith('runner-evidence.mjs')) {
  if (process.argv[2] === 'copy-checklist') {
    try { console.log(JSON.stringify(await copyChecklistEvidence(process.argv[3], process.argv[4]))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  } else if (process.argv[2] === 'redact-command') {
    process.stdout.write(redactedGateCommand(commandInput(process.argv.slice(3))));
  } else if (process.argv[2] === 'redact-command-file') {
    try { writeRedactedGateCommandExclusive(commandInput(process.argv.slice(4)), process.argv[3]); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
