import { afterEach, describe, expect, test } from 'bun:test';

import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '../runtime-url';
import { guestFileOperation } from './files';

const originalFetch = globalThis.fetch;
const originalResolver = getRuntimeUrlResolver();

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRuntimeUrlResolver(originalResolver);
});

describe('guest file request transport', () => {
  for (const { directory, header, marker } of [
    { directory: 'C:/工作/项目%20一', header: 'C%3A%2F%E5%B7%A5%E4%BD%9C%2F%E9%A1%B9%E7%9B%AE%2520%E4%B8%80', marker: 'uri' },
    { directory: 'C:/work/project%20one', header: 'C:/work/project%20one', marker: null },
    { directory: null, header: null, marker: null },
  ]) {
    test(`passes directory ${directory} through runtime header encoding`, async () => {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      const requests: Request[] = [];
      globalThis.fetch = async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ ok: true, result: { entries: [{ name: '方案.pdf', kind: 'file' }] } });
      };

      expect(await guestFileOperation('workbench', { op: 'list', path: '.' }, directory)).toEqual({
        ok: true, result: { entries: [{ name: '方案.pdf', kind: 'file' }] },
      });
      expect(requests).toHaveLength(1);
      const request = requests[0];
      expect(request.url).toBe('https://runtime.example/api/guests/workbench/files');
      expect(request.method).toBe('POST');
      expect(request.headers.get('content-type')).toBe('application/json');
      expect(request.headers.get('x-opencode-directory')).toBe(header);
      expect(request.headers.get('x-opencode-directory-encoding')).toBe(marker);
      expect(await request.json()).toEqual({ op: 'list', path: '.' });
    });
  }

  test('retains an authoritative server denial', async () => {
    globalThis.fetch = async () => Response.json({ error: 'NOT_GRANTED', message: 'Filesystem access not granted.' }, { status: 403 });
    expect(await guestFileOperation('workbench', { op: 'list', path: 'C:/outside' }, null)).toEqual({
      ok: false, code: 'NOT_GRANTED', message: 'Filesystem access not granted.',
    });
  });

  test('reports a transport failure without an empty listing', async () => {
    globalThis.fetch = async () => { throw new Error('offline'); };
    expect(await guestFileOperation('workbench', { op: 'list', path: '.' }, 'C:/work')).toEqual({
      ok: false, code: 'HOST_REJECTED', message: 'File operation failed.',
    });
  });
});
