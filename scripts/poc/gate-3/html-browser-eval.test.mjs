import assert from 'node:assert/strict';
import test from 'node:test';

import {
  consoleErrorText,
  evaluationDocument,
  validateBrowserObservation,
} from './html-browser-eval-contract.mjs';

test('browser observation must prove both viewports, navigation, console, and network isolation', () => {
  const observed = validateBrowserObservation({
    desktop: { mainVisible: true, navigationComplete: true },
    mobile: { mainVisible: true, navigationComplete: true },
    consoleErrors: [],
    externalRequests: [],
  });
  assert.deepEqual(observed, {
    desktop_article_rendered: true,
    desktop_navigation_complete: true,
    mobile_layout_rendered: true,
    mobile_navigation_complete: true,
    console_errors_absent: true,
    external_requests_absent: true,
  });
});

test('browser observation fails closed when any external request is attempted', () => {
  assert.throws(() => validateBrowserObservation({
    desktop: { mainVisible: true, navigationComplete: true },
    mobile: { mainVisible: true, navigationComplete: true },
    consoleErrors: [],
    externalRequests: ['https://example.invalid/pixel'],
  }), /external request/);
});

test('evaluation document uses the gate schema and relative screenshot paths', () => {
  const checks = validateBrowserObservation({
    desktop: { mainVisible: true, navigationComplete: true },
    mobile: { mainVisible: true, navigationComplete: true },
    consoleErrors: [],
    externalRequests: [],
  });
  const document = evaluationDocument({ checks, executedAt: '2026-09-03T00:00:00.000Z' });
  assert.equal(document.schema_id, 'superwagie.g3-html-browser-evaluation.v1');
  assert.equal(document.platform, 'macos-15-arm64');
  assert.deepEqual(document.screenshots, {
    desktop: { path: 'desktop.png' },
    mobile: { path: 'mobile.png' },
  });
});

test('evaluation document records the canonical Windows platform from the executing runtime', () => {
  const checks = validateBrowserObservation({
    desktop: { mainVisible: true, navigationComplete: true },
    mobile: { mainVisible: true, navigationComplete: true },
    consoleErrors: [],
    externalRequests: [],
  });
  const document = evaluationDocument({
    checks,
    executedAt: '2026-09-03T00:00:00.000Z',
    runtimePlatform: 'win32',
    runtimeArch: 'x64',
  });
  assert.equal(document.platform, 'windows-11-x64');
});

test('evaluation document fails closed on an unsupported runtime platform', () => {
  const checks = validateBrowserObservation({
    desktop: { mainVisible: true, navigationComplete: true },
    mobile: { mainVisible: true, navigationComplete: true },
    consoleErrors: [],
    externalRequests: [],
  });
  assert.throws(() => evaluationDocument({
    checks,
    executedAt: '2026-09-03T00:00:00.000Z',
    runtimePlatform: 'linux',
    runtimeArch: 'x64',
  }), /unsupported browser evaluation platform/);
});

test('Electron 44 console event details are read from the first argument', () => {
  assert.equal(consoleErrorText({ level: 'error', message: 'page failed' }), 'page failed');
  assert.equal(consoleErrorText({ level: 'warning', message: 'not fatal' }), 'not fatal');
  assert.equal(consoleErrorText({ level: 'info', message: 'normal' }), null);
  assert.equal(consoleErrorText(2), null);
});
