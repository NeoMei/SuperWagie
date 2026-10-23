import { afterEach, describe, expect, test } from 'bun:test';
import { win32 } from 'node:path';

import { runGuestFileOperation } from '../../../../web/server/lib/guests/files.js';
import { createProjectDirectoryRuntime } from '../../../../web/server/lib/opencode/project-directory-runtime.js';
import { guestFileOperation } from './files';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// Only OS operations are substituted. Scope, grants, canonical containment,
// header encoding and server directory decoding use their real implementations.
const fsPromises = {
  realpath: async (path) => win32.normalize(path),
  stat: async () => ({ isDirectory: () => true }),
  readdir: async () => [],
};
const options = {
  op: 'list', projectDirectory: null, patterns: ['~/Documents/SuperWagie/**'],
  grants: ['filesystem'], homeDir: 'C:/Users/test', fsPromises, nodePath: win32,
};

describe('Windows guest file authorization', () => {
  test.each([
    { homeDir: 'C:/Users/test', path: 'C:/Users/test/Documents/SuperWagie/PPT/项目' },
    { homeDir: '//server/share/test', path: '//server/share/test/Documents/SuperWagie/PPT/项目' },
  ])('lists a declared home pattern without an open project: $path', async ({ homeDir, path }) => {
    const listed = [];
    expect(await runGuestFileOperation({
      ...options, homeDir, path,
      fsPromises: { ...fsPromises, readdir: async (absolute) => { listed.push(absolute); return []; } },
    })).toEqual({ ok: true, result: { entries: [] } });
    expect(listed).toEqual([win32.normalize(path)]);
  });

  test.each(['C:/Users/test/Documents/SuperWagie/work', '//server/share/work'])('refuses absolute access with only the project grant: %s', async (path) => {
    expect(await runGuestFileOperation({
      ...options, path, projectDirectory: path, grants: ['files'],
      fsPromises: { realpath: async () => { throw new Error('must refuse before accessing disk'); } },
    })).toMatchObject({ ok: false, code: 'NOT_GRANTED' });
  });

  test.each([
    'D:/Users/test/Documents/SuperWagie/work', 'C:/Users/test/Documents/SuperWagie-other/work',
    'C:/Users/test/Documents/SuperWagie/../secret', '//other/share/test/Documents/SuperWagie/work',
  ])('refuses paths outside the declared root: %s', async (path) => {
    expect(await runGuestFileOperation({ ...options, path })).toMatchObject({ ok: false, code: 'BAD_PATH' });
  });

  test('refuses a canonical path that escapes through a junction', async () => {
    expect(await runGuestFileOperation({
      ...options, path: 'C:/Users/test/Documents/SuperWagie/link',
      fsPromises: { ...fsPromises, realpath: async (path) => path.endsWith('link') ? 'C:\\outside' : win32.normalize(path) },
    })).toMatchObject({ ok: false, code: 'BAD_PATH' });
  });
});

describe('Windows directory header round trip', () => {
  test.each(['C:/工作/项目%20一', 'C:/work/project%20one'])('decodes only the marked directory: %s', async (directory) => {
    const runtime = createProjectDirectoryRuntime({ fsPromises, path: win32, normalizeDirectoryPath: (path) => path });
    const resolved = [];
    globalThis.fetch = async (_input, init) => {
      const headers = new Headers(init.headers);
      resolved.push(await runtime.resolveOptionalProjectDirectory({ get: (key) => headers.get(key) }));
      return Response.json({ ok: true, result: { entries: [] } });
    };
    expect(await guestFileOperation('workbench', { op: 'list', path: '.' }, directory)).toEqual({ ok: true, result: { entries: [] } });
    expect(resolved).toEqual([{
      directory: win32.normalize(directory), requestedDirectory: win32.normalize(directory), error: null,
    }]);
  });
});
