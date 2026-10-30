import { openModelStore } from './store.js';

let store;
try {
  store = await openModelStore(process.argv[2]);
  if (process.argv[3] === 'record') {
    await store.mutate((state) => {
      state.calls.call = { id: 'call', sessionID: 'session', taskID: 'task', model: 'fixture', digest: 'digest', status: 'UNKNOWN', output: true };
    });
  }
  process.stdout.write(`${JSON.stringify({ state: 'owned' })}\n`);
  process.stdin.resume();
  process.stdin.once('end', async () => { await store.close(); });
} catch (error) {
  process.stdout.write(`${JSON.stringify({ state: 'refused', error: error.code || error.message })}\n`);
}
