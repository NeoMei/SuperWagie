import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return null;
}

export class Checker {
  constructor() {
    this.checks = [];
  }

  check(id, passed, detail) {
    this.checks.push({
      id: id,
      passed: !!passed,
      detail: detail == null ? null : String(detail)
    });
    return !!passed;
  }

  get allPassed() {
    return this.checks.every(function (c) {
      return c.passed;
    });
  }

  get summary() {
    const total = this.checks.length;
    const passed = this.checks.filter(function (c) {
      return c.passed;
    }).length;
    return { total: total, passed: passed, failed: total - passed };
  }
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function writeResults(resultsPath, opts) {
  const results = {
    gate: opts.gate,
    fixture: opts.fixture,
    ...(opts.evidenceRevision ? { evidence_revision: opts.evidenceRevision } : {}),
    started_at: opts.startedAt,
    finished_at: new Date().toISOString(),
    thresholds: { all_checks_pass: true },
    pass: opts.checker.allPassed,
    decision_hint: opts.decisionHint || null,
    limitation: opts.limitation || null,
    summary: opts.checker.summary,
    checks: opts.checker.checks
  };
  if (opts.metrics) results.metrics = opts.metrics;
  if (opts.evidenceBinding) results.evidence_binding = opts.evidenceBinding;
  if (opts.extra) Object.assign(results, opts.extra);
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n');
  return results.pass;
}

export function envFail(msg) {
  console.error('ERROR environment: ' + msg);
  process.exit(2);
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

export function walkFiles(root) {
  const out = [];
  function rec(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) out.push(path.relative(root, p));
    }
  }
  rec(root);
  return out;
}
