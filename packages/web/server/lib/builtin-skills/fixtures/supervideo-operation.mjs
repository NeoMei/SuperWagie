import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [engine, root, request, runtime, timeout] = process.argv.slice(2);
let receipt;
if (timeout) {
  const { extractDocument } = await import(pathToFileURL(join(engine, 'src/inputs/documents.mjs')).href);
  const config = JSON.parse(await readFile(runtime, 'utf8'));
  await mkdir(root, { recursive: true });
  try {
    await extractDocument(request, { ...config, projectRoot: root, documentTimeoutMs: 600 });
    throw new Error('Expected the owned timeout fixture to fail');
  } catch (error) {
    receipt = { status: 'failed', error: { code: error.code, detail: error.message } };
  }
} else {
  const { runRuntime } = await import(pathToFileURL(join(engine, 'src/runtime-cli.mjs')).href);
  receipt = await runRuntime(['--project', root, '--request', request, '--runtime', runtime]);
}
const project = await readFile(join(root, 'project.json'), 'utf8').then(JSON.parse).catch(() => undefined);
const failures = [];
const sources = await readdir(join(root, 'sources')).catch(() => []);
for (const name of sources.filter(name => name.startsWith('.extract-'))) {
  failures.push(JSON.parse(await readFile(join(root, 'sources', name, 'failure.json'), 'utf8')));
}
console.log(JSON.stringify({ receipt, project, failures, published: sources.filter(name => !name.startsWith('.extract-')) }));
