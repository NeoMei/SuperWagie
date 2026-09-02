import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Checker, argValue, writeResults, envFail, rmrf } from '../gate-1/lib.mjs';

const FIXTURE_ID = 'G2-HOST-001';
const EVIDENCE_REVISION = 'solution-b-v1';
const fixture = argValue(process.argv, '--fixture');
const resultsPath = argValue(process.argv, '--results-json');
const artifactsDir = argValue(process.argv, '--artifacts-dir');
if (fixture !== FIXTURE_ID || !resultsPath) {
  envFail('usage: host-gate.mjs --fixture ' + FIXTURE_ID + ' --results-json <path> [--artifacts-dir <dir>]');
}

const startedAt = new Date().toISOString();
const checker = new Checker();
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-g2-host-'));

try {
  const journal = [];
  const externalEffects = new Set();
  const compensated = new Set();
  const meterLedger = {};
  const usedWorkerIdentities = new Set();
  let workerSequence = 0;
  let walletBalance = 1000;

  function journalPhase(phase, opId) {
    journal.push({ writer: 'product-core', phase: phase, op_id: opId, at: new Date().toISOString() });
  }
  function applyExternalEffect(opId) {
    if (externalEffects.has(opId)) return 'exists';
    externalEffects.add(opId);
    return 'created';
  }
  function probeExternalEffect(opId) {
    return externalEffects.has(opId);
  }
  function revokeExternalEffect(opId) {
    externalEffects.delete(opId);
    compensated.add(opId);
  }
  function charge(meterKey, amount) {
    if (meterLedger[meterKey]) return { skipped: true };
    meterLedger[meterKey] = 1;
    walletBalance -= amount;
    return { charged: amount };
  }
  function issueWorkerIdentity(opId) {
    workerSequence += 1;
    return { token: 'worker-once-' + workerSequence, audience: opId };
  }
  function hostWorkerExecute(identity, opId, crashPoint) {
    if (!identity || identity.audience !== opId) return { denied: 'audience-mismatch' };
    if (usedWorkerIdentities.has(identity.token)) return { denied: 'worker-identity-replayed' };
    usedWorkerIdentities.add(identity.token);
    if (crashPoint === 'before-effect') return { status: 'execution_unknown' };
    applyExternalEffect(opId);
    if (crashPoint === 'after-effect') return { status: 'execution_unknown' };
    return { status: 'effect_reported', effect_receipt: 'effect-' + opId };
  }
  function compensate(opId) {
    if (probeExternalEffect(opId)) revokeExternalEffect(opId);
    journalPhase('compensation', opId);
  }
  function trustedHostOp(opId, meterKey, cost, opts) {
    opts = opts || {};
    journalPhase('prepare', opId);
    const workerIdentity = issueWorkerIdentity(opId);
    journalPhase('execute', opId);
    const workerResult = hostWorkerExecute(workerIdentity, opId, opts.executeCrash);
    if (workerResult.status === 'execution_unknown') {
      return { status: 'execution_unknown', opId: opId };
    }
    journalPhase('effect-confirm', opId);
    if (!opts.commitFail) {
      journalPhase('commit', opId);
      charge(meterKey, cost);
      return { status: 'committed' };
    }
    journalPhase('commit-failed', opId);
    compensate(opId);
    return { status: 'compensated' };
  }
  function reconcile(opId, meterKey, cost) {
    if (probeExternalEffect(opId)) {
      journalPhase('effect-confirm', opId);
      journalPhase('commit', opId);
      charge(meterKey, cost);
      return { status: 'adopted' };
    }
    const effect = applyExternalEffect(opId);
    journalPhase('effect-confirm', opId);
    journalPhase('commit', opId);
    charge(meterKey, cost);
    return { status: 'retried', effect: effect };
  }

  // ---- check 1: normal path four phases, metered once ----
  const r1 = trustedHostOp('op-1', 'meter-1', 20);
  const phases1 = journal.filter(function (j) { return j.op_id === 'op-1'; }).map(function (j) { return j.phase; });
  const expected = 'prepare,execute,effect-confirm,commit';
  const normalOk = r1.status === 'committed' && phases1.join(',') === expected && meterLedger['meter-1'] === 1 && walletBalance === 980;
  checker.check('host:normal-path', normalOk, 'status=' + r1.status + ' phases=' + phases1.join(',') + ' metered=' + (meterLedger['meter-1'] || 0));

  // ---- check 2: unknown after effect => reconcile adopts, exactly one effect ----
  const r2 = trustedHostOp('op-2', 'meter-2', 15, { executeCrash: 'after-effect' });
  const unknownOk = r2.status === 'execution_unknown' && probeExternalEffect('op-2');
  const adopted = reconcile('op-2', 'meter-2', 15);
  const effectCount2 = Array.from(externalEffects).filter(function (o) { return o === 'op-2'; }).length;
  const adoptOk = unknownOk && adopted.status === 'adopted' && effectCount2 === 1 && meterLedger['meter-2'] === 1;
  checker.check('host:reconcile-adopt', adoptOk, 'unknown=' + unknownOk + ' adopted=' + adopted.status + ' effect_count=' + effectCount2 + ' metered=' + (meterLedger['meter-2'] || 0));

  // ---- check 3: unknown before effect => reconcile safe retry, exactly one effect ----
  const r3 = trustedHostOp('op-3', 'meter-3', 10, { executeCrash: 'before-effect' });
  const probeBefore = probeExternalEffect('op-3');
  const retried = reconcile('op-3', 'meter-3', 10);
  const effectCount3 = Array.from(externalEffects).filter(function (o) { return o === 'op-3'; }).length;
  const retryOk = r3.status === 'execution_unknown' && probeBefore === false && retried.status === 'retried' && retried.effect === 'created' && effectCount3 === 1 && meterLedger['meter-3'] === 1;
  checker.check('host:reconcile-retry', retryOk, 'probe_before=' + probeBefore + ' effect=' + retried.effect + ' effect_count=' + effectCount3 + ' metered=' + (meterLedger['meter-3'] || 0));

  // ---- check 4: commit failure => compensation revokes effect, no charge ----
  const r4 = trustedHostOp('op-4', 'meter-4', 25, { commitFail: true });
  const compensatedOk = r4.status === 'compensated' && !probeExternalEffect('op-4') && compensated.has('op-4');
  const compPhase = journal.filter(function (j) { return j.op_id === 'op-4' && j.phase === 'compensation'; }).length === 1;
  const noCharge = !meterLedger['meter-4'];
  checker.check('host:compensation', compensatedOk && compPhase && noCharge, 'compensated=' + compensatedOk + ' journal_comp=' + compPhase + ' charged=' + !!meterLedger['meter-4']);

  // ---- check 5: same meterKey charged once across 5 retries ----
  for (let i = 0; i < 5; i += 1) charge('meter-5', 30);
  const meterOnce = meterLedger['meter-5'] === 1;
  const expectedBalance = 1000 - 20 - 15 - 10 - 30;
  const balanceOk = walletBalance === expectedBalance;
  checker.check('host:meter-once', meterOnce && balanceOk, 'meter5_ledger=' + (meterLedger['meter-5'] || 0) + ' balance=' + walletBalance + ' expected=' + expectedBalance);

  // ---- check 6: Product Core owns the journal; Host Worker identity is audience-bound and one-shot ----
  const isolatedIdentity = issueWorkerIdentity('op-boundary');
  const wrongAudience = hostWorkerExecute(isolatedIdentity, 'other-op');
  const firstBoundary = hostWorkerExecute(isolatedIdentity, 'op-boundary');
  const replayBoundary = hostWorkerExecute(isolatedIdentity, 'op-boundary');
  const coreEffectJournal = journal.every(function (entry) { return entry.writer === 'product-core'; });
  const hostWorkerIsolated = wrongAudience.denied === 'audience-mismatch' &&
    !Object.prototype.hasOwnProperty.call(firstBoundary, 'journal') &&
    !Object.prototype.hasOwnProperty.call(firstBoundary, 'wallet_balance');
  const oneTimeWorkerIdentity = firstBoundary.status === 'effect_reported' && replayBoundary.denied === 'worker-identity-replayed';
  checker.check('host:core-worker-boundary', coreEffectJournal && hostWorkerIsolated && oneTimeWorkerIdentity,
    'core_journal=' + coreEffectJournal + ' isolated=' + hostWorkerIsolated + ' one_time=' + oneTimeWorkerIdentity);

  if (artifactsDir) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, 'host-journal.json'), JSON.stringify({
      journal: journal,
      meter_ledger: meterLedger,
      compensated_ops: Array.from(compensated),
      worker_identities_consumed: Array.from(usedWorkerIdentities),
      final_balance: walletBalance
    }, null, 2) + '\n');
  }

  const pass = writeResults(resultsPath, {
    gate: 'gate-2',
    fixture: FIXTURE_ID,
    evidenceRevision: EVIDENCE_REVISION,
    startedAt: startedAt,
    checker: checker,
    decisionHint: 'GO',
    limitation: null,
    metrics: {
      checks: checker.summary,
      final_balance: walletBalance,
      core_effect_journal: coreEffectJournal,
      host_worker_isolated: hostWorkerIsolated,
      one_time_worker_identity: oneTimeWorkerIdentity
    }
  });
  console.log((pass ? 'PASS' : 'FAIL') + ' ' + FIXTURE_ID + ' checks=' + JSON.stringify(checker.summary));
  rmrf(tmpBase);
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error('ERROR executor: ' + (e && e.stack ? e.stack : String(e)));
  rmrf(tmpBase);
  process.exit(2);
}
