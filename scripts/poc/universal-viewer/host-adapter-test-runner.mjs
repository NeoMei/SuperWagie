#!/usr/bin/env node

import path from 'node:path';
import { Worker } from 'node:worker_threads';

const [testPath] = process.argv.slice(2);
if (typeof testPath !== 'string' || !path.isAbsolute(testPath)) {
  throw new Error('usage: host-adapter-test-runner.mjs ABSOLUTE_TEST_PATH');
}

const worker = new Worker(new URL('./host-adapter-test-worker.mjs', import.meta.url), {
  workerData: { testPath },
  stdout: true,
  stderr: true,
});
const stdout = [];
const stderr = [];
const parentMessages = [];
const resultMessages = [];
worker.stdout.on('data', chunk => stdout.push(chunk));
worker.stderr.on('data', chunk => stderr.push(chunk));
worker.on('message', message => {
  parentMessages.push(message);
  if (parentMessages.length !== 1
    || message?.schema_id !== 'superwagie.viewer-host-test-worker-bootstrap.v1'
    || !message.port) return;
  message.port.on('message', result => resultMessages.push(result));
  message.port.start();
});

const exitCode = await new Promise((resolve, reject) => {
  worker.once('error', reject);
  worker.once('exit', resolve);
});
await new Promise(resolve => setImmediate(resolve));

if (exitCode !== 0
  || stdout.length !== 0
  || stderr.length !== 0
  || parentMessages.length !== 1
  || resultMessages.length !== 1
  || resultMessages[0]?.schema_id !== 'superwagie.viewer-host-test-worker-result.v1'
  || resultMessages[0]?.ok !== true) {
  throw new Error('Host Adapter tests did not complete the trusted result protocol');
}
process.stdout.write(`${JSON.stringify(resultMessages[0].summary)}\n`);
