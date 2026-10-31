import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDecision, createState, markDirectionsReady, markInspected, readState, writeState } from '../src/state.js';
import { StateError } from '../src/schema.js';
import type { SuperwebState } from '../src/schema.js';

function fresh(route: 'page' | 'app' = 'page'): SuperwebState {
  return createState({ taskId: 'demo-abc123', route });
}

function toSample(state: SuperwebState): SuperwebState {
  const ready = markDirectionsReady(state);
  return applyDecision(ready, {
    gate: 'direction',
    choice: 'editorial-swiss',
    revision: ready.stageRevision,
    decisionId: 'd-direction',
  }).state;
}

function toFull(state: SuperwebState): SuperwebState {
  const sample = toSample(state);
  return applyDecision(sample, {
    gate: 'sample',
    choice: 'accept',
    revision: sample.stageRevision,
    decisionId: 'd-sample',
  }).state;
}

test('normal path advances brief -> delivered for both routes', () => {
  for (const route of ['page', 'app'] as const) {
    let state = fresh(route);
    assert.equal(state.stage, 'brief');
    assert.equal(state.stageRevision, 1);

    state = toSample(state);
    assert.equal(state.stage, 'sample');
    assert.equal(state.selectedDirectionId, 'editorial-swiss');
    assert.equal(state.stageRevision, 3);

    state = applyDecision(state, {
      gate: 'sample',
      choice: 'accept',
      revision: 3,
      decisionId: 'd-sample',
    }).state;
    assert.equal(state.stage, 'full');
    assert.equal(state.stageRevision, 4);

    state = markInspected(state, {
      passed: true,
      reportPath: '验收/report.json',
      screenshots: ['验收/desktop.png', '验收/tablet.png', '验收/mobile.png'],
      browserAvailable: true,
      issueCount: 0,
    });
    assert.equal(state.stage, 'acceptance');
    assert.equal(state.stageRevision, 5);
    assert.equal(state.acceptance.passed, true);

    state = applyDecision(state, {
      gate: 'acceptance',
      choice: 'accept',
      revision: 5,
      decisionId: 'd-accept',
    }).state;
    assert.equal(state.stage, 'delivered');
    assert.equal(state.stageRevision, 6);
    assert.equal(state.decisions.length, 3);
    assert.equal(state.selectedDirectionId, 'editorial-swiss');
  }
});

test('stale revision is rejected', () => {
  const state = toSample(fresh());
  assert.throws(
    () =>
      applyDecision(state, {
        gate: 'sample',
        choice: 'accept',
        revision: 1,
        decisionId: 'd-stale',
      }),
    (error: unknown) => error instanceof StateError && /stageRevision 已过期/.test(error.message),
  );
});

test('skipping a stage is rejected', () => {
  assert.throws(
    () =>
      applyDecision(fresh(), {
        gate: 'sample',
        choice: 'accept',
        revision: 1,
        decisionId: 'd-skip',
      }),
    (error: unknown) => error instanceof StateError && /不能提交 sample 决定/.test(error.message),
  );
});

