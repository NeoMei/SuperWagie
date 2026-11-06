import { describe, expect, it, mock } from 'bun:test';

const existingFiles = new Set();
const fsPromises = {
  realpath: mock(async (filePath) => {
    if (existingFiles.has(filePath)) return filePath;
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  }),
  stat: mock(async (filePath) => {
    if (existingFiles.has(filePath)) return { isFile: () => true, size: 4, mtimeMs: 1 };
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  }),
  readFile: mock(async () => Buffer.from('test')),
  open: mock(async () => {
    let read = false;
    return {
      stat: async () => ({ size: 4 }),
      read: async (buffer) => {
        if (read) return { bytesRead: 0 };
        read = true;
        buffer.set(Buffer.from('test'));
        return { bytesRead: 4 };
      },
      close: async () => {},
    };
  }),
};

mock.module('fs', () => ({
  promises: fsPromises,
  default: { promises: fsPromises },
}));

mock.module('vscode', () => ({
  Uri: {
    file: (fsPath) => ({ fsPath }),
  },
  workspace: {
    workspaceFolders: [
      { uri: { fsPath: '/workspace' } },
      { uri: { fsPath: '/workspace-two' } },
    ],
  },
}));

const { tryHandleLocalFsProxy } = await import('./bridge-localfs-proxy-runtime');

describe('bridge local fs proxy', () => {
  it('does not forward server-owned Markdown image grant routes to OpenCode', async () => {
    const response = await tryHandleLocalFsProxy('POST', '/api/openchamber/sessions/ses_1/markdown-image-grants');

    expect(response?.status).toBe(501);
    expect(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString('utf8'))
      .toContain('not supported in the VS Code runtime');
  });

  it('returns a quiet optional stat miss for missing files', async () => {
    const response = await tryHandleLocalFsProxy('GET', '/api/fs/stat?path=%2Fmissing.ts&optional=true');

    expect(response?.status).toBe(200);
    expect(JSON.parse(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString('utf8'))).toEqual({
      path: '/missing.ts',
      exists: false,
    });
  });

  it('keeps regular stat miss behavior without optional flag', async () => {
    const response = await tryHandleLocalFsProxy('GET', '/api/fs/stat?path=%2Fmissing.ts');

    expect(response?.status).toBe(404);
  });

  it('does not forward directory availability probes to OpenCode', async () => {
    const response = await tryHandleLocalFsProxy('GET', '/api/fs/directory-stat?path=%2Fmissing-dir');
    expect(response?.status).toBe(501);
  });

  it('reads from the active directory when it is the second workspace root', async () => {
    existingFiles.add('/workspace-two/image.png');
    const response = await tryHandleLocalFsProxy(
      'GET',
      '/api/fs/raw?path=%2Fworkspace-two%2Fimage.png&directory=%2Fworkspace-two',
    );

    expect(response?.status).toBe(200);
    expect(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString()).toBe('test');
  });

  it('rejects malformed raw preview limits before filesystem allocation', async () => {
    const reads = fsPromises.readFile.mock.calls.length;
    for (const limit of ['', '0', '-1', 'NaN', '1.5', '9007199254740992']) {
      const response = await tryHandleLocalFsProxy('GET', `/api/fs/raw?path=%2Fworkspace%2Flarge.xlsx&maxBytes=${limit}`);
      expect(response?.status).toBe(400);
    }
    expect(fsPromises.readFile.mock.calls.length).toBe(reads);
  });

  it('refuses an oversized preview before reading or base64 encoding the file', async () => {
    existingFiles.add('/workspace/large.xlsx');
    const reads = fsPromises.readFile.mock.calls.length;
    const response = await tryHandleLocalFsProxy('GET', '/api/fs/raw?path=%2Fworkspace%2Flarge.xlsx&maxBytes=3');
    expect(response?.status).toBe(413);
    expect(fsPromises.readFile.mock.calls.length).toBe(reads);
    expect(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString()).toContain('preview byte limit');
  });

  it('returns bounded small-file bytes with their actual length', async () => {
    existingFiles.add('/workspace/small.xlsx');
    const reads = fsPromises.readFile.mock.calls.length;
    const response = await tryHandleLocalFsProxy('GET', '/api/fs/raw?path=%2Fworkspace%2Fsmall.xlsx&maxBytes=4');
    expect(response?.status).toBe(200);
    expect(response?.headers['content-length']).toBe('4');
    expect(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString()).toBe('test');
    expect(fsPromises.readFile.mock.calls.length).toBe(reads);
  });
});
