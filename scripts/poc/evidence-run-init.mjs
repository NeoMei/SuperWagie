import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

function generatedRunId() {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
  return timestamp + '-' + process.pid + '-' + crypto.randomBytes(12).toString('hex');
}

export function initializeEvidenceRun(options) {
  const gate = options.gate;
  if (!/^(?:contract-foundation|gate-[0-6]|gvp-[0-5])$/.test(gate || '')) throw new Error('invalid gate id');
  const runId = options.runId || generatedRunId();
  if (!/^\d{8}T\d{9}Z-\d+-[0-9a-f]{16,}$/.test(runId)) throw new Error('invalid run id');

  const evidenceRoot = path.resolve(options.evidenceRoot);
  const gateRoot = path.join(evidenceRoot, gate);
  fs.mkdirSync(gateRoot, { recursive: true });
  const runRoot = path.join(gateRoot, runId);
  fs.mkdirSync(runRoot, { recursive: false, mode: 0o700 });
  fs.mkdirSync(path.join(runRoot, 'artifacts'), { mode: 0o700 });
  fs.mkdirSync(path.join(runRoot, 'screenshots'), { mode: 0o700 });

  const manifest = {
    gate,
    fixture: options.fixture || '',
    platform: options.platform,
    run_id: runId,
    operator: options.operator || process.env.USER || 'poc-runner',
    started_at: new Date().toISOString()
  };
  const environment = {
    os: process.platform,
    arch: process.arch,
    release: options.release,
    node: process.versions.node,
    captured_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(runRoot, 'environment.json'), JSON.stringify(environment, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return runRoot;
}

if (process.argv[1]?.endsWith('evidence-run-init.mjs')) {
  try {
    const runRoot = initializeEvidenceRun({
      evidenceRoot: argValue(process.argv, '--evidence-root'),
      gate: argValue(process.argv, '--gate'),
      fixture: argValue(process.argv, '--fixture'),
      platform: argValue(process.argv, '--platform'),
      runId: argValue(process.argv, '--run-id'),
      release: argValue(process.argv, '--release')
    });
    process.stdout.write(runRoot + '\n');
  } catch (error) {
    console.error('ERROR evidence init: ' + error.message);
    process.exitCode = 2;
  }
}
