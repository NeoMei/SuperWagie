import { BaseWindow, BrowserWindow, WebContentsView, ipcMain, session } from 'electron';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const WEB_PREFERENCES = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
});

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const IPC_LIMIT_BYTES = 4 * 1024;
const IPC_FIELDS = ['deadline_ms', 'identity', 'nonce', 'request_nonce'];
const CHANNEL_SURFACES = new Map([
  ['surface:probe', new Set(['app_ui', 'diagram_editor', 'artifact_preview'])],
  ['surface:snapshot', new Set(['app_ui'])],
]);

export class SurfaceManager {
  constructor({ root, core, selfTest = false }) {
    this.root = root;
    this.core = core;
    this.selfTest = selfTest;
    this.byWebContentsId = new Map();
    this.byType = new Map();
    this.counter = 0;
    this.coreQueryCount = 0;
    this.host = new BaseWindow({ show: false, width: 800, height: 600 });
    this.installIpcHandlers();
  }

  installIpcHandlers() {
    ipcMain.handle('surface:probe', async (event, payload) => {
      try {
        const record = this.validateSender('surface:probe', event, payload);
        return { identity: record.identity, type: record.type, origin: new URL(event.senderFrame.url).origin, authenticated: true };
      } catch (error) { return { __rejected: true, code: error.message }; }
    });
    ipcMain.handle('surface:snapshot', async (event, payload) => {
      try {
        this.validateSender('surface:snapshot', event, payload);
        this.coreQueryCount += 1;
        return this.core.request({ type: 'query', query_id: 'shell.snapshot', after_cursor: null });
      } catch (error) { return { __rejected: true, code: error.message }; }
    });
  }

  validateSender(channel, event, payload) {
    const record = this.byWebContentsId.get(event.sender.id);
    if (!record || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('SURFACE_SENDER_REJECTED');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Buffer.byteLength(JSON.stringify(payload)) > IPC_LIMIT_BYTES
      || Object.keys(payload).sort().join('\0') !== IPC_FIELDS.join('\0')
      || typeof payload.identity !== 'string' || typeof payload.nonce !== 'string'
      || typeof payload.request_nonce !== 'string' || !/^[a-f0-9]{24}$/.test(payload.request_nonce)
      || !Number.isSafeInteger(payload.deadline_ms)) throw new Error('SURFACE_SCHEMA_REJECTED');
    if (record.identity !== payload.identity || record.nonce !== payload.nonce) throw new Error('SURFACE_IDENTITY_REJECTED');
    if (payload.deadline_ms <= Date.now() || payload.deadline_ms > Date.now() + 5_000) throw new Error('SURFACE_DEADLINE_REJECTED');
    if (!CHANNEL_SURFACES.get(channel)?.has(record.type)) throw new Error('SURFACE_CHANNEL_REJECTED');
    const url = new URL(event.senderFrame.url);
    if (url.protocol !== 'superwagie-app:' || url.hostname !== 'surface' || url.pathname !== '/index.html') {
      throw new Error('SURFACE_ORIGIN_REJECTED');
    }
    if (record.requestNonces.has(payload.request_nonce)) throw new Error('SURFACE_REPLAY_REJECTED');
    record.requestNonces.add(payload.request_nonce);
    return record;
  }

