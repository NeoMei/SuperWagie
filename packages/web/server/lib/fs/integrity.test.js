import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { validateHeaderValue } from 'node:http';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerFsRoutes } from './routes.js';

let root;
let workspace;
let outside;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-fs-integrity-')));
  workspace = path.join(root, 'workspace');
  outside = path.join(root, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const response = () => ({
  statusCode: 200, body: null, headers: new Map(),
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  send(body) { this.body = body; return this; },
  type(value) { this.setHeader('Content-Type', value); return this; },
  setHeader(name, value) { validateHeaderValue(name, value); this.headers.set(name.toLowerCase(), value); },
  getHeader(name) { return this.headers.get(name.toLowerCase()); },
});

const register = (options = {}) => {
  const routes = [];
  registerFsRoutes({
    get: (route, handler) => routes.push({ method: 'GET', route, handler }),
    post: (route, handler) => routes.push({ method: 'POST', route, handler }),
  }, {
    os: { ...os, homedir: () => root }, path, crypto,
    fsPromises: { ...fs, ...options.fsPromises },
    spawn() { throw new Error('This fixture forbids child processes'); },
    normalizeDirectoryPath: value => value,
    resolveProjectDirectory: async () => ({ directory: options.noProject ? null : workspace, requestedDirectory: options.requestedDirectory }),
    buildAugmentedPath: () => '', resolveGitBinaryForSpawn: () => '',
    openchamberUserConfigRoot: options.config ?? path.join(root, 'config'),
    managedChatsRoot: options.chats ?? path.join(root, 'chats'),
  });
  const handler = (method, route) => {
    const found = routes.find(item => item.method === method && item.route === route);
    expect(found, `registered ${method} ${route}`).toBeDefined();
    return found.handler;
  };
  return {
    post: async (route, body, query = {}) => {
      const res = response();
      await handler('POST', `/api/fs/${route}`)({ body, query }, res);
      return res;
    },
    upload: async (target, bytes, overwrite = false) => {
      const res = response();
      await handler('POST', '/api/fs/upload')({
        query: { path: target, overwrite: overwrite ? 'true' : undefined },
        headers: { 'content-type': 'application/octet-stream' },
        async *[Symbol.asyncIterator]() { yield bytes; },
      }, res);
      return res;
    },
    raw: async (target, { download, range, csp } = {}) => {
      const state = response();
      const chunks = [];
      const stream = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
      Object.assign(stream, {
        status(code) { state.statusCode = code; return stream; },
        json(body) { state.body = body; stream.end(); return stream; },
        type: state.type.bind(state), setHeader: state.setHeader.bind(state), getHeader: state.getHeader.bind(state),
      });
      if (csp) state.setHeader('Content-Security-Policy', csp);
      const finished = new Promise((resolve, reject) => { stream.on('finish', resolve); stream.on('error', reject); });
      await handler('GET', '/api/fs/raw')({ query: { path: target, download: download ? 'true' : undefined }, headers: { range } }, stream);
      await finished;
      return { ...state, bytes: Buffer.concat(chunks) };
    },
    serve: async (grant, target) => {
      const res = response();
      const entry = routes.find(item => item.method === 'GET' && item.route instanceof RegExp);
      await entry.handler({ params: { 0: grant, 1: target }, query: {} }, res);
      return res;
    },
  };
};
const mode = async target => (await fs.stat(target)).mode & 0o777;
const put = async (name, bytes = 'original', permissions) => {
  const target = path.join(workspace, name);
  await fs.writeFile(target, bytes);
  if (permissions !== undefined) await fs.chmod(target, permissions);
  return target;
};

describe('filesystem integrity', () => {
  it('creates empty files without replacing any existing destination entry', async () => {
    const api = register();
    const target = path.join(workspace, 'new.txt');
    expect((await api.post('create', { path: target })).body).toEqual({ success: true, path: target });
    expect(await fs.readFile(target, 'utf8')).toBe('');
    await put('existing.txt');
    await fs.mkdir(path.join(workspace, 'folder'));
    await fs.symlink(path.join(workspace, 'existing.txt'), path.join(workspace, 'link'));
    await fs.symlink(path.join(workspace, 'missing'), path.join(workspace, 'dangling'));
    for (const name of ['new.txt', 'existing.txt', 'folder', 'link', 'dangling']) {
      const res = await api.post('create', { path: path.join(workspace, name) });
      expect(res.statusCode).toBe(409);
      expect(res.body.reason).toBe('already-exists');
    }
    expect(await fs.readFile(path.join(workspace, 'existing.txt'), 'utf8')).toBe('original');
    expect((await fs.lstat(path.join(workspace, 'dangling'))).isSymbolicLink()).toBe(true);
    await expect(fs.stat(path.join(workspace, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a destination that appears immediately before exclusive creation', async () => {
    const target = path.join(workspace, 'racing.txt');
    const api = register({ fsPromises: { open: async (name, flags, ...rest) => {
      if (name === target) await fs.writeFile(name, 'competitor');
      return fs.open(name, flags, ...rest);
    } } });
    expect((await api.post('create', { path: target })).statusCode).toBe(409);
    expect(await fs.readFile(target, 'utf8')).toBe('competitor');
  });

  it('does not remove another entry after a create close failure', async () => {
    const target = path.join(workspace, 'close.txt');
    const api = register({ fsPromises: { open: async (...args) => {
      const handle = await fs.open(...args);
      return { close: async () => {
        await handle.close();
        await fs.unlink(target);
        await fs.writeFile(target, 'replacement');
        throw new Error('fixture close failure');
      } };
    } } });
    expect((await api.post('create', { path: target })).statusCode).toBe(500);
    expect(await fs.readFile(target, 'utf8')).toBe('replacement');
  });

  it('reports a failed exclusive open without creating or deleting a destination', async () => {
    const target = path.join(workspace, 'new.txt');
    const api = register({ fsPromises: { open: async () => { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); } } });
    const result = await api.post('create', { path: target });
    expect(result.statusCode).toBe(403);
    expect(result.body.reason).toBe('os-permission');
    expect(await fs.readdir(workspace)).toEqual([]);
  });

  it('keeps ordinary umask-derived defaults for every new-file operation', async () => {
    const reference = await put('reference');
    const expectedMode = await mode(reference);
    const api = register();
    const created = path.join(workspace, 'created');
    const written = path.join(workspace, 'written');
    const uploaded = path.join(workspace, 'uploaded');
    expect((await api.post('create', { path: created })).statusCode).toBe(200);
    expect((await api.post('write', { path: written, content: 'new' })).statusCode).toBe(200);
    expect((await api.upload(uploaded, Buffer.from('new'))).statusCode).toBe(200);
    expect(await mode(created)).toBe(expectedMode);
    expect(await mode(written)).toBe(expectedMode);
    expect(await mode(uploaded)).toBe(expectedMode);
  });

  it.each([0o755, 0o600])('preserves ordinary mode %i across save and binary overwrite', async permissions => {
    const target = await put('mode.txt', 'original', permissions);
    const api = register();
    expect((await api.post('write', { path: target, content: 'edited' })).statusCode).toBe(200);
    expect(await fs.readFile(target, 'utf8')).toBe('edited');
    expect(await mode(target)).toBe(permissions);
    expect((await api.upload(target, Buffer.from([0, 255, 1]), true)).statusCode).toBe(200);
    expect(await fs.readFile(target)).toEqual(Buffer.from([0, 255, 1]));
    expect(await mode(target)).toBe(permissions);
  });

  it('keeps staging restricted and restores bits removed during creation', async () => {
    const target = await put('target', 'original', 0o755);
    const stagedModes = [];
    const api = register({ fsPromises: { open: async (name, flags, permissions) => {
      // A stricter mode at open models umask without changing process-global state.
      const handle = await fs.open(name, flags, permissions & ~0o077);
      stagedModes.push((await handle.stat()).mode & 0o777);
      return handle;
    } } });
    expect((await api.post('write', { path: target, content: 'edited' })).statusCode).toBe(200);
    expect(await mode(target)).toBe(0o755);
    expect((await api.upload(target, Buffer.from('binary'), true)).statusCode).toBe(200);
    expect(await mode(target)).toBe(0o755);
    expect(stagedModes).toEqual([0o700, 0o700]);
  });

  it('keeps same-content inode and follows allowed destination symlinks', async () => {
    const target = await put('target', 'original', 0o755);
    const link = path.join(workspace, 'link');
    await fs.symlink(target, link);
    const before = await fs.stat(target);
    const api = register();
    await api.post('write', { path: link, content: 'original' });
    expect((await fs.stat(target)).ino).toBe(before.ino);
    expect((await api.post('write', { path: link, content: 'edited' })).statusCode).toBe(200);
    expect(await fs.readFile(target, 'utf8')).toBe('edited');
    expect(await mode(target)).toBe(0o755);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it.each(['writeFile', 'chmod', 'rename'])('preserves original bytes and mode after staging %s failure', async operation => {
    const target = await put('target', 'original', 0o600);
    const api = register({ fsPromises: { [operation]: async () => { throw new Error(`fixture ${operation} failure`); } } });
    expect((await api.post('write', { path: target, content: 'edited' })).statusCode).toBe(500);
    expect(await fs.readFile(target, 'utf8')).toBe('original');
    expect(await mode(target)).toBe(0o600);
    expect(await fs.readdir(workspace)).toEqual(['target']);
  });

  it.each(['chmod', 'rename'])('preserves original upload bytes and mode after %s failure', async operation => {
    const target = await put('target', 'original', 0o600);
    const api = register({ fsPromises: { [operation]: async () => { throw new Error(`fixture ${operation} failure`); } } });
    expect((await api.upload(target, Buffer.from([0, 255]), true)).statusCode).toBe(500);
    expect(await fs.readFile(target, 'utf8')).toBe('original');
    expect(await mode(target)).toBe(0o600);
    expect(await fs.readdir(workspace)).toEqual(['target']);
  });

  it('preserves a competing upload destination and treats post-publication cleanup failure as committed', async () => {
    const target = path.join(workspace, 'target');
    const racing = register({ fsPromises: { link: async (temp, destination) => {
      await fs.writeFile(destination, 'competitor');
      await fs.link(temp, destination);
    } } });
    expect((await racing.upload(target, Buffer.from('new'))).statusCode).toBe(409);
    expect(await fs.readFile(target, 'utf8')).toBe('competitor');
    expect(await fs.readdir(workspace)).toEqual(['target']);
    await fs.unlink(target);
    const cleanupFailure = register({ fsPromises: { unlink: async () => { throw new Error('fixture cleanup failure'); } } });
    expect((await cleanupFailure.upload(target, Buffer.from('committed'))).statusCode).toBe(200);
    expect(await fs.readFile(target, 'utf8')).toBe('committed');
  });

  it.each(['create', 'write'])('denies %s below an outside parent before any filesystem mutation', async operation => {
    await fs.symlink(outside, path.join(workspace, 'link'));
    const api = register();
    const res = await api.post(operation, { path: path.join(workspace, 'link', 'missing', 'file'), content: 'marker' });
    expect(res.statusCode).toBe(403);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.each(['create', 'write'])('fails %s when canonical base lookup is denied', async operation => {
    const api = register({ fsPromises: { realpath: async target => {
      if (target === workspace) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
      return fs.realpath(target);
    } } });
    const result = await api.post(operation, { path: path.join(workspace, 'new'), content: 'marker' });
    expect(result.statusCode).toBe(403);
    expect(await fs.readdir(workspace)).toEqual([]);
  });

  it.each(['create', 'write'])('allows %s under an internal parent and symlinked workspace with missing directories', async operation => {
    const inside = path.join(workspace, 'inside');
    await fs.mkdir(inside);
    await fs.symlink(inside, path.join(workspace, 'link'));
    const alias = path.join(root, 'workspace-alias');
    await fs.symlink(workspace, alias);
    const target = path.join(alias, 'link', 'new', 'nested', 'file');
    const api = register({ requestedDirectory: alias });
    const res = await api.post(operation, { path: target, content: 'marker' });
    expect(res.body).toEqual({ success: true, path: target });
    expect(await fs.readFile(path.join(inside, 'new', 'nested', 'file'), 'utf8')).toBe(operation === 'create' ? '' : 'marker');
  });

  it('refuses a dangling write destination without replacing its link', async () => {
    const target = path.join(workspace, 'dangling');
    await fs.symlink(path.join(outside, 'missing'), target);
    expect((await register().post('write', { path: target, content: 'marker' })).statusCode).toBe(400);
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('accepts legal two-dot names but refuses parent traversal and adjacent roots', async () => {
    const api = register({ noProject: true, chats: workspace });
    for (const name of ['..notes', '..folder/notes']) {
      const res = await api.post('write', { path: path.join(workspace, name), content: 'marker' });
      expect(res.statusCode).toBe(200);
      expect(await fs.readFile(path.join(workspace, name), 'utf8')).toBe('marker');
    }
    for (const target of [path.join(workspace, '../outside/file'), `${workspace}-other/file`]) {
      expect((await api.post('write', { path: target, content: 'marker' })).statusCode).toBe(400);
    }
  });

  it.each(['line\nbreak.txt', 'carriage\rreturn.txt', 'quote"slash\\.txt', 'del\x7f.txt', '中文', "apostrophe'()*!.txt", 'plain.txt'])('streams a valid download header for %j', async name => {
    const target = await put(name, 'requested bytes');
    const res = await register().raw(target, { download: true });
    expect(res.statusCode).toBe(200);
    expect(res.bytes.toString()).toBe('requested bytes');
    const header = res.getHeader('content-disposition');
    expect(() => validateHeaderValue('Content-Disposition', header)).not.toThrow();
    const encoded = header.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encoded)).toBe(name);
    expect(encoded).not.toMatch(/['()*]/);
    expect(header).toMatch(/^attachment; filename="(?:[^"\\\x00-\x1f\x7f]|\\["\\])+"; filename\*=/);
    if (name === '中文') expect(header).toContain('filename="file"');
  });

  it.each(['html', 'svg', 'xml'])('sandboxes original raw %s bytes for full, empty and range responses', async ext => {
    const target = await put(`document.${ext}`, '<root>harmless</root>');
    const api = register();
    for (const range of [undefined, 'bytes=0-5']) {
      const res = await api.raw(target, { range, csp: "frame-ancestors 'self'" });
      expect(res.statusCode).toBe(range ? 206 : 200);
      expect(res.bytes.toString()).toBe(range ? '<root>' : '<root>harmless</root>');
      expect(res.getHeader('x-content-type-options')).toBe('nosniff');
      const csp = res.getHeader('content-security-policy');
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).toContain('sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads');
      expect(csp).not.toContain('allow-same-origin');
    }
    await fs.writeFile(target, '');
    const empty = await api.raw(target);
    expect(empty.bytes.length).toBe(0);
    expect(empty.getHeader('content-security-policy')).toContain('sandbox');
    expect(empty.getHeader('x-content-type-options')).toBe('nosniff');
  });

  it.each([['pdf', 'application/pdf'], ['mp4', 'video/mp4'], ['mp3', 'audio/mpeg'], ['woff2', 'font/woff2']])('retains %s MIME and range bytes without document sandbox', async (ext, mime) => {
    const target = await put(`asset.${ext}`, '0123456789');
    const res = await register().raw(target, { range: 'bytes=2-5' });
    expect(res.statusCode).toBe(206);
    expect(res.bytes.toString()).toBe('2345');
    expect(res.getHeader('content-type')).toBe(mime);
    expect(res.getHeader('content-range')).toBe('bytes 2-5/10');
    expect(res.getHeader('content-security-policy')).toBeUndefined();
  });

  it('adds an independently enforced sandbox when an earlier CSP permits same-origin', async () => {
    const target = await put('document.html', '<h1>harmless</h1>');
    const result = await register().raw(target, { csp: "frame-ancestors 'self'; sandbox allow-same-origin" });
    expect(result.getHeader('content-security-policy').split(', ')).toEqual([
      "frame-ancestors 'self'; sandbox allow-same-origin",
      'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads',
    ]);
  });

  it('scopes lexical and canonical managed page aliases to their parent for script reads', async () => {
    const managed = path.join(root, 'managed');
    const alias = path.join(root, 'managed-alias');
    await fs.mkdir(path.join(managed, 'page'), { recursive: true });
    await fs.symlink(managed, alias);
    await fs.writeFile(path.join(managed, 'page/index.html'), '<h1>harmless</h1>');
    await fs.writeFile(path.join(managed, 'page/asset.txt'), 'parent marker');
    await fs.writeFile(path.join(managed, 'neighbor.txt'), 'sibling marker');
    await fs.symlink(path.join(managed, 'neighbor.txt'), path.join(managed, 'page/link.txt'));
    const api = register({ config: alias });
    for (const base of [alias, managed]) {
      const minted = await api.post('preview', { path: path.join(base, 'page/index.html') });
      expect(minted.statusCode).toBe(200);
      const grant = minted.body.grant;
      const parent = await api.serve(grant, path.join(base, 'page/asset.txt'));
      expect(parent.statusCode).toBe(200);
      expect(parent.getHeader('access-control-allow-origin')).toBe('null');
      for (const name of ['neighbor.txt', 'page/link.txt']) {
        const sibling = await api.serve(grant, path.join(base, name));
        expect(sibling.statusCode).toBe(200);
        expect(sibling.getHeader('access-control-allow-origin')).toBeUndefined();
      }
    }
  });

  it('classifies a canonical managed root even if another configured root is unavailable', async () => {
    const managed = path.join(root, 'managed');
    const alias = path.join(root, 'managed-alias');
    const unavailable = path.join(root, 'unavailable');
    await fs.mkdir(path.join(managed, 'page'), { recursive: true });
    await fs.symlink(managed, alias);
    await fs.writeFile(path.join(managed, 'page/index.html'), '<h1>harmless</h1>');
    await fs.writeFile(path.join(managed, 'neighbor.txt'), 'marker');
    const api = register({ config: unavailable, chats: alias, fsPromises: { realpath: async target => {
      if (target === unavailable) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
      return fs.realpath(target);
    } } });
    const minted = await api.post('preview', { path: path.join(managed, 'page/index.html') });
    expect(minted.statusCode).toBe(200);
    const neighbor = await api.serve(minted.body.grant, path.join(managed, 'neighbor.txt'));
    expect(neighbor.statusCode).toBe(200);
    expect(neighbor.getHeader('access-control-allow-origin')).toBeUndefined();
  });
});
