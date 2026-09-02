import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    target: 'node24',
    outDir: path.join(root, 'recovery-harness-dist'),
    emptyOutDir: true,
    ssr: path.join(root, 'recovery-contract-harness.ts'),
    rollupOptions: {
      external: [/^node:/],
      output: { entryFileNames: 'ts-recovery-harness.mjs' }
    },
    minify: false,
    sourcemap: false
  }
});
