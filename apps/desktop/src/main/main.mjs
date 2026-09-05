import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app, BrowserWindow, dialog, ipcMain, protocol,
} from 'electron';

import { CoreSupervisor } from './core-supervisor.mjs';
import { createResourceHandler } from './resource-protocol.mjs';
import { SurfacePolicy, SURFACE_CHANNELS } from './surface-policy.mjs';

protocol.registerSchemesAsPrivileged([
  { scheme: 'superwagie-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'superwagie-resource', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const moduleRoot = dirname(fileURLToPath(import.meta.url));

function assertBody(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error('SURFACE_BODY_REJECTED');
  }
  return body;
}

function registerStaticProtocol(runtimeRoot) {
  const assets = new Map([
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ]);
  protocol.handle('superwagie-app', async (request) => {
    const url = new URL(request.url);
    const asset = url.hostname === 'surface' ? assets.get(url.pathname) : null;
    if (!asset) return new Response('not found', { status: 404 });
    const [filename, contentType] = asset;
    const bytes = await readFile(join(runtimeRoot, 'dist', 'renderer', filename));
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': contentType, 'cache-control': 'no-store' },
    });
  });
}

export async function startDesktop({
  runtimeRoot = join(moduleRoot, '..', '..'),
  stateRoot = app.getPath('userData'),
  testProjectPath,
  show = true,
} = {}) {
  await app.whenReady();
  registerStaticProtocol(runtimeRoot);
  const surfacePolicy = new SurfacePolicy();
  let window;
  const binary = join(runtimeRoot, '..', '..', 'crates', 'product-core', 'target', 'debug', 'superwagie-product-core');
  const core = new CoreSupervisor({
    binary,
    stateRoot,
    onState(event) {
      if (event.state === 'resync_required' || event.state === 'degraded_read_only') {
        window?.webContents.send('workspace:subscription-event', {
          protocol_version: 1,
          message_type: 'subscription.resync_required',
          subscription_id: 'workspace:current',
          reason: event.reason === 'core_restarted' ? 'core_restarted' : 'projection_changed',
          next_action: 'query.execute',
        });
      }
    },
  });
  await core.start();

  let checkpointResolver;

  const credentials = surfacePolicy.issue();
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 680,
    show,
    backgroundColor: '#f4efe7',
    webPreferences: {
      preload: join(runtimeRoot, 'src', 'preload', 'bridge.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      additionalArguments: [
        `--surface-identity=${credentials.identity}`,
        `--surface-nonce=${credentials.nonce}`,
      ],
    },
  });
  const appUiContents = window.webContents;
  surfacePolicy.register(appUiContents, credentials);
  appUiContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  appUiContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  appUiContents.on('will-navigate', (event, url) => {
    if (url !== 'superwagie-app://surface/index.html') event.preventDefault();
  });
  appUiContents.on('will-attach-webview', (event) => event.preventDefault());
  appUiContents.on('destroyed', () => surfacePolicy.destroy(appUiContents));

  for (const channel of SURFACE_CHANNELS) {
    ipcMain.handle(channel, async (event, envelope) => {
      const body = surfacePolicy.validate(channel, event, envelope);
      if (channel === 'workspace:choose-project') {
        assertBody(body, []);
        let selectedRoot;
        if (!app.isPackaged && process.env.SUPERWAGIE_TEST_MODE === '1' && testProjectPath) {
          selectedRoot = testProjectPath;
        } else {
          const selected = await dialog.showOpenDialog(window, {
            title: '选择本地 Project', properties: ['openDirectory', 'createDirectory'],
          });
          if (selected.canceled) return core.request({ type: 'shell_select', selected_root: null });
          [selectedRoot] = selected.filePaths;
        }
        return core.request({ type: 'shell_select', selected_root: selectedRoot });
      }
      if (channel === 'workspace:activate-project') {
        const { projectId } = assertBody(body, ['projectId']);
        const projects = await core.request({
          type: 'query',
          request: {
            protocol_version: 1, message_type: 'query.execute', request_id: 'request:activate', query_id: 'project.list', params: {},
          },
        });
        const active = projects.payload.items.find((item) => item.project_id === projectId);
        if (!active) throw new Error('SW_GATEWAY_SCOPE_MISMATCH');
        return active;
      }
      if (channel === 'workspace:query' || channel === 'workspace:subscribe') {
        const { request } = assertBody(body, ['request']);
        return core.request({ type: 'query', request });
      }
      if (channel === 'workspace:draft') {
        if (body.operation === 'begin') {
          const value = assertBody(body, [
            'operation', 'documentId', 'baseRevision', 'expectedSize', 'expectedRevision', 'changeGeneration',
          ]);
          return core.request({
            type: 'draft_begin',
            document_id: value.documentId,
            base_revision: value.baseRevision,
            expected_size: value.expectedSize,
            expected_revision: value.expectedRevision,
            change_generation: value.changeGeneration,
          });
        }
        if (body.operation === 'append') {
          const value = assertBody(body, ['operation', 'uploadId', 'offset', 'contentHex']);
          return core.request({
            type: 'draft_append',
            upload_id: value.uploadId,
            offset: value.offset,
            content_hex: value.contentHex,
          });
        }
        if (body.operation === 'finish') {
          const value = assertBody(body, ['operation', 'uploadId']);
          return core.request({ type: 'draft_finish', upload_id: value.uploadId });
        }
        throw new Error('DRAFT_OPERATION_REJECTED');
      }
      if (channel === 'workspace:checkpoint-ready') {
        const { result } = assertBody(body, ['result']);
        checkpointResolver?.(result);
        checkpointResolver = undefined;
        return { status: 'received' };
      }
      const { intent } = assertBody(body, ['intent']);
      return core.request({ type: 'renderer_intent', intent });
    });
  }
  protocol.handle('superwagie-resource', createResourceHandler({ core, surfacePolicy }));
  await window.loadURL('superwagie-app://surface/index.html');

  let closed = false;
  let closing = false;
  window.on('close', (event) => {
    if (!closing && !closed) {
      event.preventDefault();
      app.quit();
    }
  });
  return {
    app,
    window,
    core,
    async close() {
      if (closed) return true;
      closing = true;
      const checkpoint = await new Promise((resolveCheckpoint) => {
        const timer = setTimeout(() => resolveCheckpoint({ ok: false, code: 'CHECKPOINT_TIMEOUT' }), 5_000);
        checkpointResolver = (result) => {
          clearTimeout(timer);
          resolveCheckpoint(result);
        };
        appUiContents.send('workspace:checkpoint-request');
      });
      if (!checkpoint?.ok) {
        closing = false;
        return false;
      }
      closed = true;
      for (const channel of SURFACE_CHANNELS) ipcMain.removeHandler(channel);
      protocol.unhandle('superwagie-resource');
      protocol.unhandle('superwagie-app');
      if (!window.isDestroyed()) window.destroy();
      await core.shutdown();
      return true;
    },
  };
}
