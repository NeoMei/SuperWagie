#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function packageNameFromInput(input) {
  const match = input.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  return match?.[1] ?? null;
}

function licenseRecord(packageRoot) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.markdown', 'LICENSE.txt', 'license.md']) {
    const candidate = join(packageRoot, name);
    try {
      const metadata = lstatSync(candidate);
      if (metadata.isFile() && !metadata.isSymbolicLink()) {
        return { path: candidate, text: readFileSync(candidate, 'utf8').trim() };
      }
    } catch {
      // Try the next audited conventional filename.
    }
  }
  const readme = join(packageRoot, 'README.md');
  try {
    const metadata = lstatSync(readme);
    const text = metadata.isFile() && !metadata.isSymbolicLink() ? readFileSync(readme, 'utf8') : '';
    const marker = text.search(/^## License\s*$/im);
    if (marker !== -1 && /Permission is hereby granted/.test(text.slice(marker))) {
      return { path: readme, text: text.slice(marker).trim() };
    }
  } catch {
    // Fall through to a closed failure.
  }
  throw new Error(`runtime package has no auditable license file: ${packageRoot}`);
}

const outputDirectory = argument('--output-dir');
if (!isAbsolute(outputDirectory)) {
  console.error('usage: build-runtime-bundle.mjs --output-dir ABSOLUTE');
  process.exit(2);
}
const outputMetadata = lstatSync(outputDirectory);
if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) {
  console.error('output directory must be a regular non-symlink directory');
  process.exit(2);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const bundlePath = join(outputDirectory, 'presentation-runtime.mjs');
const buildResult = await build({
  absWorkingDir: root,
  entryPoints: ['src/runtime-entry.mjs'],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  legalComments: 'none',
  metafile: true,
  sourcemap: false,
  write: true,
});

const inputNames = Object.keys(buildResult.metafile.inputs).sort();
const bundleBytes = readFileSync(bundlePath);
const forbidden = /image-size|@oai\/artifact-tool|codex-primary-runtime|codex-runtimes/;
if (inputNames.some((input) => forbidden.test(input)) || forbidden.test(bundleBytes.toString('utf8'))) {
  throw new Error('runtime bundle contains a forbidden or blocked dependency');
}

const lockDocument = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const packageNames = [...new Set(inputNames.map(packageNameFromInput).filter(Boolean))].sort();
const components = packageNames.map((name) => {
  const packageRoot = join(root, 'node_modules', name);
  const packageDocument = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const license = licenseRecord(packageRoot);
  const lockEntry = lockDocument.packages?.[`node_modules/${name}`];
  if (lockEntry?.version !== packageDocument.version) {
    throw new Error(`runtime package is not bound to package-lock.json: ${name}`);
  }
  return {
    name,
    version: packageDocument.version,
    license: packageDocument.license,
    integrity: lockEntry.integrity,
    license_file_sha256: digest(Buffer.from(license.text)),
    licenseText: license.text,
  };
});

const publicComponents = components.map(({ licenseText: _licenseText, ...component }) => component);
const sbom = {
  schema_id: 'superwagie.presentation-runtime-reachable-sbom.v1',
  schema_version: 1,
  bundle: {
    path: 'presentation-runtime.mjs',
    sha256: digest(bundleBytes),
    bytes: bundleBytes.length,
    target: 'node22',
    format: 'esm',
  },
  components: publicComponents,
  blocked_dependency_absent: 'image-size',
};
const notices = [
  'SuperWagie Presentation Runtime - Third Party Notices',
  '',
  ...components.flatMap((component) => [
    `===== ${component.name}@${component.version} | ${component.license} =====`,
    component.licenseText,
    '',
  ]),
].join('\n');

writeFileSync(join(outputDirectory, 'runtime-metafile.json'), `${JSON.stringify(buildResult.metafile, null, 2)}\n`, { mode: 0o600 });
writeFileSync(join(outputDirectory, 'runtime-sbom.json'), `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o600 });
writeFileSync(join(outputDirectory, 'THIRD_PARTY_NOTICES.txt'), `${notices}\n`, { mode: 0o600 });
console.log(JSON.stringify(sbom));
