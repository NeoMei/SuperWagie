import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';

const reviewerUiRoot = path.dirname(fileURLToPath(import.meta.url));
const sanitizerSource = path.join(reviewerUiRoot, 'sanitize-dist.mjs');

test('bundle audit encodes an explicitly reviewed namespace literal', () => {
  const result = runSanitizerFixture({
    fileName: 'assets/docx-fast-adapter-fixture.js',
    source: 'const svgNamespace = "http://www.w3.org/2000/svg";'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.includes('http://'), false);
  assert.equal(result.output.includes('http:\\x2f\\x2fwww.w3.org/2000/svg'), true);
});

test('bundle audit fails closed on an unknown CDN or runtime URL', () => {
  const result = runSanitizerFixture({
    fileName: 'assets/pdf-adapter-fixture.js',
    source: 'const workerFallback = "https://cdn.untrusted.invalid/pdf.worker.mjs";'
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unreviewed URL-shaped literal/);
  assert.equal(result.output.includes('https://cdn.untrusted.invalid'), true);
});

test('emitted reviewer application starts without outbound fetch or Worker activity', async () => {
  const distRoot = path.join(reviewerUiRoot, 'dist');
  const assetsRoot = path.join(distRoot, 'assets');
  const entryName = fs.readdirSync(assetsRoot).find((name) => /^index-[^.]+\.js$/.test(name));
  assert.ok(entryName, 'built reviewer application entry is missing');

  const dom = new JSDOM('<main id="reviewer-root"></main><div id="reviewer-styles"></div>');
  const fetchCalls = [];
  const workerCalls = [];
  const previousGlobals = new Map();
  const install = (name, value) => {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install('window', dom.window);
  install('document', dom.window.document);
  install('navigator', dom.window.navigator);
  install('Node', dom.window.Node);
  install('DOMParser', dom.window.DOMParser);
  install('XMLSerializer', dom.window.XMLSerializer);
  install('HTMLElement', dom.window.HTMLElement);
  install('MutationObserver', dom.window.MutationObserver);
  install('fetch', (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    return Promise.resolve(new Response(null, { status: 200 }));
  });
  install('Worker', class TrappedWorker {
    constructor(...args) {
      workerCalls.push(args);
      throw new Error('Worker startup is forbidden during reviewer startup audit');
    }
  });
  if (typeof globalThis.DOMMatrix === 'undefined') {
    install('DOMMatrix', class DOMMatrix {});
  }
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    await import(`${pathToFileURL(path.join(assetsRoot, entryName)).href}?audit=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(fetchCalls.filter((url) => /^https?:\/\//i.test(url)), []);
    assert.equal(workerCalls.length, 0);
    assert.ok(globalThis.superwagieReviewerPoc);
    assert.deepEqual(warnings, ['Warning: Please use the `legacy` build in Node.js environments.']);
  } finally {
    console.warn = previousWarn;
    delete globalThis.superwagieReviewerPoc;
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    dom.window.close();
  }
});

function runSanitizerFixture({ fileName, source }) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-bundle-audit-'));
  try {
    const helperPath = path.join(temporaryRoot, 'sanitize-dist.mjs');
    const outputPath = path.join(temporaryRoot, 'dist', fileName);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(sanitizerSource, helperPath);
    fs.writeFileSync(outputPath, source);
    const processResult = spawnSync(process.execPath, [helperPath], { encoding: 'utf8' });
    return {
      status: processResult.status,
      stderr: processResult.stderr,
      output: fs.readFileSync(outputPath, 'utf8')
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
