import { createServer } from 'node:http';
import { accessSync, constants, existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import type { Route } from './schema.js';
import { ACCEPTANCE_DIR, REPORT_FILE } from './state.js';

export interface ChromeInfo {
  available: boolean;
  path?: string;
  reason?: string;
  candidates: string[];
}

export interface InspectIssue {
  viewport: string;
  check: string;
  message: string;
  selector?: string;
}

export interface ViewportChecks {
  overflow: {
    ok: boolean;
    scrollWidth: number;
    innerWidth: number;
    offenders: Array<{ selector: string; left: number; right: number }>;
  };
  truncation: { ok: boolean; items: Array<{ selector: string; text: string }> };
  images: { ok: boolean; broken: Array<{ selector: string; src: string }> };
  console: { ok: boolean; errors: string[] };
  primaryAction: { ok: boolean; visible: number; inViewport: number };
  keyboard: { ok: boolean; focusable: number; focused: string[] };
}

export interface ViewportReport {
  name: string;
  width: number;
  height: number;
  screenshot: string;
  checks: ViewportChecks;
  issues: InspectIssue[];
}

export interface AcceptanceReport {
  version: 1;
  taskId?: string;
  route: Route;
  generatedAt: string;
  browser: {
    available: boolean;
    path?: string;
    name?: string;
    reason?: string;
    candidates?: string[];
  };
  viewports: ViewportReport[];
  passed: boolean;
  issueCount: number;
  issues: InspectIssue[];
}

export interface InspectResult {
  report: AcceptanceReport;
  reportPath: string;
  exitCode: 0 | 1 | 4;
}

export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findChrome(explicit?: string): ChromeInfo {
  if (explicit) {
    if (isExecutable(explicit)) return { available: true, path: explicit, candidates: [explicit] };
    return {
      available: false,
      candidates: [explicit],
      reason: `找不到可用的本机 Chrome：指定的路径不存在或不可执行（${explicit}）。可用 --chrome <路径> 或 CHROME_PATH 指定，也可以跳过浏览器验收但交付时会标注“未完成浏览器验收”。`,
    };
  }

  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  add(process.env.CHROME_PATH);

  if (process.platform === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta');
    add('/Applications/Chromium.app/Contents/MacOS/Chromium');
    add(join(process.env.HOME ?? '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  } else if (process.platform === 'win32') {
    add(join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'));
    add(join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'));
    add(join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'));
  } else {
    for (const path of [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ]) {
      add(path);
    }
  }

  const found = candidates.find(isExecutable);
  if (found) return { available: true, path: found, candidates };

  return {
    available: false,
    candidates,
    reason: `找不到可用的本机 Chrome。已检查：${candidates.join('、') || '(无候选路径)'}。可用 --chrome <路径> 或 CHROME_PATH 指定，也可以跳过浏览器验收但交付时会标注“未完成浏览器验收”。`,
  };
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

async function startPreviewServer(rootDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const root = resolve(rootDir);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }
      const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const target = normalize(join(root, requested));
      if (target !== root && !target.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      const info = await stat(target).catch(() => null);
      const file = info?.isDirectory() ? join(target, 'index.html') : target;
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('preview server did not bind to a port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

interface RawChecks {
  scrollWidth: number;
  innerWidth: number;
  overflow: Array<{ selector: string; left: number; right: number }>;
  truncation: Array<{ selector: string; text: string }>;
  brokenImages: Array<{ selector: string; src: string }>;
  focusable: number;
  primary: { visible: number; inViewport: number };
}

// Passed as a string on purpose: bundler transforms can inject helpers (e.g. __name)
// that do not exist in the page context.
const RAW_CHECKS_SCRIPT = `(() => {
  const describe = (element) => {
    if (!element || !element.tagName) return 'unknown';
    const id = element.id ? '#' + element.id : '';
    const classes = element.classList && element.classList.length
      ? '.' + Array.from(element.classList).slice(0, 2).join('.')
      : '';
    return element.tagName.toLowerCase() + id + classes;
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) > 0
    );
  };

  const overflow = [];
  for (const element of Array.from(document.body.querySelectorAll('*'))) {
    if (!visible(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.right > window.innerWidth + 1 || rect.left < -1) {
      overflow.push({
        selector: describe(element),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      });
    }
    if (overflow.length >= 8) break;
  }

  const truncation = [];
  for (const element of Array.from(document.body.querySelectorAll('*'))) {
    if (element.children.length > 0 || !visible(element)) continue;
    const text = (element.textContent || '').trim();
    if (!text) continue;
    const style = getComputedStyle(element);
    if (style.textOverflow === 'ellipsis') continue;
    const clippedX =
      element.scrollWidth > element.clientWidth + 2 &&
      (style.overflowX === 'hidden' || style.overflowX === 'clip');
    const clippedY =
      element.scrollHeight > element.clientHeight + 2 &&
      (style.overflowY === 'hidden' || style.overflowY === 'clip');
    if (clippedX || clippedY) {
      truncation.push({ selector: describe(element), text: text.slice(0, 40) });
    }
    if (truncation.length >= 8) break;
  }

  const brokenImages = Array.from(document.images)
    .filter((image) => image.complete && image.naturalWidth === 0)
    .slice(0, 8)
    .map((image) => ({ selector: describe(image), src: image.getAttribute('src') || '' }));

  const actionables = Array.from(
    document.querySelectorAll('a[href], button, [role="button"], input[type="submit"], select, input:not([type="hidden"])'),
  ).filter(visible);
  const inViewport = actionables.filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0;
  });

  const focusable = Array.from(
    document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
  ).filter(visible).length;

  return {
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    overflow,
    truncation,
    brokenImages,
    focusable,
    primary: { visible: actionables.length, inViewport: inViewport.length },
  };
})()`;

async function collectRawChecks(page: import('playwright-core').Page): Promise<RawChecks> {
  return (await page.evaluate(RAW_CHECKS_SCRIPT)) as RawChecks;
}

function buildViewportReport(
  name: string,
  width: number,
  height: number,
  screenshot: string,
  raw: RawChecks,
  consoleErrors: string[],
  keyboard: { ok: boolean; focused: string[] },
): ViewportReport {
  const issues: InspectIssue[] = [];
  const overflowOk = raw.scrollWidth <= raw.innerWidth + 1;
  if (!overflowOk) {
    issues.push({
      viewport: name,
      check: 'overflow',
      message: `页面横向溢出：scrollWidth ${raw.scrollWidth}px > 视口 ${raw.innerWidth}px。越界元素：${
        raw.overflow.map((item) => `${item.selector} (right ${item.right}px)`).join('，') || '未定位到单一元素'
      }`,
    });
  }
  if (raw.truncation.length > 0) {
    issues.push({
      viewport: name,
      check: 'truncation',
      message: `文字被容器裁切：${raw.truncation
        .map((item) => `${item.selector}「${item.text}」`)
        .join('；')}`,
    });
  }
  for (const image of raw.brokenImages) {
    issues.push({
      viewport: name,
      check: 'images',
      message: `图片加载失败：${image.src || '(空 src)'}`,
      selector: image.selector,
    });
  }
  for (const error of consoleErrors) {
    issues.push({ viewport: name, check: 'console', message: `控制台错误：${error}` });
  }
  const primaryOk = raw.primary.inViewport > 0;
  if (!primaryOk) {
    issues.push({
      viewport: name,
      check: 'primaryAction',
      message: '首屏没有可见的主操作（按钮或链接），用户不知道下一步做什么。',
    });
  }
  if (!keyboard.ok) {
    issues.push({
      viewport: name,
      check: 'keyboard',
      message:
        raw.focusable === 0
          ? '页面没有可见的可聚焦元素，键盘用户无法操作。'
          : '按 Tab 后焦点没有移动到可见元素，键盘导航可能被阻断。',
    });
  }

  return {
    name,
    width,
    height,
    screenshot,
    checks: {
      overflow: { ok: overflowOk, scrollWidth: raw.scrollWidth, innerWidth: raw.innerWidth, offenders: raw.overflow },
      truncation: { ok: raw.truncation.length === 0, items: raw.truncation },
      images: { ok: raw.brokenImages.length === 0, broken: raw.brokenImages },
      console: { ok: consoleErrors.length === 0, errors: consoleErrors },
      primaryAction: { ok: primaryOk, visible: raw.primary.visible, inViewport: raw.primary.inViewport },
      keyboard: { ok: keyboard.ok, focusable: raw.focusable, focused: keyboard.focused },
    },
    issues,
  };
}

async function writeReport(taskDir: string, report: AcceptanceReport): Promise<string> {
  await mkdir(join(taskDir, ACCEPTANCE_DIR), { recursive: true });
  const target = join(taskDir, REPORT_FILE);
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return REPORT_FILE;
}

function unavailableReport(options: {
  route: Route;
  taskId?: string;
  chrome: ChromeInfo;
  now: string;
}): AcceptanceReport {
  const reason = options.chrome.reason ?? '本机 Chrome 不可用。';
  const issue: InspectIssue = { viewport: 'browser', check: 'browser', message: reason };
  return {
    version: 1,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    route: options.route,
    generatedAt: options.now,
    browser: {
      available: false,
      ...(options.chrome.path ? { path: options.chrome.path } : {}),
      reason,
      candidates: options.chrome.candidates,
    },
    viewports: [],
    passed: false,
    issueCount: 1,
    issues: [issue],
  };
}

export async function inspectTask(options: {
  taskDir: string;
  route: Route;
  taskId?: string;
  chrome?: string;
  timeoutMs?: number;
  now?: string;
}): Promise<InspectResult> {
  const now = options.now ?? new Date().toISOString();
  const chrome = findChrome(options.chrome);
  if (!chrome.available || !chrome.path) {
    const report = unavailableReport({ route: options.route, ...(options.taskId ? { taskId: options.taskId } : {}), chrome, now });
    const reportPath = await writeReport(options.taskDir, report);
    return { report, reportPath, exitCode: 4 };
  }

  const previewFile = join(options.taskDir, '预览', 'index.html');
  if (!existsSync(previewFile)) {
    throw new Error('找不到 预览/index.html，无法运行浏览器验收。');
  }

  await mkdir(join(options.taskDir, ACCEPTANCE_DIR), { recursive: true });
  const server = await startPreviewServer(join(options.taskDir, '预览'));
  let browser: Browser | undefined;

  try {
    try {
      browser = await chromium.launch({ executablePath: chrome.path, headless: true });
    } catch (error) {
      const reason = `本机 Chrome 启动失败：${error instanceof Error ? error.message : String(error)}`;
      const report = unavailableReport({
        route: options.route,
        ...(options.taskId ? { taskId: options.taskId } : {}),
        chrome: { ...chrome, available: false, reason },
        now,
      });
      const reportPath = await writeReport(options.taskDir, report);
      return { report, reportPath, exitCode: 4 };
    }

    const viewports: ViewportReport[] = [];
    for (const viewport of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => consoleErrors.push(`Uncaught ${error.message}`));

      let navigationError: string | null = null;
      try {
        await page.goto(server.url, { waitUntil: 'load', timeout: options.timeoutMs ?? 15000 });
      } catch (error) {
        navigationError = error instanceof Error ? error.message : String(error);
      }
      await page.waitForTimeout(200);

      const raw = await collectRawChecks(page);
      const focused: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        await page.keyboard.press('Tab');
        const active = await page.evaluate(`(() => {
          const element = document.activeElement;
          if (!element || !element.tagName) return null;
          const id = element.id ? '#' + element.id : '';
          return element.tagName.toLowerCase() + id;
        })()`) as string | null;
        if (active && active !== 'body' && !focused.includes(active)) focused.push(active);
      }
      const screenshot = `${ACCEPTANCE_DIR}/${viewport.name}.png`;
      await page.screenshot({ path: join(options.taskDir, screenshot), fullPage: true });

      const report = buildViewportReport(
        viewport.name,
        viewport.width,
        viewport.height,
        screenshot,
        raw,
        [...new Set(consoleErrors)],
        { ok: raw.focusable > 0 && focused.length > 0, focused },
      );
      if (navigationError) {
        report.issues.push({
          viewport: viewport.name,
          check: 'navigation',
          message: `页面加载失败：${navigationError}`,
        });
      }
      viewports.push(report);
      await page.close();
    }

    const issues = viewports.flatMap((viewport) => viewport.issues);
    const report: AcceptanceReport = {
      version: 1,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      route: options.route,
      generatedAt: now,
      browser: { available: true, path: chrome.path, name: 'Local Google Chrome' },
      viewports,
      passed: issues.length === 0,
      issueCount: issues.length,
      issues,
    };
    const reportPath = await writeReport(options.taskDir, report);
    return { report, reportPath, exitCode: report.passed ? 0 : 1 };
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }
}
