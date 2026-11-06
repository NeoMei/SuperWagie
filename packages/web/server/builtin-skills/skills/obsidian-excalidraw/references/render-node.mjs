// SuperWagie managed transport. The upstream renderer and fonts remain unchanged.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_JOB_BYTES = 51 * 1024 * 1024;
const BROWSER_ARGS = ['--disable-features=MacAppCodeSignClone', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--no-default-browser-check'];

export function requestAllowed(raw, origin, assets, method) {
  if (method !== 'GET' || raw.includes('%') || raw.includes('/../') || raw.includes('/./')) return false;
  try {
    const url = new URL(raw);
    return url.origin === origin && url.protocol === 'http:' && !url.username && !url.password && !url.search && !url.hash && assets.has(url.pathname);
  } catch { return false; }
}

export async function selectBrowser(explicit, env = process.env, platform = process.platform) {
  const selected = explicit || env.CHROME_PATH;
  const candidates = selected ? [selected] : platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : platform === 'win32'
      ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).flatMap(root => [path.join(root, 'Google/Chrome/Application/chrome.exe'), path.join(root, 'Microsoft/Edge/Application/msedge.exe')])
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
  for (const candidate of candidates) {
    try {
      if (!path.isAbsolute(candidate)) continue;
      const resolved = await fs.realpath(candidate);
      if (!(await fs.stat(resolved)).isFile()) continue;
      if (platform !== 'win32') await fs.access(resolved, fs.constants.X_OK);
      return resolved;
    } catch { /* Try only discovery candidates; an explicit binding has one. */ }
  }
  throw new Error('Host browser unavailable. Select an existing supported Chrome or Edge with --browser /absolute/path; SuperWagie does not download browsers.');
}

export async function validateDriver(directory) {
  const normalized = directory.split(path.sep).join('/');
  const suffix = ['/superweb/vendor/node_modules/playwright-core', '/superweb/node_modules/playwright-core'].find(value => normalized.endsWith(value));
  if (!path.isAbsolute(directory) || !suffix || normalized.includes('/app.asar/')) throw new Error('Managed preview requires the app-owned physical SuperWeb driver');
  const owner = directory.slice(0, -suffix.length);
  let current = owner;
  for (const segment of suffix.split('/').filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Managed driver contains a linked directory');
  }
  const physical = await fs.realpath(directory);
  for (const name of ['package.json', 'index.mjs', 'LICENSE', 'NOTICE']) {
    const file = path.join(directory, name);
    if (!(await fs.stat(file)).isFile() || path.dirname(await fs.realpath(file)) !== physical) throw new Error('Managed driver entry escapes its owned package');
  }
  const identity = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  if (identity.name !== 'playwright-core' || identity.version !== '1.64.1') throw new Error('Managed preview requires app-owned Playwright 1.64.1; repair the application');
  return path.join(physical, 'index.mjs');
}

function validateJob(job) {
  if (job.cancel !== job.output + '.cancel') throw new Error('Invalid preview cancellation path');
  const origin = new URL(job.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.origin !== job.origin) throw new Error('Invalid local preview origin');
  if (!path.isAbsolute(job.output) || !path.basename(job.output).startsWith('.excalidraw-')) throw new Error('Invalid temporary preview output');
  for (const [value, maximum] of [[job.scale, 8], [job.maxWidth, 2400], [job.maxHeight, 12000], [job.maxPixels, 32_000_000], [job.viewport?.width, 2400], [job.viewport?.height, 12000]]) {
    if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new Error('Invalid preview bounds');
  }
  if (!Array.isArray(job.scene?.elements) || job.scene.elements.filter(element => !element.isDeleted).length > 10_000) throw new Error('Invalid preview scene');
  if (job.viewport.width * job.viewport.height * job.scale ** 2 > job.maxPixels) throw new Error('Preview surface exceeds pixel limit');
}

export function rasterFits(bounds, scale, maxPixels) {
  return Boolean(bounds) && [bounds.width, bounds.height, scale, maxPixels].every(value => Number.isFinite(value) && value > 0)
    && Math.ceil(bounds.width * scale) * Math.ceil(bounds.height * scale) <= maxPixels;
}

