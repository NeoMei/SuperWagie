import readline from 'node:readline';
const pending = new Map();
const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.result && pending.has(message.id)) { const id = pending.get(message.id); pending.delete(message.id); reply({ id, result: { text: message.result.content } }); return; }
  if (message.method === 'capabilities') reply({ id: message.id, result: { engine: 'hy-memory', version: '2.0.8', source_sha: '988667cd876fb80bee6d618482f78a2fe426402c', features: [] } });
  if (message.method === 'organize') { pending.set('reverse1', message.id); reply({ id: 'reverse1', method: 'host.generate', params: { prompt: 'fixture', jobId: message.params.context.jobId } }); }
  if (message.method === 'close') { reply({ id: message.id, result: { closed: true } }); process.exit(0); }
});
