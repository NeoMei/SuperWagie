#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_PRODUCT_HELP_APP_VERSION,
  MAX_PRODUCT_HELP_CONTENT_BYTES,
  parseProductHelpContent,
} from '../packages/web/server/lib/product-help/content.js';

const SOURCE_PATH = fileURLToPath(new URL('../packages/web/server/lib/product-help/content.json', import.meta.url));

export async function buildProductHelpContent({ sourcePath = SOURCE_PATH, outputDir } = {}) {
  const bytes = await fs.readFile(sourcePath);
  if (bytes.length > MAX_PRODUCT_HELP_CONTENT_BYTES) throw new Error('Product help content exceeds the size limit');
  const content = parseProductHelpContent(JSON.parse(bytes.toString('utf8')), CURRENT_PRODUCT_HELP_APP_VERSION);
  const outputPath = outputDir ? path.join(path.resolve(outputDir), 'catalog.json') : null;
  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const staging = await fs.mkdtemp(path.join(path.dirname(outputPath), '.product-help-'));
    try {
      const stagedFile = path.join(staging, 'catalog.json');
      await fs.writeFile(stagedFile, bytes);
      await fs.rename(stagedFile, outputPath);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  return { catalogVersion: content.catalogVersion, revision: content.revision, size: bytes.length, outputPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const checkOnly = args.length === 1 && args[0] === '--check';
    const outputDir = args.length === 2 && args[0] === '--output' && args[1] && !args[1].startsWith('-') ? args[1] : undefined;
    if (!checkOnly && !outputDir) throw new Error('Usage: node scripts/product-help-content.mjs --check | --output <directory>');
    const result = await buildProductHelpContent({ outputDir });
    console.log(`Validated product help ${result.catalogVersion}, revision ${result.revision}, ${result.size} bytes.`);
    if (result.outputPath) console.log(`Wrote ${result.outputPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
