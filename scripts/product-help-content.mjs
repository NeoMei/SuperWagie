#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_PRODUCT_HELP_APP_VERSION,
  MAX_PRODUCT_HELP_CONTENT_BYTES,
  parseProductHelpContent,
} from '../packages/web/server/lib/product-help/content.js';
import { projectProductHelpCatalogs } from './product-help-content-projection.mjs';

const SOURCE_PATH = fileURLToPath(new URL('../packages/web/server/lib/product-help/content.json', import.meta.url));

export async function buildProductHelpContent({ sourcePath = SOURCE_PATH, outputDir } = {}) {
  const bytes = await fs.readFile(sourcePath);
  if (bytes.length > MAX_PRODUCT_HELP_CONTENT_BYTES) throw new Error('Product help content exceeds the size limit');
  const source = JSON.parse(bytes.toString('utf8'));
  const content = parseProductHelpContent(source, CURRENT_PRODUCT_HELP_APP_VERSION);
  const catalogs = projectProductHelpCatalogs(source);
  if (catalogs.some(catalog => catalog.bytes.length > MAX_PRODUCT_HELP_CONTENT_BYTES)) {
    throw new Error('Product help content exceeds the size limit');
  }
  const outputs = catalogs.map(({ version, bytes }) => ({ version, size: bytes.length,
    outputPath: outputDir ? path.join(path.resolve(outputDir), version, 'catalog.json') : null }));
  if (outputDir) {
    const destination = path.resolve(outputDir);
    await fs.mkdir(destination, { recursive: true });
    const staging = await fs.mkdtemp(path.join(destination, '.product-help-'));
    try {
      for (const catalog of catalogs) {
        const directory = path.join(staging, catalog.version);
        await fs.mkdir(directory);
        await fs.writeFile(path.join(directory, 'catalog.json'), catalog.bytes);
      }
      for (const { version, outputPath } of outputs) {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.rename(path.join(staging, version, 'catalog.json'), outputPath);
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  return { catalogVersion: content.catalogVersion, revision: content.revision, size: bytes.length, outputs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const checkOnly = args.length === 1 && args[0] === '--check';
    const outputDir = args.length === 2 && args[0] === '--output' && args[1] && !args[1].startsWith('-') ? args[1] : undefined;
    if (!checkOnly && !outputDir) throw new Error('Usage: node scripts/product-help-content.mjs --check | --output <directory>');
    const result = await buildProductHelpContent({ outputDir });
    console.log(`Validated product help ${result.catalogVersion}, revision ${result.revision}, ${result.size} bytes.`);
    for (const output of result.outputs) if (output.outputPath) console.log(`Wrote ${output.outputPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
