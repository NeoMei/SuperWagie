import assert from 'node:assert/strict';
import test from 'node:test';

import { CoreSupervisor } from '../src/core-supervisor.mjs';

function supervisorWith(request) {
  const supervisor = new CoreSupervisor({
    binary: 'unused',
    checkpointPath: 'unused',
    heartbeatTimeoutMs: 10,
  });
  const kills = [];
  supervisor.state = 'ready';
  supervisor.client = {
    request,
    child: { exitCode: null, kill: (signal) => kills.push(signal) },
  };
  return { supervisor, kills };
}

test('one missed heartbeat does not consume the core recovery budget', async () => {
  const { supervisor, kills } = supervisorWith(async () => {
    throw new Error('transient scheduler stall');
  });

  await supervisor.heartbeatTick();

  assert.equal(supervisor.consecutiveHeartbeatMisses, 1);
  assert.deepEqual(kills, []);
});

test('two consecutive missed heartbeats terminate the unresponsive core', async () => {
  const { supervisor, kills } = supervisorWith(async () => {
    throw new Error('unresponsive');
  });

  await supervisor.heartbeatTick();
  await supervisor.heartbeatTick();

  assert.equal(supervisor.consecutiveHeartbeatMisses, 2);
  assert.deepEqual(kills, ['SIGKILL']);
});

test('a successful heartbeat resets the miss counter', async () => {
  let attempt = 0;
  const { supervisor, kills } = supervisorWith(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('transient');
    return { type: 'heartbeat_ack' };
  });

  await supervisor.heartbeatTick();
  await supervisor.heartbeatTick();

  assert.equal(supervisor.consecutiveHeartbeatMisses, 0);
  assert.deepEqual(kills, []);
});
