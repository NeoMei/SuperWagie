import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../packages/web/server/lib/model-configuration/resolve-cli.js', import.meta.url));
const output = new URL('../packages/web/server/generated/model-resolver.mjs', import.meta.url);
const result = await Bun.build({
  entrypoints: [entry],
  target: 'node',
  format: 'esm',
  minify: true,
  sourcemap: 'none',
  env: 'disable',
  write: false,
});
if (!result.success || result.outputs.length !== 1) {
  throw new Error(`Model resolver build failed: ${result.logs.join('\n')}`);
}
await fs.mkdir(new URL('./', output), { recursive: true });
const temporary = new URL(`./model-resolver-${process.pid}.tmp`, output);
try {
  await fs.writeFile(temporary, new Uint8Array(await result.outputs[0].arrayBuffer()));
  await fs.rename(temporary, output);
} finally {
  await fs.rm(temporary, { force: true });
}
console.log('Built the standalone model resolver.');
