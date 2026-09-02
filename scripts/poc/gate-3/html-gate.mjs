#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';

const FIXTURE_ID = 'G3-HTML-001';
const PAGES = ['index.html', 'project.html', 'data.html'];
const BROWSER_CHECKS = [
  'desktop_article_rendered',
  'desktop_navigation_complete',
  'mobile_layout_rendered',
  'mobile_navigation_complete',
  'console_errors_absent',
  'external_requests_absent',
];
const EXPECTED_LICENSE_SHA256 = '4575a543ab88dad12ccea7d97e563d0bce5b448b06072e65d3264497dad326df';
const MAX_BYTES = 5 * 1024 * 1024;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} keys are invalid`);
}

function regularBytes(file, label) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (metadata.size > MAX_BYTES) throw new Error(`${label} exceeds the size limit`);
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error(`${label} changed during validation`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function within(root, candidate, label) {
  const full = resolve(root, candidate);
  const rel = relative(root, full);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes its root`);
  }
  return full;
}

function validateScreenshot(bytes, file, label) {
  const extension = extname(file).toLowerCase();
  const isPng = bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const isJpeg = bytes.length >= 3
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === '.png' && !isPng) throw new Error(`${label} does not have a PNG signature`);
  if ((extension === '.jpg' || extension === '.jpeg') && !isJpeg) {
    throw new Error(`${label} does not have a JPEG signature`);
  }
  if (!['.png', '.jpg', '.jpeg'].includes(extension)) {
    throw new Error(`${label} must use a supported raster extension`);
  }
}

function result(decision, reasons, limitations, metrics) {
  return {
    schema_id: 'superwagie.g3-html-gate-result.v1',
    schema_version: 1,
    gate: 'gate-3',
    fixture: FIXTURE_ID,
    pass: decision === 'GO' || decision === 'CONDITIONAL_GO',
    status: decision === 'BLOCKED_ENVIRONMENT' ? 'blocked' : decision === 'NO_GO' ? 'failed' : 'passed',
    decision_hint: decision,
    reasons,
    limitations,
    metrics,
  };
}

function writeResult(file, document) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

