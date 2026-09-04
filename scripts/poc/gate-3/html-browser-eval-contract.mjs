const CHECK_NAMES = [
  'desktop_article_rendered',
  'desktop_navigation_complete',
  'mobile_layout_rendered',
  'mobile_navigation_complete',
  'console_errors_absent',
  'external_requests_absent',
];

export function consoleErrorText(details) {
  if (!details || typeof details !== 'object') return null;
  if (details.level !== 'warning' && details.level !== 'error') return null;
  return typeof details.message === 'string' && details.message.length > 0
    ? details.message
    : 'console error';
}

export function validateBrowserObservation(observation) {
  if (!observation || typeof observation !== 'object') throw new Error('browser observation is required');
  if (!observation.desktop?.mainVisible || !observation.mobile?.mainVisible) {
    throw new Error('both desktop and mobile must render visible main content');
  }
  if (!observation.desktop?.navigationComplete || !observation.mobile?.navigationComplete) {
    throw new Error('both desktop and mobile navigation must be complete');
  }
  if (observation.desktop?.horizontalOverflow !== false
    || observation.mobile?.horizontalOverflow !== false) {
    throw new Error(`horizontal overflow detected (desktop=${observation.desktop?.horizontalOverflow}, mobile=${observation.mobile?.horizontalOverflow})`);
  }
  if (!Array.isArray(observation.consoleErrors) || observation.consoleErrors.length > 0) {
    throw new Error('browser console error detected');
  }
  if (!Array.isArray(observation.externalRequests) || observation.externalRequests.length > 0) {
    throw new Error('external request attempted');
  }
  return {
    desktop_article_rendered: true,
    desktop_navigation_complete: true,
    mobile_layout_rendered: true,
    mobile_navigation_complete: true,
    console_errors_absent: true,
    external_requests_absent: true,
  };
}

function canonicalPlatform(runtimePlatform, runtimeArch) {
  if (runtimePlatform === 'darwin' && runtimeArch === 'arm64') return 'macos-15-arm64';
  if (runtimePlatform === 'win32' && runtimeArch === 'x64') return 'windows-11-x64';
  throw new Error(`unsupported browser evaluation platform: ${runtimePlatform}-${runtimeArch}`);
}

export function evaluationDocument({
  checks,
  executedAt,
  browserSource = 'SuperWagie bundled Chromium browser runtime',
  runtimePlatform = process.platform,
  runtimeArch = process.arch,
}) {
  if (!checks || Object.keys(checks).sort().join('|') !== [...CHECK_NAMES].sort().join('|')
    || Object.values(checks).some((value) => value !== true)) throw new Error('complete passing browser checks are required');
  if (!Number.isFinite(Date.parse(executedAt))) throw new Error('executedAt must be an ISO timestamp');
  return {
    schema_id: 'superwagie.g3-html-browser-evaluation.v1',
    schema_version: 1,
    fixture: 'G3-HTML-001',
    platform: canonicalPlatform(runtimePlatform, runtimeArch),
    executed_at: executedAt,
    browser: { engine: 'Chromium', source: browserSource },
    checks,
    screenshots: {
      desktop: { path: 'desktop.png' },
      mobile: { path: 'mobile.png' },
    },
  };
}
