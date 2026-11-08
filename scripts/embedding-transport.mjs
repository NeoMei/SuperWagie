import { createTransportCoordinator } from '../packages/web/server/lib/embedded-knowledge/transport-coordinator.js';

// Operator-only JSON stdin. No credentials or source text are accepted as arguments.
try {
  if (process.argv.length !== 2) throw new Error('invalid_arguments');
  const chunks = []; let size = 0;
  for await (const bytes of process.stdin) { size += bytes.length; if (size > 64 * 1024) throw new Error('invalid_input'); chunks.push(bytes); }
  const { action, expectedDigest, options } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!['preview', 'prepare', 'resume', 'rollback'].includes(action) || !options || Object.hasOwn(options, 'env') || Object.hasOwn(options, 'enterpriseOptions')) throw new Error('invalid_input');
  const coordinator = createTransportCoordinator(options);
  const result = action === 'prepare' ? await coordinator.prepare({ expectedDigest }) : await coordinator[action]();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stdout.write('{"error":"embedding_transport_rejected"}\n'); process.exitCode = 1;
}