function auditPage(siteRoot, page) {
  const source = regularBytes(resolve(siteRoot, page), page).toString('utf8');
  const checks = {
    [`${page}:doctype`]: /^<!doctype html>/i.test(source),
    [`${page}:lang`]: /<html\s+lang="zh-CN"/i.test(source),
    [`${page}:viewport`]: /<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1"/i.test(source),
    [`${page}:title`]: /<title>[^<]+<\/title>/i.test(source),
    [`${page}:csp`]: /Content-Security-Policy/i.test(source)
      && /default-src 'self'/i.test(source)
      && /connect-src 'none'/i.test(source)
      && /object-src 'none'/i.test(source),
    [`${page}:semantics`]: /<header\b/i.test(source) && /<nav\b/i.test(source)
      && /<main\b/i.test(source) && /<footer\b/i.test(source),
    [`${page}:skip-link`]: /class="skip-link"\s+href="#main"/i.test(source) && /<main\s+id="main"/i.test(source),
    [`${page}:no-script`]: !/<script\b/i.test(source),
    [`${page}:no-external-url`]: !/(?:href|src)\s*=\s*["'](?:https?:)?\/\//i.test(source),
    [`${page}:no-publisher`]: !/netlify|vercel|github pages|cloudflare pages/i.test(source),
  };
  const links = [...source.matchAll(/(?:href|src)\s*=\s*["']([^"'#?]+)["']/gi)].map((match) => match[1]);
  for (const link of links) {
    if (/^(?:data:|mailto:|tel:)/i.test(link)) continue;
    const target = within(siteRoot, link, `${page} resource`);
    let present = false;
    try {
      const metadata = lstatSync(target);
      present = metadata.isFile() && !metadata.isSymbolicLink();
    } catch {
      present = false;
    }
    checks[`${page}:resource:${link}`] = present;
  }
  return { source, checks };
}

const fixture = arg('--fixture');
const platform = arg('--platform');
const fixtureRoot = arg('--fixture-root');
const resultsPath = arg('--results-json');
const artifactsDir = arg('--artifacts-dir');
const evaluationResult = arg('--evaluation-result');

if (fixture !== FIXTURE_ID || !platform || !isAbsolute(fixtureRoot)
  || !isAbsolute(resultsPath) || !isAbsolute(artifactsDir)
  || (evaluationResult && !isAbsolute(evaluationResult))) {
  console.error(`usage: html-gate.mjs --fixture ${FIXTURE_ID} --platform ID --fixture-root ABS --results-json ABS --artifacts-dir ABS [--evaluation-result ABS]`);
  process.exit(2);
}

let staticChecks = {};
try {
  const rootMetadata = lstatSync(fixtureRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('fixture root is unsafe');
  const siteRoot = resolve(fixtureRoot, 'site');
  const pageSources = {};
  for (const page of PAGES) {
    const audited = auditPage(siteRoot, page);
    pageSources[page] = audited.source;
    staticChecks = { ...staticChecks, ...audited.checks };
  }
  const titles = PAGES.map((page) => pageSources[page].match(/<title>([^<]+)<\/title>/i)?.[1] ?? '');
  staticChecks.unique_titles = new Set(titles).size === PAGES.length;
  staticChecks.navigation_is_complete = PAGES.every((page) => PAGES.every((target) => {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`href=["']${escaped}["']`, 'i').test(pageSources[page]);
  }));
  staticChecks.license_hash_matches = sha256(regularBytes(resolve(fixtureRoot, 'LICENSE.taste-skill.txt'), 'Taste license'))
    === EXPECTED_LICENSE_SHA256;
  const notices = regularBytes(resolve(fixtureRoot, 'THIRD_PARTY_NOTICES.md'), 'third-party notice').toString('utf8');
  staticChecks.taste_snapshot_is_pinned = /ccbc15639c97057cbfcf32ecebc38ef716e4bb37/.test(notices)
    && /aa194351b246b8b4799099d4ed7b033d29eab6e6e3d58d8d2172978be7b3ec89/.test(notices);

  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(resolve(artifactsDir, 'static-audit.json'), `${JSON.stringify({
    schema_id: 'superwagie.g3-html-static-audit.v1',
    schema_version: 1,
    fixture: FIXTURE_ID,
    platform,
    checks: staticChecks,
  }, null, 2)}\n`, { mode: 0o600 });

  const failedStatic = Object.entries(staticChecks).filter(([, passed]) => !passed).map(([name]) => name);
  const baseMetrics = {
    static_checks_total: Object.keys(staticChecks).length,
    static_checks_passed: Object.keys(staticChecks).length - failedStatic.length,
    browser_checks_total: BROWSER_CHECKS.length,
    browser_checks_passed: 0,
    official_host_checks_total: 5,
    official_host_checks_passed: 0,
  };
  if (failedStatic.length > 0) {
    writeResult(resultsPath, result('NO_GO', ['STATIC_HTML_AUDIT_FAILED', ...failedStatic], [], baseMetrics));
    console.error(`NO_GO: ${failedStatic.join(', ')}`);
    process.exit(1);
  }
  if (!evaluationResult) {
    writeResult(resultsPath, result('BLOCKED_ENVIRONMENT', ['REAL_BROWSER_EVALUATION_REQUIRED'], [
      'Static HTML checks cannot substitute for desktop/mobile Chromium rendering and interaction evidence.',
      'Official Host preview, promote, same-link update, rollback, and revoke require the website test environment.',
    ], baseMetrics));
    console.error('BLOCKED_ENVIRONMENT: real browser evaluation required');
    process.exit(2);
  }

  const evaluationRoot = dirname(evaluationResult);
  const evaluationBytes = regularBytes(evaluationResult, 'browser evaluation');
  const evaluation = JSON.parse(evaluationBytes.toString('utf8'));
  exactKeys(evaluation, [
    'schema_id', 'schema_version', 'fixture', 'platform', 'executed_at', 'browser', 'checks', 'screenshots',
  ], 'browser evaluation');
  if (evaluation.schema_id !== 'superwagie.g3-html-browser-evaluation.v1'
    || evaluation.schema_version !== 1 || evaluation.fixture !== FIXTURE_ID || evaluation.platform !== platform
    || !Number.isFinite(Date.parse(evaluation.executed_at))) throw new Error('browser evaluation identity is invalid');
  exactKeys(evaluation.browser, ['engine', 'source'], 'browser identity');
  if (evaluation.browser.engine !== 'Chromium' || !/browser runtime/i.test(evaluation.browser.source)) {
    throw new Error('browser evidence is not from the required Chromium runtime');
  }
  exactKeys(evaluation.checks, BROWSER_CHECKS, 'browser checks');
  exactKeys(evaluation.screenshots, ['desktop', 'mobile'], 'screenshots');
  const browserPassed = BROWSER_CHECKS.filter((name) => evaluation.checks[name] === true).length;
  if (BROWSER_CHECKS.some((name) => typeof evaluation.checks[name] !== 'boolean')) throw new Error('browser check values must be boolean');
  const screenshotReceipts = {};
  for (const name of ['desktop', 'mobile']) {
    exactKeys(evaluation.screenshots[name], ['path'], `${name} screenshot`);
    const path = evaluation.screenshots[name].path;
    if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) throw new Error(`${name} screenshot path is invalid`);
    const source = within(evaluationRoot, path, `${name} screenshot`);
    const bytes = regularBytes(source, `${name} screenshot`);
    validateScreenshot(bytes, path, `${name} screenshot`);
    const destination = resolve(artifactsDir, `${name}-${basename(path)}`);
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
    screenshotReceipts[name] = { file: basename(destination), sha256: sha256(bytes), bytes: bytes.length };
  }
  writeFileSync(resolve(artifactsDir, 'browser-evaluation-receipt.json'), `${JSON.stringify({
    schema_id: 'superwagie.g3-html-browser-evaluation-receipt.v1',
    schema_version: 1,
    evaluation_sha256: sha256(evaluationBytes),
    browser: evaluation.browser,
    screenshots: screenshotReceipts,
  }, null, 2)}\n`, { mode: 0o600 });
  const metrics = { ...baseMetrics, browser_checks_passed: browserPassed };
  if (browserPassed !== BROWSER_CHECKS.length) {
    writeResult(resultsPath, result('NO_GO', ['BROWSER_HTML_CHECK_FAILED',
      ...BROWSER_CHECKS.filter((name) => !evaluation.checks[name])], [], metrics));
    console.error('NO_GO: browser HTML check failed');
    process.exit(1);
  }
  writeResult(resultsPath, result('CONDITIONAL_GO', [], [
    'Official Host preview, promote, same-link update, rollback, and revoke remain unverified until the website test environment exists.',
    'Windows Chromium rendering remains a required separate platform run.',
  ], metrics));
  console.log(`CONDITIONAL_GO ${FIXTURE_ID}: static=${metrics.static_checks_passed}/${metrics.static_checks_total} browser=${browserPassed}/${BROWSER_CHECKS.length}`);
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeResult(resultsPath, result('NO_GO', ['HTML_EVIDENCE_INVALID'], [message], {
    static_checks_total: Object.keys(staticChecks).length,
    static_checks_passed: Object.values(staticChecks).filter(Boolean).length,
    browser_checks_total: BROWSER_CHECKS.length,
    browser_checks_passed: 0,
    official_host_checks_total: 5,
    official_host_checks_passed: 0,
  }));
  console.error(`INVALID ${FIXTURE_ID}: ${message}`);
  process.exit(1);
}
