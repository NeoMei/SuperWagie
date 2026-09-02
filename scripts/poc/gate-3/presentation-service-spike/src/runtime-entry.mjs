#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { createPresentation } from './presentation-service.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

const specificationPath = argument('--spec-file');
const output = argument('--output');
if (!isAbsolute(specificationPath) || !isAbsolute(output)) {
  console.error('usage: presentation-runtime.mjs --spec-file ABSOLUTE --output ABSOLUTE.pptx');
  process.exit(2);
}

const specificationMetadata = lstatSync(specificationPath);
if (!specificationMetadata.isFile() || specificationMetadata.isSymbolicLink()) {
  console.error('specification must be a regular non-symlink file');
  process.exit(2);
}

try {
  const specification = JSON.parse(readFileSync(specificationPath, 'utf8'));
  const result = await createPresentation(specification, output);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
