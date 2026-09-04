import { run } from 'node:test';
import { MessageChannel, parentPort, workerData } from 'node:worker_threads';

if (!parentPort || typeof workerData?.testPath !== 'string') {
  throw new Error('Host Adapter test worker requires a parent and test path');
}

const { port1, port2 } = new MessageChannel();
const sendResult = port2.postMessage.bind(port2);
parentPort.postMessage({
  schema_id: 'superwagie.viewer-host-test-worker-bootstrap.v1',
  port: port1,
}, [port1]);

const summary = {
  schema_id: 'superwagie.viewer-host-test-summary.v1',
  tests: 0,
  pass: 0,
  fail: 0,
  cancelled: 0,
  skipped: 0,
  todo: 0,
  unexpected_output_events: 0,
};

try {
  const stream = run({ files: [workerData.testPath], concurrency: 1, isolation: 'none' });
  for await (const event of stream) {
    if (event.type === 'test:stdout' || event.type === 'test:stderr') summary.unexpected_output_events += 1;
    if (event.type === 'test:diagnostic' && event.data?.nesting === 0) {
      const match = /^(tests|pass|fail|cancelled|skipped|todo) (\d+)$/u.exec(event.data.message ?? '');
      if (match) summary[match[1]] = Number(match[2]);
    }
  }
  sendResult({
    schema_id: 'superwagie.viewer-host-test-worker-result.v1',
    ok: true,
    summary,
  });
} catch {
  sendResult({
    schema_id: 'superwagie.viewer-host-test-worker-result.v1',
    ok: false,
  });
} finally {
  port2.close();
}