  async create(type) {
    this.counter += 1;
    const identity = `${type}:surface-${this.counter}`;
    const nonce = randomBytes(16).toString('hex');
    const partition = `solution-b-${type}-${this.counter}-${randomBytes(6).toString('hex')}`;
    const ses = session.fromPartition(partition, { cache: false });
    const counters = {
      navigationDenied: 0,
      windowOpenDenied: 0,
      permissionDenied: 0,
      downloadDenied: 0,
      blockedRemoteRequests: 0,
      allowedRemoteRequests: 0,
      allSchemeRequestCount: 0,
    };
    await this.configureSession(ses, counters);
    const preferences = {
      ...WEB_PREFERENCES,
      session: ses,
      preload: join(this.root, 'src', 'surface-preload.cjs'),
      additionalArguments: [
        `--surface-identity=${identity}`, `--surface-nonce=${nonce}`,
        `--surface-type=${type}`,
        ...(this.selfTest ? ['--surface-self-test=true'] : []),
      ],
      webviewTag: false,
      allowRunningInsecureContent: false,
    };
    let owner;
    let webContents;
    if (type === 'app_ui') {
      owner = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: preferences });
      webContents = owner.webContents;
    } else {
      owner = new WebContentsView({ webPreferences: preferences });
      owner.setBounds({ x: type === 'diagram_editor' ? 0 : 400, y: 0, width: 400, height: 600 });
      this.host.contentView.addChildView(owner);
      webContents = owner.webContents;
    }
    const record = {
      type,
      identity,
      nonce,
      partition,
      ephemeral: !partition.startsWith('persist:'),
      session: ses,
      owner,
      webContents,
      counters,
      web_preferences: { ...WEB_PREFERENCES },
      requestNonces: new Set(),
    };
    this.byWebContentsId.set(webContents.id, record);
    this.byType.set(type, record);
    webContents.on('will-navigate', (event) => {
      event.preventDefault();
      counters.navigationDenied += 1;
    });
    webContents.setWindowOpenHandler(() => {
      counters.windowOpenDenied += 1;
      return { action: 'deny' };
    });
    await webContents.loadURL(`superwagie-app://surface/index.html?type=${encodeURIComponent(type)}&identity=${encodeURIComponent(identity)}`);
    return record;
  }

  async configureSession(ses, counters) {
    const surfaceHtml = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'self'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'"><title>SuperWagie isolated surface</title></head><body><main aria-label="isolated surface"></main><iframe id="ipc-subframe" src="superwagie-app://surface/subframe.html"></iframe><script src="superwagie-app://surface/surface.js"></script></body></html>`;
    const subframeHtml = '<!doctype html><html><body>isolated subframe</body></html>';
    const surfaceScript = await readFile(join(this.root, 'src', 'static', 'surface.js'));
    await ses.protocol.handle('superwagie-app', async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'surface') return new Response('not found', { status: 404 });
      if (url.pathname === '/subframe.html') return new Response(subframeHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (url.pathname === '/surface.js') {
        return new Response(surfaceScript, {
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            'content-security-policy': "default-src 'none'",
            'x-content-type-options': 'nosniff',
          },
        });
      }
      return new Response(surfaceHtml, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'self'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'",
          'x-content-type-options': 'nosniff',
        },
      });
    });
    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
      counters.permissionDenied += 1;
      callback(false);
    });
    ses.on('will-download', (event) => {
      counters.downloadDenied += 1;
      event.preventDefault();
    });
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      counters.allSchemeRequestCount += 1;
      const scheme = new URL(details.url).protocol;
      const remote = !['superwagie-app:', 'data:', 'blob:'].includes(scheme);
      if (remote) counters.blockedRemoteRequests += 1;
      callback({ cancel: remote });
    });
  }

  async exercise(record) {
    const beforeUrl = record.webContents.getURL();
    const probe = await record.webContents.executeJavaScript('window.__surfaceProbe()');
    const windowOpenDenied = await record.webContents.executeJavaScript('window.__attemptWindowOpen()');
    await record.webContents.executeJavaScript('window.__attemptNavigation()');
    await pause(60);
    const navigationDenied = record.webContents.getURL() === beforeUrl && record.counters.navigationDenied > 0;
    const permissionState = await record.webContents.executeJavaScript('window.__permissionState()');
    await record.webContents.executeJavaScript('window.__attemptDownload()');
    await pause(60);
    const remoteFetch = await record.webContents.executeJavaScript('window.__attemptRemoteFetch()');
    await pause(60);
    return {
      type: record.type,
      identity: record.identity,
      partition: record.partition,
      ephemeral: record.ephemeral,
      web_preferences: record.web_preferences,
      node_unreachable: probe.hasNodeProcess === false && probe.hasRequire === false,
      raw_ipc_unreachable: probe.hasRawIpc === false,
      navigation_denied: navigationDenied,
      window_open_denied: windowOpenDenied && record.counters.windowOpenDenied > 0,
      permission_denied: permissionState === 'denied',
      download_denied: record.counters.downloadDenied > 0,
      remote_request_count: record.counters.allowedRemoteRequests,
      blocked_remote_requests: record.counters.blockedRemoteRequests,
      all_scheme_request_count: record.counters.allSchemeRequestCount,
      initial_domain_state: probe.initialDomainState,
      current_domain_state: probe.currentDomainState,
      initial_cookie: probe.initialCookie,
      current_cookie: probe.currentCookie,
      bridge_authenticated: probe.bridge.authenticated === true,
      remote_fetch_blocked: remoteFetch === 'blocked',
      raw_observations: {
        probe, counters: { ...record.counters }, before_url: beforeUrl,
        after_url: record.webContents.getURL(), permission_state: permissionState,
        window_open_result: windowOpenDenied, remote_fetch_result: remoteFetch,
      },
    };
  }

  async exerciseIpcAttacks({ appUi, diagram }) {
    if (!this.selfTest) throw new Error('SURFACE_SELF_TEST_DISABLED');
    const before = this.coreQueryCount;
    const attack = async (record, source) => record.webContents.executeJavaScript(`(async()=>{const r=await (${source});return r})()`);
    const unknownField = await attack(appUi, "window.superwagie.attack.invoke('surface:probe',{extra:true})");
    const wrongIdentity = await attack(appUi, "window.superwagie.attack.invoke('surface:probe',{identity:'forged:surface'})");
    const wrongNonce = await attack(appUi, "window.superwagie.attack.invoke('surface:probe',{nonce:'00000000000000000000000000000000'})");
    const expired = await attack(appUi, "window.superwagie.attack.invoke('surface:probe',{deadline_ms:Date.now()-1})");
    const replay = await appUi.webContents.executeJavaScript(`(async()=>{const p=window.superwagie.attack.payload({request_nonce:'111111111111111111111111'});await window.superwagie.attack.invoke('surface:probe',p);return window.superwagie.attack.invoke('surface:probe',p)})()`);
    const wrongSurface = await attack(diagram, "window.superwagie.attack.invoke('surface:snapshot')");
    const nonMainFrame = await appUi.webContents.executeJavaScript(`(async()=>{const frame=document.getElementById('ipc-subframe');for(let i=0;i<40&&!frame.contentWindow.superwagie;i++)await new Promise(r=>setTimeout(r,25));if(!frame.contentWindow.superwagie)return {__rejected:true,code:'SURFACE_BRIDGE_UNREACHABLE'};return frame.contentWindow.superwagie.attack.invoke('surface:probe')})()`);
    const records = [
      ['unknown_field', unknownField, 'SURFACE_SCHEMA_REJECTED'],
      ['wrong_identity', wrongIdentity, 'SURFACE_IDENTITY_REJECTED'],
      ['wrong_nonce', wrongNonce, 'SURFACE_IDENTITY_REJECTED'],
      ['expired', expired, 'SURFACE_DEADLINE_REJECTED'],
      ['replay', replay, 'SURFACE_REPLAY_REJECTED'],
      ['wrong_surface_channel', wrongSurface, 'SURFACE_CHANNEL_REJECTED'],
      ['non_main_frame', nonMainFrame, 'SURFACE_BRIDGE_UNREACHABLE'],
    ].map(([attack_name, response, expected_code]) => ({ attack_name, response, expected_code }));
    return {
      summary: {
        unknown_field_rejected: unknownField?.code === 'SURFACE_SCHEMA_REJECTED',
        wrong_identity_rejected: wrongIdentity?.code === 'SURFACE_IDENTITY_REJECTED',
        wrong_nonce_rejected: wrongNonce?.code === 'SURFACE_IDENTITY_REJECTED',
        expired_rejected: expired?.code === 'SURFACE_DEADLINE_REJECTED',
        replay_rejected: replay?.code === 'SURFACE_REPLAY_REJECTED',
        wrong_surface_channel_rejected: wrongSurface?.code === 'SURFACE_CHANNEL_REJECTED',
        non_main_frame_rejected: nonMainFrame?.code === 'SURFACE_BRIDGE_UNREACHABLE',
        core_queries_unchanged: this.coreQueryCount === before,
      },
      records,
      core_query_count_before: before,
      core_query_count_after: this.coreQueryCount,
    };
  }

  async setCoreStatus(status) {
    await Promise.all([...this.byType.values()].map(async (record) => {
      if (!record.webContents.isDestroyed()) await record.webContents.executeJavaScript(`window.__setCoreStatus?.(${JSON.stringify(status)})`);
    }));
  }

  async destroy(type) {
    const record = this.byType.get(type);
    if (!record) return null;
    this.byType.delete(type);
    this.byWebContentsId.delete(record.webContents.id);
    await record.session.clearStorageData();
    if (record.owner instanceof BrowserWindow) {
      record.owner.destroy();
    } else {
      this.host.contentView.removeChildView(record.owner);
      record.webContents.close();
    }
    await pause(30);
    return { identity: record.identity, destroyed: record.webContents.isDestroyed() };
  }

  async closeAll() {
    for (const type of [...this.byType.keys()]) await this.destroy(type);
    this.host.destroy();
    ipcMain.removeHandler('surface:probe');
    ipcMain.removeHandler('surface:snapshot');
  }
}

export { WEB_PREFERENCES };
