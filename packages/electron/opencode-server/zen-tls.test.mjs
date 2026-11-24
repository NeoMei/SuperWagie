import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCodeTlsConnect } from './zen-tls.mjs';

test('uses compatible ciphers for Zen only and respects explicit TLS options', () => {
  const calls = [];
  const receiver = {
    connect(options, ...rest) { calls.push({ receiver: this, options, rest }); },
  };
  const connect = openCodeTlsConnect(receiver.connect);
  const zen = { servername: 'api.opencode.ai' };
  connect.call(receiver, zen, 'extra');
  connect.call(receiver, { host: 'opencode.ai.example.com' });
  connect.call(receiver, { servername: 'opencode.ai', ciphers: 'custom' });
  connect.call(receiver, 443, 'example.com');

  assert.match(calls[0].options.ciphers, /^TLS_AES_128_GCM_SHA256:/);
  assert.equal(calls[0].receiver, receiver);
  assert.deepEqual(calls[0].rest, ['extra']);
  assert.equal('ciphers' in zen, false);
  assert.equal(calls[1].options.ciphers, undefined);
  assert.equal(calls[2].options.ciphers, 'custom');
  assert.equal(calls[3].options, 443);
  assert.deepEqual(calls[3].rest, ['example.com']);
});
