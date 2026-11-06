import { describe, expect, test } from 'bun:test';
import { OfficePreviewSizeError, readBoundedResponseBytes } from './officePreviewBytes';

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
