import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const processRows = () => {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Unable to inspect owned engine processes');
  return result.stdout.trim().split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? { pid: Number(match[1]), parent: Number(match[2]), command: match[3] } : undefined;
  }).filter(Boolean);
};

export async function smokeIntelEngine({ app, receipt, source, stagedEngine }) {
  if (process.platform !== 'darwin') throw new Error('The Intel engine smoke requires macOS');
  const appPath = fs.realpathSync(path.resolve(app));
  const engine = path.join(appPath, 'Contents/Resources/opencode-cli');
  const manifest = JSON.parse(fs.readFileSync(path.join(engine, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '2.1.4');
  assert.equal(manifest.sourceCommit, '68bc26b7da1990ce10ffecfbc1e09eb13aa5d824');
  assert.deepEqual(manifest.runtime, { kind: 'electron-node24', serverOnly: true });
  assert.equal(manifest.arch, 'x64');
  for (const file of manifest.files) {
    assert.equal(digest(path.join(engine, file.path)), file.sha256, `Packaged engine changed: ${file.path}`);
    if (stagedEngine) assert.equal(digest(path.join(path.resolve(stagedEngine), file.path)), file.sha256, `Staged engine differs: ${file.path}`);
  }
  if (source) assert.match(source, /^[a-f0-9]{40}$/, 'Expected the immutable SuperWagie source SHA');
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-intel-engine-')));
  const project = path.join(temporary, 'project');
  const home = path.join(temporary, 'home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(temporary, 'tmp'));
  fs.writeFileSync(path.join(project, 'probe-read.txt'), 'INTEL_READ_OK\n');
  const password = randomBytes(24).toString('hex');
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const redact = (text) => text.replaceAll(password, '[REDACTED]').replaceAll(authorization, '[REDACTED]').replace(/server password \S+/g, 'server password [REDACTED]');
  const result = {
    passed: false, app: appPath, version: manifest.version, sourceCommit: source || null, opencodeSourceCommit: manifest.sourceCommit,
    bundleSha256: digest(path.join(engine, 'opencode.mjs')), runtime: null,
    checks: {}, requests: [], tools: [], fixtureRequests: 0, restarts: 0, cleanup: {},
    limits: ['Execution on this host does not establish acceptance on macOS 12 hardware.'],
  };
  let server;
  let logs = '';
  let port;
  let socket;
  const owned = new Map();
  let spawnError;
  const observeProcesses = () => {
    const rows = processRows();
    const engineRow = rows.find((row) => row.pid === server?.pid);
    if (engineRow && !owned.has(engineRow.pid)) owned.set(engineRow.pid, engineRow.command);
    let added;
    do {
      added = false;
      for (const row of rows) {
        const parent = rows.find((candidate) => candidate.pid === row.parent);
        if (parent && owned.get(parent.pid) === parent.command && row.pid !== process.pid && !owned.has(row.pid)) {
          owned.set(row.pid, row.command); added = true;
        }
      }
    } while (added);
    return rows;
  };
  const stop = async () => {
    observeProcesses();
    const isOwned = (pid) => processRows().some((row) => row.pid === pid && owned.get(pid) === row.command);
    if (server?.pid && isOwned(server.pid)) server.kill('SIGTERM');
    const deadline = Date.now() + 10000;
    while (server && server.exitCode === null && server.signalCode === null && Date.now() < deadline) await wait(100);
    if (server && server.exitCode === null && server.signalCode === null) {
      if (isOwned(server.pid)) { try { process.kill(server.pid, 'SIGKILL'); } catch {} }
    }
    observeProcesses();
    for (const [pid] of [...owned].reverse()) {
      if (!isOwned(pid)) continue;
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    await wait(250);
    for (const [pid] of owned) if (isOwned(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    server = undefined;
  };
  const tools = [
    ['read', { path: path.join(project, 'probe-read.txt') }],
    ['write', { path: path.join(project, 'probe-write.txt'), content: 'INTEL_WRITE_OK\n' }],
    ['shell', { command: 'printf "INTEL_SHELL_OK:%s" "${ELECTRON_RUN_AS_NODE-unset}"' }],
    ['glob', { pattern: '**/probe-*.txt', path: '.' }],
    ['grep', { pattern: 'INTEL_READ_OK', path: '.', include: '*.txt' }],
    ['compat_probe', {}],
  ];
  const fixture = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (!request.url.startsWith('/v1/chat/completions')) { response.writeHead(404); response.end(); return; }
      const modelCall = Array.isArray(body.tools) && body.tools.length > 0;
      if (modelCall) result.fixtureRequests++;
      const index = (body.messages || []).filter((message) => message.role === 'tool').length;
      const next = modelCall && index < tools.length ? tools[index] : undefined;
      const delta = next
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `compat-tool-${index}`, type: 'function', function: { name: next[0], arguments: JSON.stringify(next[1]) } }] }
        : { role: 'assistant', content: modelCall ? 'INTEL_SESSION_OK' : 'Local compatibility smoke' };
      const chunk = { id: 'chatcmpl-local-compatibility', object: 'chat.completion.chunk', created: 1, model: 'probe' };
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: next ? 'tool_calls' : 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch { response.writeHead(400); response.end(); }
  });
  try {
    await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
    const pluginDirectory = path.join(project, 'compat-plugin');
    fs.mkdirSync(pluginDirectory);
    fs.writeFileSync(path.join(pluginDirectory, 'package.json'), JSON.stringify({ name: 'superwagie-compat-plugin', version: '1.0.0', type: 'module', exports: './index.mjs' }));
    fs.writeFileSync(path.join(pluginDirectory, 'index.mjs'), `
import { Plugin } from '@opencode/plugin';
export default Plugin.define({
  id: 'superwagie-compat-plugin',
  async setup(context) {
    await context.tool.transform((editor) => editor.add({
      name: 'compat_probe', description: 'Return local plugin execution proof',
      input: {type:'object',properties:{},additionalProperties:false}, options:{codemode:false},
      execute: async () => ({content:'INTEL_PLUGIN_OK:' + (process.env.ELECTRON_RUN_AS_NODE ?? 'unset')})
    }));
  }
});
`);
    const config = {
      model: 'probe/probe', permission: { '*': 'allow' }, plugins: [pluginDirectory],
      providers: { probe: { name: 'Local fixture', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: 'local-fixture' }, models: { probe: { name: 'Local fixture', capabilities: { tools: true }, limit: { context: 128000, output: 4096 } } } } },
    };
    const env = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USER: process.env.USER || 'compat-test', SHELL: '/bin/sh', LANG: 'en_US.UTF-8',
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'), TMPDIR: path.join(temporary, 'tmp'),
      OPENCODE_PRINT_LOGS: '1', OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_LOCAL: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    };
    const runNode = (args) => {
      const probe = spawnSync(path.join(engine, 'node'), args, { env, cwd: project, encoding: 'utf8', timeout: 30000 });
      assert.equal(probe.status, 0, redact(probe.stderr || 'Node launcher failed'));
      return probe.stdout.trim();
    };
    result.runtime = JSON.parse(runNode(['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron,arch:process.arch,flag:process.env.ELECTRON_RUN_AS_NODE??null})']));
    assert.equal(result.runtime.electron, '43.8.4');
    assert.equal(result.runtime.arch, 'x64');
    assert.match(result.runtime.node, /^24\./);
    assert.equal(result.runtime.flag, null);
    const forkChild = path.join(temporary, 'fork-child.mjs');
    const forkParent = path.join(temporary, 'fork-parent.mjs');
    fs.writeFileSync(forkChild, 'process.send({flag:process.env.ELECTRON_RUN_AS_NODE??null,execPath:process.execPath});');
    fs.writeFileSync(forkParent, `import {fork} from 'node:child_process'; const child=fork(${JSON.stringify(forkChild)},[],{stdio:['ignore','ignore','pipe','ipc']}); child.once('message',(message)=>console.log(JSON.stringify(message)));`);
    const fork = JSON.parse(runNode([forkParent]));
    assert.equal(fork.flag, null);
    assert.equal(fork.execPath, path.join(engine, 'node'));
    result.checks.fork = true;
    const version = spawnSync(path.join(engine, 'opencode'), ['--version'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(version.status, 0, redact(version.stderr));
    assert.match(version.stdout.trim(), /^(?:opencode v)?2\.1\.4$/);
    const help = spawnSync(path.join(engine, 'opencode'), ['serve', '--help'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(help.status, 0, redact(help.stderr));
    assert.match(help.stdout, /hostname/);
    result.checks.cliVersionAndHelp = true;
    const unavailable = spawnSync(path.join(engine, 'opencode'), ['upgrade'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(unavailable.status, 64);
    result.checks.unsupportedCliExplicit = true;
    const api = async (method, route, body, extraHeaders = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method, headers: { authorization, 'content-type': 'application/json', 'x-opencode-directory': encodeURIComponent(project), ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
      });
      const raw = await response.text();
      result.requests.push({ method, route: route.split('?')[0], status: response.status });
      if (route === '/api/model' && response.status === 503 && raw.includes('Location plugins did not finish activating')) return undefined;
      assert.ok(response.ok, `${method} ${route.split('?')[0]} returned ${response.status}: ${redact(raw).slice(0, 500)}`);
      return raw ? JSON.parse(raw) : undefined;
    };
    const start = async () => {
      port = await freePort();
      server = spawn(path.join(engine, 'opencode'), ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { env, cwd: project, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      spawnError = undefined;
      server.once('error', (error) => { spawnError = error; });
      for (const stream of [server.stdout, server.stderr]) createInterface({ input: stream }).on('line', (line) => { logs = (logs + redact(line) + '\n').slice(-40000); });
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Packaged engine exited during startup: ${logs.slice(-2000)}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { authorization }, signal: AbortSignal.timeout(1000) });
          if (response.ok) { observeProcesses(); return; }
        } catch {}
        await wait(100);
      }
      throw new Error(`Packaged engine did not become ready: ${logs.slice(-2000)}`);
    };
    await start();
    // model.list waits for the real upstream plugin activation barrier.
    const catalogDeadline = Date.now() + 30000;
    let catalog;
    while (!catalog && Date.now() < catalogDeadline) {
      catalog = await api('GET', '/api/model');
      if (!catalog) await wait(250);
    }
    assert.ok(catalog, 'Location plugins did not finish activating within 30 seconds');
    const search = await api('GET', '/api/fs/find?query=probe-read&type=file');
    assert.ok(JSON.stringify(search).includes('probe-read.txt'), 'Ripgrep filesystem search did not find the project file');
    result.checks.filesystemSearch = true;
    const session = await api('POST', '/api/session', { title: 'Intel local engine smoke', model: { providerID: 'probe', id: 'probe' }, location: { directory: project } });
    const sessionID = session.data?.id;
    assert.ok(sessionID, 'Session creation returned no ID');
    await api('POST', `/api/session/${sessionID}/prompt`, { text: 'Run the local fixture tools and report completion.' });
    let messages;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await wait(200);
      messages = await api('GET', `/api/session/${sessionID}/message`);
      if (JSON.stringify(messages).includes('INTEL_SESSION_OK')) break;
    }
    assert.ok(Array.isArray(messages.data), 'Messages API must return its data array');
    result.tools = messages.data.filter(message => message.type === 'assistant').flatMap(message => {
      assert.ok(Array.isArray(message.content), 'Assistant messages must carry their content array');
      return message.content.filter(part => part.type === 'tool');
    }).map(tool => ({ name: tool.name, status: tool.state.status, content: tool.state.content, metadata: tool.state.metadata }));
    for (const [name] of tools) {
      const tool = result.tools.find((item) => item.name === name);
      assert.ok(tool, `Model did not execute ${name}`);
      assert.equal(tool.status, 'completed', `${name} failed: ${JSON.stringify(tool)}`);
    }
    const output = (name) => JSON.stringify(result.tools.find((tool) => tool.name === name).content);
    assert.ok(output('read').includes('INTEL_READ_OK'));
    assert.ok(output('shell').includes('INTEL_SHELL_OK:unset'));
    assert.ok(output('glob').includes('probe-read.txt'));
    assert.ok(output('grep').includes('INTEL_READ_OK'));
    assert.ok(output('compat_probe').includes('INTEL_PLUGIN_OK:unset'));
    assert.equal(fs.readFileSync(path.join(project, 'probe-write.txt'), 'utf8'), 'INTEL_WRITE_OK\n');
    assert.ok(JSON.stringify(messages).includes('INTEL_SESSION_OK'));
    result.checks.sessionToolsAndPlugin = true;
    const pty = await api('POST', '/api/pty', { command: '/bin/sh', args: [], cwd: project, title: 'Intel PTY probe' });
    const ptyID = pty.data?.id;
    assert.ok(ptyID, 'PTY creation returned no ID');
    const ticket = await api('POST', `/api/pty/${ptyID}/connect-token`, undefined, { 'x-opencode-ticket': '1' });
    const token = ticket.data?.ticket;
    assert.ok(token, 'PTY connection ticket missing');
    const websocketURL = new URL(`ws://127.0.0.1:${port}/api/pty/${ptyID}/connect`);
    websocketURL.searchParams.set('location[directory]', project);
    websocketURL.searchParams.set('ticket', token);
    socket = new WebSocket(websocketURL);
    let ptyText = '';
    socket.addEventListener('message', async (event) => { ptyText += await new Blob([event.data]).text(); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PTY WebSocket did not open')), 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('PTY WebSocket failed')); }, { once: true });
    });
    socket.send('printf "INTEL_PTY_%s:%s\\n" "OK" "${ELECTRON_RUN_AS_NODE-unset}"\n');
    const ptyDeadline = Date.now() + 10000;
    while (!ptyText.includes('INTEL_PTY_OK:unset') && Date.now() < ptyDeadline) await wait(100);
    assert.ok(ptyText.includes('INTEL_PTY_OK:unset'), 'PTY did not execute the shell command with a clean environment');
    socket.close(); socket = undefined;
    await api('DELETE', `/api/pty/${ptyID}`);
    result.checks.ptyWebsocket = true;
    await stop();
    await start();
    result.restarts++;
    const restored = await api('GET', `/api/session/${sessionID}/message`);
    assert.ok(JSON.stringify(restored).includes('INTEL_SESSION_OK'), 'Session was lost after a managed engine restart');
    result.checks.persistence = true;
    result.passed = true;
  } catch (error) {
    result.error = redact(error.stack || String(error));
    result.logTail = redact(logs.slice(-8000));
  } finally {
    socket?.close();
    await stop();
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    await wait(100);
    result.cleanup.remainingPIDs = processRows().filter((row) => owned.get(row.pid) === row.command).map((row) => row.pid);
    result.cleanup.fixtureClosed = !fixture.listening;
    result.cleanup.enginePortClosed = !port || await new Promise((resolve) => {
      const connection = net.connect(port, '127.0.0.1');
      connection.once('connect', () => { connection.destroy(); resolve(false); });
      connection.once('error', () => resolve(true));
    });
    fs.rmSync(temporary, { recursive: true, force: true });
    result.cleanup.profileRemoved = !fs.existsSync(temporary);
    if (result.cleanup.remainingPIDs.length || !result.cleanup.enginePortClosed) { result.passed = false; result.error ||= 'Owned engine processes or port survived cleanup'; }
    fs.mkdirSync(path.dirname(path.resolve(receipt)), { recursive: true });
    fs.writeFileSync(receipt, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (!result.passed) throw new Error(result.error || 'Intel local engine smoke failed');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith('--app=')) options.app = argument.slice(6);
    else if (argument.startsWith('--receipt=')) options.receipt = argument.slice(10);
    else if (argument.startsWith('--source=')) options.source = argument.slice(9);
    else if (argument.startsWith('--staged-engine=')) options.stagedEngine = argument.slice(16);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.app || !options.receipt) throw new Error('Usage: node scripts/smoke-intel-engine.mjs --app=/path/SuperWagie.app --receipt=/path/receipt.json [--source=SuperWagie-commit-SHA] [--staged-engine=/path/staged-opencode-cli]');
  smokeIntelEngine(options).then((result) => console.log(`Intel local engine smoke passed: ${result.tools.length} tools, plugin, PTY and restart persistence`)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
