import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { canonicalJson, CoreClient } from '../src/core-client.mjs';

function mac(key, value) {
  return createHmac('sha256', key).update(canonicalJson(value)).digest('hex');
}

class FakeChild extends EventEmitter {
  constructor(onMessage) {
    super();
    this.pid = 4242;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        onMessage(JSON.parse(String(chunk)), this);
        callback();
      },
    });
  }

  kill(signal = 'SIGTERM') {
    if (this.exitCode !== null) return false;
    this.exitCode = 0;
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', this.exitCode, signal));
    return true;
  }
}

function fakeSpawn(onMessage) {
  return (_binary, _args, options) => new FakeChild((message, child) => onMessage(message, child, options.env));
}

function writeSigned(child, key, unsigned) {
  child.stdout.write(`${JSON.stringify({ ...unsigned, mac: mac(key, unsigned) })}\n`);
}

function helloAck(message, child, key) {
  writeSigned(child, key, {
    type: 'hello_ack',
    protocol: message.protocol,
    request_id: message.request_id,
    deadline_ms: message.deadline_ms,
    main_nonce: message.main_nonce,
    core_nonce: 'core-test-nonce',
    identity: 'solution-b-rust-core',
    pid: child.pid,
  });
}

function response(message, result) {
  return {
    type: 'response',
    protocol: message.protocol,
    request_id: message.request_id,
    deadline_ms: message.deadline_ms,
    main_nonce: message.main_nonce,
    core_nonce: message.core_nonce,
    sequence: message.sequence,
    identity: 'solution-b-rust-core',
    ok: true,
    result,
  };
}

test('handshake rejects locally when the core accepts input but never responds', async () => {
  let helloDeadline;
  const started = Date.now();
  const client = new CoreClient({
    binary: 'unused-fake-core',
    checkpointPath: 'unused-checkpoint',
    checkpointKeyFd: 3,
    handshakeTimeoutMs: 20,
    spawnProcess: fakeSpawn((message) => { helloDeadline = message.deadline_ms; }),
  });

  await assert.rejects(client.start(), { message: 'CORE_HANDSHAKE_TIMEOUT' });
  assert.ok(helloDeadline >= started + 10 && helloDeadline <= started + 100);
  assert.equal(client.pending.size, 0);
  assert.equal(client.child.signalCode, 'SIGKILL');
});

test('a late timed-out resync response cannot consume the next request waiter', async () => {
  let requestCount = 0;
  const client = new CoreClient({
    binary: 'unused-fake-core',
    checkpointPath: 'unused-checkpoint',
    checkpointKeyFd: 3,
    spawnProcess: fakeSpawn((message, child, environment) => {
      if (message.type === 'hello') {
        helloAck(message, child, environment.SUPERWAGIE_CORE_KEY);
        return;
      }
      requestCount += 1;
      const delay = requestCount === 1 ? 45 : 80;
      const result = requestCount === 1 ? { marker: 'late-first' } : { marker: 'second' };
      setTimeout(() => writeSigned(child, environment.SUPERWAGIE_CORE_KEY, response(message, result)), delay);
    }),
  });
  await client.start();

  await assert.rejects(client.request({
    type: 'query', query_id: 'supervisor.resync', after_cursor: null,
  }, { timeoutMs: 15 }), {
    message: 'CORE_REQUEST_TIMEOUT',
  });
  const second = await client.request({ type: 'heartbeat' }, { timeoutMs: 200 });

  assert.deepEqual(second, { marker: 'second' });
  assert.equal(client.pending.size, 0);
  client.child.kill();
});

test('invalid handshake identity terminates the spawned core', async () => {
  const client = new CoreClient({
    binary: 'unused-fake-core',
    checkpointPath: 'unused-checkpoint',
    checkpointKeyFd: 3,
    spawnProcess: fakeSpawn((message, child) => {
      child.stdout.write(`${JSON.stringify({
        type: 'hello_ack', protocol: message.protocol, request_id: message.request_id,
      })}\n`);
    }),
  });

  await assert.rejects(client.start(), /core handshake identity rejected/);
  assert.equal(client.child.signalCode, 'SIGKILL');
  assert.equal(client.pending.size, 0);
});

test('shutdown timeout force-stops the core and clears pending requests', async () => {
  const client = new CoreClient({
    binary: 'unused-fake-core',
    checkpointPath: 'unused-checkpoint',
    checkpointKeyFd: 3,
    spawnProcess: fakeSpawn((message, child, environment) => {
      if (message.type === 'hello') helloAck(message, child, environment.SUPERWAGIE_CORE_KEY);
    }),
  });
  await client.start();

  await assert.rejects(client.shutdown({ timeoutMs: 20 }), { message: 'CORE_REQUEST_TIMEOUT' });
  assert.equal(client.child.signalCode, 'SIGKILL');
  assert.equal(client.pending.size, 0);
});
