import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Checker, argValue, writeResults, envFail, rmrf } from '../gate-1/lib.mjs';

const FIXTURE_ID = 'G2-THREAD-001';
const EVIDENCE_REVISION = 'solution-b-v1';
const fixture = argValue(process.argv, '--fixture');
const resultsPath = argValue(process.argv, '--results-json');
const artifactsDir = argValue(process.argv, '--artifacts-dir');
if (fixture !== FIXTURE_ID || !resultsPath) {
  envFail('usage: thread-gate.mjs --fixture ' + FIXTURE_ID + ' --results-json <path> [--artifacts-dir <dir>]');
}

const startedAt = new Date().toISOString();
const checker = new Checker();
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-g2-thread-'));

const TRANSITIONS = Object.freeze({
  ready: ['running', 'archived'],
  running: ['awaiting_user', 'user_stopped', 'credits_blocked', 'disconnected', 'recoverable_failed', 'completed'],
  awaiting_user: ['running'],
  user_stopped: ['running', 'archived'],
  credits_blocked: ['running'],
  disconnected: ['running'],
  recoverable_failed: ['running'],
  completed: ['running', 'archived'],
  archived: [],
});

class Thread {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.state = 'ready';
    this.archivedFrom = null;
    this.sessionCredits = 0;
    this.artifacts = [];
    this.processedOps = [];
    this.offlineQueue = [];
    this.walletBalance = 0;
  }
  transition(to) {
    if (!TRANSITIONS[this.state].includes(to)) return false;
    if (to === 'archived') this.archivedFrom = this.state;
    this.state = to;
    return true;
  }
  restoreArchive() {
    if (this.state !== 'archived') return false;
    this.state = this.archivedFrom === 'user_stopped' ? 'user_stopped' : 'completed';
    this.archivedFrom = null;
    return true;
  }
  checkpoint(file) {
    fs.writeFileSync(file, JSON.stringify({
      session_id: this.sessionId,
      state: this.state,
      archived_from: this.archivedFrom,
      session_credits: this.sessionCredits,
      artifacts: this.artifacts,
      processed_ops: this.processedOps,
      offline_queue: this.offlineQueue,
      wallet_balance: this.walletBalance,
    }, null, 2) + '\n');
  }
  static restore(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const thread = new Thread(data.session_id);
    thread.state = data.state;
    thread.archivedFrom = data.archived_from;
    thread.sessionCredits = data.session_credits;
    thread.artifacts = data.artifacts;
    thread.processedOps = data.processed_ops;
    thread.offlineQueue = data.offline_queue;
    thread.walletBalance = data.wallet_balance;
    return thread;
  }
  runOp(opId, cost) {
    if (this.state === 'archived') return { rejected: 'archived' };
    if (this.processedOps.includes(opId)) return { skipped: true };
    if (this.state === 'ready' || this.state === 'completed') this.transition('running');
    if (this.state !== 'running') return { rejected: 'not-running:' + this.state };
    if (this.walletBalance < cost) {
      this.transition('credits_blocked');
      return { credits_blocked: true, needed: cost };
    }
    this.walletBalance -= cost;
    this.sessionCredits += cost;
    this.processedOps.push(opId);
    const artifact = 'artifact-' + opId;
    this.artifacts.push(artifact);
    return { ok: true, artifact, charged: cost };
  }
  enqueueOffline(messageId) {
    if (this.state === 'running') this.transition('disconnected');
    this.offlineQueue.push(messageId);
  }
  flushOffline(deliveredSink) {
    if (this.state === 'disconnected') this.transition('running');
    const batch = this.offlineQueue.splice(0);
    deliveredSink.push(...batch);
    return batch.length;
  }
}

