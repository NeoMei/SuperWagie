import { MessageChannel, parentPort, workerData } from 'node:worker_threads';

import { runOfficeClosureSmoke } from './office-closure-smoke.mjs';

if (!parentPort || typeof workerData?.bundlePath !== 'string') {
  throw new Error('Office smoke worker requires a parent and bundle path');
}

// Establish a private result channel before loading candidate code. Candidate
// code can reach parentPort only by importing node:worker_threads (which the
// source policy rejects), but it never receives this lexical port reference.
const { port1, port2 } = new MessageChannel();
const sendResult = port2.postMessage.bind(port2);
parentPort.postMessage({
  schema_id: 'superwagie.viewer-office-closure-worker-bootstrap.v1',
  port: port1,
}, [port1]);

try {
  const result = await runOfficeClosureSmoke({ bundlePath: workerData.bundlePath });
  sendResult({
    schema_id: 'superwagie.viewer-office-closure-worker-result.v1',
    ok: true,
    result,
  });
} catch {
  sendResult({
    schema_id: 'superwagie.viewer-office-closure-worker-result.v1',
    ok: false,
  });
} finally {
  port2.close();
}
