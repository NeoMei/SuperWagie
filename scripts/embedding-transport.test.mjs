import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./embedding-transport.mjs', import.meta.url));
const run = (input, args = []) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OPENCHAMBER_ENTERPRISE_MODE: '1' } });
  const output = []; const errors = [];
  child.stdout.on('data', (bytes) => output.push(bytes)); child.stderr.on('data', (bytes) => errors.push(bytes));
  child.on('close', (code) => resolve({ code, stdout: Buffer.concat(output).toString(), stderr: Buffer.concat(errors).toString() }));
  child.stdin.end(input);
});
test('operator stdin rejects malformed, unknown and policy override input with one sanitized JSON error', async () => {
  for (const input of ['secret-private-sentinel', JSON.stringify({ action: 'unknown' }), JSON.stringify({ action: 'preview', options: { enterpriseOptions: { env: {} } } })]) {
    const result = await run(input); assert.equal(result.code, 1); assert.equal(result.stderr, ''); assert.deepEqual(JSON.parse(result.stdout), { error: 'embedding_transport_rejected' });
  }
  assert.equal((await run('{}', ['private-argument'])).code, 1);
});
