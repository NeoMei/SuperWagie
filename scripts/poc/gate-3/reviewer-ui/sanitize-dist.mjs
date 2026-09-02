import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const reviewerUiRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultDistRoot = path.join(reviewerUiRoot, 'dist');
const textExtensions = new Set(['.css', '.html', '.js', '.mjs']);

const encode = (literal) => ({ literal, action: 'encode' });
const neutralize = (literal, replacement) => ({ literal, action: 'neutralize', replacement });

const docxRules = [
  encode('http://docx/'),
  encode('http://schemas.microsoft.com/office/2007/relationships/stylesWithEffects'),
  encode('http://schemas.microsoft.com/office/2011/relationships/commentsExtended'),
  ...[
    'aFChunk', 'comments', 'endnotes', 'extended-properties', 'fontTable', 'footer',
    'footnotes', 'header', 'hyperlink', 'image', 'numbering', 'officeDocument',
    'settings', 'styles', 'theme', 'webSettings'
  ].map((name) => encode(`http://schemas.openxmlformats.org/officeDocument/2006/relationships/${name}`)),
  encode('http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties'),
  encode('http://schemas.openxmlformats.org/package/2006/relationships/metadata/custom-properties'),
  encode('http://schemas.openxmlformats.org/wordprocessingml/2006/main'),
  encode('http://www.w3.org/1998/Math/MathML'),
  encode('http://www.w3.org/1999/xhtml'),
  encode('http://www.w3.org/2000/svg'),
  encode('https://rolldown.rs/in-depth/bundling-cjs#require-external-modules'),
  encode('https://stuk.github.io/jszip/documentation/howto/read_zip.html')
];

const pdfDisplayRules = [
  neutralize('http://${e}', 'blocked:${e}'),
  neutralize('http://example.com', 'about:blank'),
  neutralize('https://foo.bar', 'about:blank'),
  encode('http://www.w3.org/2000/svg')
];

const pdfWorkerRules = [
  neutralize('http://${e}', 'blocked:${e}'),
  encode('http://ns.adobe.com/xdp/'),
  encode('http://ns.adobe.com/xdp/pdf/'),
  encode('http://ns.adobe.com/xfdf/'),
  encode('http://ns.adobe.com/xmpmeta/'),
  encode('http://www.apache.org/licenses/LICENSE-2.0'),
  encode('http://www.w3.org/1999/XSL/Transform'),
  encode('http://www.w3.org/1999/xhtml'),
  encode('http://www.w3.org/2000/09/xmldsig#'),
  encode('http://www.w3.org/2000/svg'),
  ...[
    'xci/', 'xdc/', 'xfa-connection-set/', 'xfa-data/', 'xfa-data/1.0/',
    'xfa-form/', 'xfa-locale-set/', 'xfa-source-set/', 'xfa-template/'
  ].map((suffix) => encode(`http://www.xfa.org/schema/${suffix}`))
];

const reviewedProfiles = [
  { name: 'docx-preview application chunk', pattern: /^docx-fast-adapter-.*\.js$/, rules: docxRules },
  { name: 'PDF.js display application chunk', pattern: /^pdf-adapter-.*\.js$/, rules: pdfDisplayRules },
  { name: 'PDF.js Worker chunk', pattern: /^pdf\.worker\.min-.*\.mjs$/, rules: pdfWorkerRules }
];

export function auditAndTransformText(fileName, source) {
  const profile = reviewedProfiles.find(({ pattern }) => pattern.test(path.basename(fileName)));
  const rules = profile?.rules ?? [];
  const matches = [...source.matchAll(/https?:\/\//g)];
  if (matches.length === 0) return source;

  let cursor = 0;
  let output = '';
  for (const match of matches) {
    const offset = match.index;
    if (offset < cursor) continue;
    const rule = rules
      .filter(({ literal }) => source.startsWith(literal, offset) && hasLiteralBoundary(source, offset + literal.length))
      .sort((left, right) => right.literal.length - left.literal.length)[0];
    if (!rule) {
      const context = source.slice(offset, offset + 120).split(/\r?\n/, 1)[0];
      throw new Error(`unreviewed URL-shaped literal in ${fileName} at ${offset}: ${context}`);
    }
    output += source.slice(cursor, offset);
    output += rule.action === 'encode'
      ? rule.literal.replace('://', ':\\x2f\\x2f')
      : rule.replacement;
    cursor = offset + rule.literal.length;
  }
  output += source.slice(cursor);
  if (/https?:\/\//.test(output)) {
    throw new Error(`raw URL-shaped literal survived reviewed transform in ${fileName}`);
  }
  return output;
}

export function auditAndTransformDist(distRoot = defaultDistRoot) {
  const transformedFiles = [];
  for (const filePath of walk(distRoot)) {
    if (!textExtensions.has(path.extname(filePath))) continue;
    const source = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(distRoot, filePath);
    transformedFiles.push({
      filePath,
      source,
      transformed: auditAndTransformText(relativePath, source)
    });
  }
  for (const { filePath, source, transformed } of transformedFiles) {
    if (transformed !== source) fs.writeFileSync(filePath, transformed);
  }
}

function hasLiteralBoundary(source, offset) {
  return offset === source.length || /[\s'"`]/.test(source[offset]);
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(entryPath);
    else if (entry.isFile()) yield entryPath;
  }
}

try {
  auditAndTransformDist();
} catch (error) {
  console.error(`bundle audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