export async function preview(job) {
  validateJob(job);
  const entry = await validateDriver(job.driver);
  const executablePath = await selectBrowser(job.browser);
  const { chromium } = await import(pathToFileURL(entry).href);
  const inventory = JSON.parse(await fs.readFile(path.join(here, 'ASSET-MANIFEST.json'), 'utf8'));
  const assets = new Set(inventory.map(file => '/' + file.path));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())) delete env[key];
  let server, browser, profile, timer, hardTimer, cancelTimer, primaryFailure;
  // A normal Node exit runs Playwright's process-exit cleanup even while a
  // launch promise has not returned its BrowserServer yet. SIGKILL cannot.
  const interrupted = () => { console.error('Preview cancelled'); process.exit(1); };
  process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
  hardTimer = setTimeout(() => { console.error('Preview exceeded its hard deadline'); process.exit(1); }, 70_000);
  cancelTimer = setInterval(async () => { if (await fs.stat(job.cancel).catch(() => null)) interrupted(); }, 100);
  const denied = []; const fonts = new Set(); const errors = [];
  const result = { ok: false, route: 'managed-node', driverVersion: '1.64.1' };
  try {
    // Playwright owns this temporary profile and removes it after close/kill.
    server = await chromium.launchServer({ headless: true, executablePath, args: BROWSER_ARGS, env, timeout: 20_000, host: '127.0.0.1' });
    profile = server.process().spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
    result.browserPid = server.process().pid;
    result.profile = profile;
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 20_000 });
    result.browserVersion = browser.version();
    const work = async () => {
      const context = await browser.newContext({ viewport: job.viewport, deviceScaleFactor: job.scale, serviceWorkers: 'block' });
      await context.route('**/*', route => {
        if (!requestAllowed(route.request().url(), job.origin, assets, route.request().method())) {
          denied.push('request'); return route.abort();
        }
        return route.continue();
      });
      await context.routeWebSocket('**/*', socket => { denied.push('websocket'); socket.close(); });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(20_000);
      await page.addInitScript(() => {
        window.__previewViolations = 0;
        document.addEventListener('securitypolicyviolation', () => { window.__previewViolations++; });
      });
      page.on('pageerror', () => errors.push('page error'));
      page.on('requestfailed', () => errors.push('asset request failed'));
      page.on('response', response => {
        if (response.status() !== 200) errors.push('asset response failed');
        if (new URL(response.url()).pathname.endsWith('.woff2')) fonts.add(new URL(response.url()).pathname);
      });
      await page.goto(`${job.origin}/render.html`);
      await page.waitForFunction(() => window.__ready === true);
      const rendered = await page.evaluate(scene => window.renderDiagram(scene), job.scene);
      if (rendered?.ok !== true) throw new Error('Excalidraw could not render this scene');
      await page.evaluate(async () => { await document.fonts.ready; });
      const fontState = await page.evaluate(() => ({ failed: [...document.fonts].some(font => font.status === 'error'), violations: window.__previewViolations, textCount: document.querySelectorAll('#root svg text').length }));
      if (fontState.failed || fontState.violations || denied.length || errors.length || (fontState.textCount && !fonts.size)) throw new Error('Offline preview asset, font or network policy check failed');
      const svg = page.locator('#root svg');
      const bounds = await svg.boundingBox();
      if (!bounds || ![bounds.width, bounds.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('Preview SVG has invalid bounds');
      const ratio = Math.min(1, job.maxWidth / bounds.width, job.maxHeight / bounds.height, Math.sqrt(job.maxPixels / (Math.ceil(bounds.width * job.scale) * Math.ceil(bounds.height * job.scale))));
      if (ratio < 1) await svg.evaluate((element, size) => { element.style.width = `${size.width}px`; element.style.height = `${size.height}px`; }, { width: Math.max(1, Math.floor(bounds.width * ratio)), height: Math.max(1, Math.floor(bounds.height * ratio)) });
      // Preflight proves custom glyph use, beyond font file download success.
      if (job.preflight) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
        const { root } = await cdp.send('DOM.getDocument');
        const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '#root svg text' });
        const used = [];
        for (const nodeId of nodeIds) {
          const evidence = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
          used.push(...evidence.fonts.map(font => ({ family: font.familyName, custom: font.isCustomFont, glyphs: font.glyphCount })));
        }
        if (!used.some(font => font.custom && font.family.includes('Excalifont') && font.glyphs > 0) || !used.some(font => font.custom && font.family.includes('Xiaolai') && font.glyphs > 0) || used.some(font => !font.custom && font.glyphs > 0)) throw new Error('Preview preflight used fallback fonts');
        result.glyphs = used;
      }
      const finalBounds = await svg.boundingBox();
      if (!rasterFits(finalBounds, job.scale, job.maxPixels)) throw new Error('Preview screenshot exceeds pixel limit');
      await svg.screenshot({ path: job.output, timeout: 20_000, animations: 'disabled' });
      if (denied.length || errors.length || await page.evaluate(() => window.__previewViolations)) throw new Error('Offline preview attempted an unavailable or forbidden resource');
      result.fonts = [...fonts].sort(); result.deniedRequests = denied.length;
      result.ok = true;
      await context.close();
    };
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Preview exceeded its 40 second render deadline')), 40_000); });
    await Promise.race([work(), deadline]);
  } catch (error) {
    primaryFailure = error;
    // Driver exceptions may contain paths and request content. Report fixed errors.
    if (error instanceof Error && /^(Offline preview|Preview |Excalidraw )/.test(error.message)) throw error;
    throw new Error('Host browser could not complete the offline preview. Select a supported Chrome/Edge with --browser and run --preflight.');
  } finally {
    clearTimeout(timer); clearInterval(cancelTimer);
    process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted);
    if (server) {
      // kill() also waits for the driver's owned process and temporary directory cleanup.
      try {
        await server.kill();
        result.browserClosed = server.process().exitCode !== null || server.process().signalCode !== null;
        result.profileRemoved = !profile || !await fs.stat(profile).catch(() => null);
        if (!result.browserClosed || !result.profileRemoved) throw new Error('Preview browser cleanup failed');
      } catch {
        if (!primaryFailure) throw new Error('Preview browser cleanup failed');
        console.error('Preview browser cleanup also failed');
      }
    }
    clearTimeout(hardTimer);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let size = 0; const chunks = [];
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_JOB_BYTES) throw new Error('Preview job exceeds input limit');
      chunks.push(chunk);
    }
    console.log(JSON.stringify(await preview(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Preview failed'); process.exitCode = 1;
  }
}
