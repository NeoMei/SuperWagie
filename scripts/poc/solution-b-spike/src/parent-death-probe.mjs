import { app } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createCheckpointKeyCustody } from './core-client.mjs';

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

app.whenReady().then(async () => {
  const corePath = valueAfter('--core');
  const outputPath = valueAfter('--output');
  const custody = createCheckpointKeyCustody();
  const child = spawn(corePath, [], {
    stdio: ['pipe', 'pipe', 'pipe', custody.fd],
    env: {
      SUPERWAGIE_CORE_KEY: randomBytes(32).toString('hex'),
      SUPERWAGIE_CHECKPOINT_PATH: `${outputPath}.checkpoint.json`,
      SUPERWAGIE_CHECKPOINT_KEY_FD: '3',
    },
  });
  const lines = createInterface({ input: child.stdout });
  const response = new Promise((resolve) => lines.once('line', (line) => resolve(JSON.parse(line))));
  child.stdin.write(`${JSON.stringify({
    type: 'hello',
    protocol: 'solution-b-v1',
    request_id: 'parent-death-hello',
    deadline_ms: Date.now() + 5_000,
    main_nonce: 'parent-death-probe',
    main_identity: 'electron-main@44.1.0',
  })}\n`);
  const hello = await response;
  await writeFile(outputPath, `${JSON.stringify({ corePid: child.pid, hello })}\n`);
  custody.close();
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
