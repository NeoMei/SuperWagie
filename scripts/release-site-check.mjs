#!/usr/bin/env node
// A website may name only a release that exists in this repository. The
// 2.7.94 source briefly advertised packages before that release was created,
// which made every installer URL a 404 while the older public site stayed on
// 2.7.93. Keep this as a local check so the same mismatch cannot ship again.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_URL = /github\.com\/NeoMei\/SuperWagie\/releases\/download\/v(\d+\.\d+\.\d+)\//g;

/** Every release download URL in the generated site must name an existing tag. */
export const missingReleaseTags = ({ htmlFiles, readFile, tagExists }) => {
  const missing = new Set();
  for (const file of htmlFiles) {
    for (const match of readFile(file).matchAll(RELEASE_URL)) {
      if (!tagExists(`v${match[1]}`)) missing.add(`${file}: v${match[1]}`);
    }
  }
  return [...missing].sort();
};

const run = () => {
  const dist = path.join(ROOT, 'site', 'dist');
  const list = execFileSync('find', [dist, '-name', '*.html', '-type', 'f'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  const tags = new Set(execFileSync('git', ['tag', '-l'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean));
  const missing = missingReleaseTags({
    htmlFiles: list,
    readFile: (file) => readFileSync(file, 'utf8'),
    tagExists: (tag) => tags.has(tag),
  });
  if (missing.length) {
    console.error('release-site-check 未通过：站点引用了不存在的发布标签。');
    for (const entry of missing) console.error(`  - ${entry}`);
    process.exit(1);
  }
  console.log('release-site-check 通过');
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