test('replaying the same decision id is idempotent', () => {
  const state = toSample(fresh());
  const replay = applyDecision(state, {
    gate: 'direction',
    choice: 'editorial-swiss',
    revision: 2,
    decisionId: 'd-direction',
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.state.stage, 'sample');
  assert.equal(replay.state.stageRevision, state.stageRevision);
  assert.equal(replay.state.decisions.length, 1);
});

test('reusing a decision id with a different payload is rejected', () => {
  const state = toSample(fresh());
  assert.throws(
    () =>
      applyDecision(state, {
        gate: 'direction',
        choice: 'brutalist-raw',
        revision: 2,
        decisionId: 'd-direction',
      }),
    (error: unknown) => error instanceof StateError && /已用于/.test(error.message),
  );
});

test('reusing a decision id with a different acknowledgement or target is rejected', () => {
  const acceptance = markInspected(toFull(fresh()), {
    passed: false,
    reportPath: '验收/report.json',
    screenshots: [],
    browserAvailable: true,
    issueCount: 1,
  });
  const first = applyDecision(acceptance, {
    gate: 'acceptance',
    choice: 'accept',
    revision: acceptance.stageRevision,
    decisionId: 'd-payload',
    acknowledgeIssues: true,
  });
  assert.throws(
    () => applyDecision(first.state, {
      gate: 'acceptance',
      choice: 'accept',
      revision: acceptance.stageRevision,
      decisionId: 'd-payload',
    }),
    (error: unknown) => error instanceof StateError && /已用于/.test(error.message),
  );

  const rework = applyDecision(
    markInspected(toFull(fresh()), {
      passed: false,
      reportPath: '验收/report.json',
      screenshots: [],
      browserAvailable: true,
      issueCount: 1,
    }),
    {
      gate: 'acceptance',
      choice: 'rework',
      revision: 5,
      decisionId: 'd-rework-payload',
      target: 'sample',
    },
  );
  assert.equal(rework.state.stage, 'sample');
  assert.throws(
    () => applyDecision(rework.state, {
      gate: 'acceptance',
      choice: 'rework',
      revision: 5,
      decisionId: 'd-rework-payload',
      target: 'full',
    }),
    (error: unknown) => error instanceof StateError && /已用于/.test(error.message),
  );
  assert.equal(first.state.stage, 'delivered');
});

test('acceptance cannot be accepted while checks failed without acknowledgement', () => {
  const state = markInspected(toFull(fresh()), {
    passed: false,
    reportPath: '验收/report.json',
    screenshots: [],
    browserAvailable: true,
    issueCount: 2,
  });
  assert.throws(
    () =>
      applyDecision(state, {
        gate: 'acceptance',
        choice: 'accept',
        revision: state.stageRevision,
        decisionId: 'd-risk',
      }),
    (error: unknown) => error instanceof StateError && /验收未通过/.test(error.message),
  );

  const forced = applyDecision(state, {
    gate: 'acceptance',
    choice: 'accept',
    revision: state.stageRevision,
    decisionId: 'd-risk-ok',
    acknowledgeIssues: true,
  });
  assert.equal(forced.state.stage, 'delivered');
  assert.equal(forced.state.decisions.find((decision) => decision.id === 'd-risk-ok')?.acknowledgedIssues, true);
});

test('rework returns to the requested stage before and after delivery', () => {
  const acceptance = markInspected(toFull(fresh()), {
    passed: false,
    reportPath: '验收/report.json',
    screenshots: [],
    browserAvailable: false,
    issueCount: 1,
  });
  const backToSample = applyDecision(acceptance, {
    gate: 'acceptance',
    choice: 'rework',
    revision: acceptance.stageRevision,
    decisionId: 'd-rework-1',
    target: 'sample',
  });
  assert.equal(backToSample.state.stage, 'sample');
  assert.equal(backToSample.state.stageRevision, acceptance.stageRevision + 1);

  const delivered = applyDecision(
    markInspected(toFull(fresh()), {
      passed: true,
      reportPath: '验收/report.json',
      screenshots: [],
      browserAvailable: true,
      issueCount: 0,
    }),
    {
      gate: 'acceptance',
      choice: 'accept',
      revision: 5,
      decisionId: 'd-ok',
    },
  ).state;
  const afterDelivery = applyDecision(delivered, {
    gate: 'acceptance',
    choice: 'rework',
    revision: delivered.stageRevision,
    decisionId: 'd-rework-2',
  });
  assert.equal(afterDelivery.state.stage, 'full');
});

test('inspect is refused outside full and acceptance stages', () => {
  assert.throws(
    () =>
      markInspected(fresh(), {
        passed: true,
        reportPath: '验收/report.json',
        screenshots: [],
        browserAvailable: true,
        issueCount: 0,
      }),
    (error: unknown) => error instanceof StateError && /只有 full 或 acceptance/.test(error.message),
  );
});

test('corrupt state is reported and never silently reset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superweb-state-'));
  const target = join(dir, 'superweb.json');
  await writeFile(target, '{"version": 1, "stage": ', 'utf8');
  await assert.rejects(() => readState(dir), /不是合法 JSON/);
  assert.equal(await readFile(target, 'utf8'), '{"version": 1, "stage": ');
});

test('state round-trips through disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superweb-state-'));
  const state = toFull(fresh('app'));
  await writeState(dir, state);
  const loaded = await readState(dir);
  assert.deepEqual(loaded, state);
});

test('concurrent state writes leave one complete valid state file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superweb-state-concurrent-'));
  const writes = Array.from({ length: 8 }, (_, index) =>
    writeState(dir, { ...fresh(), taskId: `concurrent-${index}` }),
  );
  await Promise.all(writes);
  const loaded = await readState(dir);
  assert.match(loaded.taskId, /^concurrent-[0-7]$/);
});
