import { describe, expect, mock, test } from 'bun:test';

type DictationSocketEvent = { data: string };
type SocketCloseEvent = { code?: number; reason?: string };
type StartFrame = { type: string; dictationId?: string; format?: string; options?: unknown };

class FakeDictationSocket {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: DictationSocketEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: SocketCloseEvent) => void) | null = null;
  readonly sent: StartFrame[] = [];
  close = mock(() => undefined);

  open(): void {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as StartFrame);
    const frame = this.sent[this.sent.length - 1];
    if (frame?.type === 'start') {
      this.onmessage?.({ data: JSON.stringify({ type: 'ack', dictationId: frame.dictationId }) });
    }
  }
}

const socket = new FakeDictationSocket();
mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: () => ({ websocket: (path: string) => `ws://example.test${path}` }),
}));
mock.module('@/lib/runtime-auth', () => ({ refreshRuntimeUrlAuthToken: async () => undefined }));
mock.module('@/lib/relay/runtime-socket', () => ({
  openRuntimeWebSocket: () => {
    queueMicrotask(() => socket.open());
    return socket;
  },
}));

const { DictationClient } = await import('./dictation-client');

describe('dictation start frame', () => {
  test('omits client provider options for server-resolved ASR', async () => {
    const client = new DictationClient();
    await client.startDictationStream('dictation-1', 'pcm16:16000:1');
    expect(socket.sent[0]).toEqual({ type: 'start', dictationId: 'dictation-1', format: 'pcm16:16000:1' });
    expect(socket.sent[0]).not.toHaveProperty('options');
    client.cancelAllForRuntimeSwitch();
  });
});