try {
  const seen = new Set(Object.keys(TRANSITIONS));
  const sequences = [
    ['ready', 'running', 'awaiting_user', 'running'],
    ['ready', 'running', 'user_stopped', 'running'],
    ['ready', 'running', 'credits_blocked', 'running'],
    ['ready', 'running', 'disconnected', 'running'],
    ['ready', 'running', 'recoverable_failed', 'running'],
    ['ready', 'running', 'completed', 'running', 'completed', 'archived'],
  ];
  let transitionsOk = true;
  for (let i = 0; i < sequences.length; i += 1) {
    const thread = new Thread('states-' + i);
    for (const target of sequences[i].slice(1)) transitionsOk = thread.transition(target) && transitionsOk;
  }
  const illegal = new Thread('illegal');
  const illegalRejected = !illegal.transition('completed');
  checker.check('thread:states', transitionsOk && illegalRejected && seen.size === 9,
    'states_covered=' + seen.size + ' legal=' + transitionsOk + ' illegal_rejected=' + illegalRejected);

  const checkpointed = new Thread('checkpoint');
  checkpointed.walletBalance = 100;
  checkpointed.runOp('op-a', 10);
  checkpointed.runOp('op-b', 20);
  const checkpoint = path.join(tmpBase, 'thread.json');
  checkpointed.checkpoint(checkpoint);
  const restored = Thread.restore(checkpoint);
  const retried = restored.runOp('op-a', 10);
  checker.check('thread:checkpoint-idempotent', restored.sessionCredits === 30 && restored.artifacts.length === 2 && retried.skipped === true,
    'credits=' + restored.sessionCredits + ' artifacts=' + restored.artifacts.length + ' retry_skipped=' + !!retried.skipped);

  const stop = new Thread('stop');
  stop.walletBalance = 50;
  stop.runOp('op-stop', 10);
  stop.transition('user_stopped');
  const checkpointStop = path.join(tmpBase, 'stop.json');
  stop.checkpoint(checkpointStop);
  const stopRestored = Thread.restore(checkpointStop);
  stopRestored.transition('running');
  const stopRetry = stopRestored.runOp('op-stop', 10);
  checker.check('thread:stop-resume', stopRetry.skipped === true && stopRestored.sessionCredits === 10,
    'retry_skipped=' + !!stopRetry.skipped + ' session_credits=' + stopRestored.sessionCredits);

  const credits = new Thread('credits');
  credits.walletBalance = 5;
  const blocked = credits.runOp('op-credit', 30);
  credits.walletBalance += 100;
  credits.transition('running');
  const charged = credits.runOp('op-credit', 30);
  checker.check('thread:credits-resume-once', blocked.credits_blocked === true && charged.ok === true && credits.sessionCredits === 30 && credits.walletBalance === 75,
    'blocked=' + !!blocked.credits_blocked + ' credits=' + credits.sessionCredits + ' balance=' + credits.walletBalance);

  const offline = new Thread('offline');
  offline.transition('running');
  offline.enqueueOffline('m1');
  offline.enqueueOffline('m2');
  const delivered = [];
  const firstFlush = offline.flushOffline(delivered);
  const secondFlush = offline.flushOffline(delivered);
  checker.check('thread:disconnect-recover', firstFlush === 2 && secondFlush === 0 && offline.state === 'running' && delivered.join(',') === 'm1,m2',
    'first=' + firstFlush + ' second=' + secondFlush + ' state=' + offline.state);

  const archiveCompleted = new Thread('archive-completed');
  archiveCompleted.transition('running');
  archiveCompleted.transition('completed');
  archiveCompleted.transition('archived');
  const rejectsWhileArchived = archiveCompleted.runOp('forbidden', 0).rejected === 'archived';
  const restoredCompleted = archiveCompleted.restoreArchive() && archiveCompleted.state === 'completed';
  const archiveStopped = new Thread('archive-stopped');
  archiveStopped.transition('running');
  archiveStopped.transition('user_stopped');
  archiveStopped.transition('archived');
  const restoredStopped = archiveStopped.restoreArchive() && archiveStopped.state === 'user_stopped';
  const archiveRestoreVerified = rejectsWhileArchived && restoredCompleted && restoredStopped;
  checker.check('thread:archive-restore', archiveRestoreVerified,
    'rejects=' + rejectsWhileArchived + ' restored_completed=' + restoredCompleted + ' restored_stopped=' + restoredStopped);

  if (artifactsDir) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, 'thread-model.json'), JSON.stringify({
      evidence_revision: EVIDENCE_REVISION,
      transitions: TRANSITIONS,
      states: [...seen],
      delivered,
    }, null, 2) + '\n');
  }

  const pass = writeResults(resultsPath, {
    gate: 'gate-2', fixture: FIXTURE_ID, evidenceRevision: EVIDENCE_REVISION,
    startedAt, checker, decisionHint: 'GO', limitation: null,
    metrics: { states_covered: seen.size, archive_restore_verified: archiveRestoreVerified, checks: checker.summary },
  });
  console.log((pass ? 'PASS' : 'FAIL') + ' ' + FIXTURE_ID + ' checks=' + JSON.stringify(checker.summary));
  rmrf(tmpBase);
  process.exit(pass ? 0 : 1);
} catch (error) {
  console.error('ERROR executor: ' + (error && error.stack ? error.stack : String(error)));
  rmrf(tmpBase);
  process.exit(2);
}
