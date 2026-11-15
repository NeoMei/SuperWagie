import { describe, expect, test } from 'bun:test';
import { createServer, type RequestListener } from 'node:http';
import { z } from 'zod';
import { OfficePreviewSizeError, readBoundedResponseBytes, readOfficePreviewBytes } from './officePreviewBytes';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { setRuntimeBearerToken } from '@/lib/runtime-auth';

const read = (response: Response, signal = new AbortController().signal) => readBoundedResponseBytes(response, { maxBytes: 4, signal });

describe('bounded Office bytes', () => {
  test('rejects an oversized declaration and cancels the unconsumed body', async () => {
    let canceled = false;
    const response = new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'Content-Length': '5' } });
    await expect(read(response)).rejects.toBeInstanceOf(OfficePreviewSizeError);
    expect(canceled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  test('accepts exactly the limit, including a falsely small or invalid header', async () => {
    for (const header of ['4', '1', 'invalid']) {
      const response = new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Length': header } });
      expect(await read(response)).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(response.body?.locked).toBe(false);
    }
  });

  test('counts chunks when the header is missing or false and releases on overflow', async () => {
    for (const header of [null, '1']) {
      let canceled = false;
      const response = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(2)); },
        cancel() { canceled = true; },
      }), { headers: header === null ? undefined : { 'Content-Length': header } });
      await expect(read(response)).rejects.toBeInstanceOf(OfficePreviewSizeError);
      expect(canceled).toBe(true);
      expect(response.body?.locked).toBe(false);
    }
  });

  test('abort settles a blocked read, cancels it and releases the lock', async () => {
    let canceled = false;
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ cancel() { canceled = true; } }));
    const pending = read(response, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(canceled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  test('already aborted input is canceled and never becomes empty success', async () => {
    const controller = new AbortController();
    controller.abort();
    const response = new Response(new Uint8Array([1]));
    await expect(read(response, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(read(new Response(null))).rejects.toThrow();
  });

  test('stream errors remain errors and release the reader', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('disk failed')); } }));
    await expect(read(response)).rejects.toThrow('disk failed');
    expect(response.body?.locked).toBe(false);
  });
});

const withRawServer = async (handler: RequestListener, check: () => Promise<void>): Promise<void> => {
  const previous = getRuntimeUrlResolver();
  const server = createServer(handler);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = z.object({ port: z.number().int().min(1).max(65_535) }).parse(server.address());
    configureRuntimeUrlResolver({ apiBaseUrl: `http://127.0.0.1:${address.port}` });
    await check();
  } finally {
    setRuntimeUrlResolver(previous);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
};

describe('Office runtime file reads', () => {
  test('reads a document over 30 MiB through its authorized runtime without sending a size ceiling', async () => {
    const input = new Uint8Array(33_554_433).fill(17);
    input[0] = 80;
    input[input.length - 1] = 75;
    await withRawServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://office-fixture');
      if (url.pathname !== '/api/fs/raw'
        || url.searchParams.get('path') !== '/资料/汇报.pptx'
        || url.searchParams.get('directory') !== '/资料'
        || url.searchParams.get('allowOutsideWorkspace') !== 'true'
        || request.headers.authorization !== 'Bearer office-read-fixture') {
        response.writeHead(403).end();
        return;
      }
      if (url.searchParams.has('maxBytes')) {
        response.writeHead(413).end();
        return;
      }
      response.setHeader('Content-Length', input.byteLength);
      response.end(input);
    }, async () => {
      setRuntimeBearerToken('office-read-fixture');
      try {
        const bytes = await readOfficePreviewBytes({
          path: '/资料/汇报.pptx', directory: '/资料', allowOutsideWorkspace: true,
          signal: new AbortController().signal, readFailedMessage: 'Read failed',
        });
        expect(bytes.length).toBe(33_554_433);
        expect(bytes[0]).toBe(80);
        expect(bytes[16_777_216]).toBe(17);
        expect(bytes[33_554_432]).toBe(75);
      } finally {
        setRuntimeBearerToken(null);
      }
    });
  });

  test('an already retired Office read dispatches no request', async () => {
    let requests = 0;
    await withRawServer((_request, response) => { requests += 1; response.end('unused'); }, async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(readOfficePreviewBytes({ path: '/file.pptx', signal: controller.signal, readFailedMessage: 'Read failed' })).rejects.toMatchObject({ name: 'AbortError' });
      expect(requests).toBe(0);
    });
  });

  test('failed Office requests remain failures rather than empty documents', async () => {
    await withRawServer((_request, response) => { response.writeHead(503).end('unavailable'); }, async () => {
      await expect(readOfficePreviewBytes({ path: '/file.pptx', signal: new AbortController().signal, readFailedMessage: 'Runtime unavailable' })).rejects.toThrow('Runtime unavailable');
    });
  });
});
