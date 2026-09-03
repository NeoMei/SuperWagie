#!/usr/bin/env electron

import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { app, BrowserWindow, session } from 'electron';

import { consoleErrorText, evaluationDocument, validateBrowserObservation } from './html-browser-eval-contract.mjs';

const PAGES = ['index.html', 'project.html', 'data.html'];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

async function canonicalDirectory(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
  return canonical;
}

async function renderViewport({ siteRoot, outputRoot, name, width, height, browserSession, consoleErrors }) {
  const window = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  try {
    window.webContents.on('console-message', (details) => {
      const text = consoleErrorText(details);
      if (text) consoleErrors.push(`${name}:${text}`);
    });
    let navigationComplete = true;
    let mainVisible = true;
    for (const page of PAGES) {
      await window.loadFile(join(siteRoot, page));
      const observed = await window.webContents.executeJavaScript(`(() => {
        const main = document.querySelector('main');
        const links = [...document.querySelectorAll('nav a')].map((node) => new URL(node.href).pathname.split('/').pop()).sort();
        const rect = main?.getBoundingClientRect();
        return {
          visible: Boolean(main && rect && rect.width > 0 && rect.height > 0 && main.textContent.trim().length > 0),
          links,
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      })()`);
      mainVisible &&= observed.visible;
      navigationComplete &&= JSON.stringify(observed.links) === JSON.stringify([...PAGES].sort());
      if (page === 'index.html') {
        const image = await window.webContents.capturePage();
        await writeFile(join(outputRoot, `${name}.png`), image.toPNG(), { flag: 'wx', mode: 0o600 });
      }
    }
    return { mainVisible, navigationComplete };
  } finally {
    window.destroy();
  }
}

async function run() {
  const requestedSiteRoot = argument('--site-root');
  const requestedOutputRoot = argument('--output-root');
  const siteRoot = await canonicalDirectory(requestedSiteRoot, 'site root');
  if (!isAbsolute(requestedOutputRoot)) throw new Error('output root must be absolute');
  await mkdir(requestedOutputRoot, { recursive: true, mode: 0o700 });
  const outputRoot = await canonicalDirectory(requestedOutputRoot, 'output root');

  const browserSession = session.fromPartition(`superwagie-html-eval-${process.pid}`, { cache: false });
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const externalRequests = [];
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    const external = /^https?:/i.test(details.url);
    if (external) externalRequests.push(details.url);
    callback({ cancel: external });
  });
  const consoleErrors = [];
  const desktop = await renderViewport({
    siteRoot, outputRoot, name: 'desktop', width: 1440, height: 900, browserSession, consoleErrors,
  });
  const mobile = await renderViewport({
    siteRoot, outputRoot, name: 'mobile', width: 390, height: 844, browserSession, consoleErrors,
  });
  if (consoleErrors.length > 0) {
    process.stderr.write(`${JSON.stringify({ consoleErrors })}\n`);
  }
  const checks = validateBrowserObservation({ desktop, mobile, consoleErrors, externalRequests });
  const document = evaluationDocument({
    checks,
    executedAt: new Date().toISOString(),
    browserSource: `SuperWagie bundled Chromium browser runtime ${process.versions.chrome}`,
    runtimePlatform: process.platform,
    runtimeArch: process.arch,
  });
  await writeFile(join(outputRoot, 'evaluation.json'), `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await browserSession.clearStorageData();
  process.stdout.write(`${JSON.stringify({ checks, chromium: process.versions.chrome })}\n`);
}

app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
app.on('window-all-closed', () => {});
app.whenReady().then(run).then(() => app.quit()).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});
