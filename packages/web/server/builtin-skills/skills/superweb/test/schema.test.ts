import test from 'node:test';
import assert from 'node:assert/strict';
import { parseState, SuperwebStateSchema } from '../src/schema.js';
import { createState } from '../src/state.js';

const base = () => createState({ taskId: 'schema-abc123', route: 'page' });

test('valid state passes the schema', () => {
  assert.equal(SuperwebStateSchema.safeParse(base()).success, true);
});

test('missing fields are rejected', () => {
  const value = base() as Record<string, unknown>;
  delete value.stageRevision;
  assert.throws(() => parseState(value), /stageRevision/);
});

test('unknown stage is rejected', () => {
  assert.throws(() => parseState({ ...base(), stage: 'review' }), /stage/);
});

test('unknown route is rejected', () => {
  assert.throws(() => parseState({ ...base(), route: 'hybrid' }), /route/);
});

test('bad decision payload is rejected', () => {
  assert.throws(
    () =>
      parseState({
        ...base(),
        decisions: [{ id: 'd1', gate: 'launch', revision: 1, choice: 'x', at: new Date().toISOString() }],
      }),
    /gate/,
  );
  assert.throws(
    () =>
      parseState({
        ...base(),
        decisions: [{ id: 'd1', gate: 'direction', revision: 0, choice: 'x', at: new Date().toISOString() }],
      }),
    /revision/,
  );
  assert.throws(
    () =>
      parseState({
        ...base(),
        decisions: [{ id: 'd1', gate: 'direction', revision: 1, choice: 'x', at: 'yesterday' }],
      }),
    /timestamp/,
  );
});

test('unknown top-level keys are rejected instead of silently dropped', () => {
  assert.throws(() => parseState({ ...base(), surprise: true }), /Unrecognized key/);
});
