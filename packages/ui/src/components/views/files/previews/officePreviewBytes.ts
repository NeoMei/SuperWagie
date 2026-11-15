import { runtimeFetch } from '@/lib/runtime-fetch';

export class OfficePreviewSizeError extends Error {
  constructor() {
    super('Office preview exceeds its byte limit');
    this.name = 'OfficePreviewSizeError';
  }
}

/** Enforce declared and actual input size before a viewer receives whole bytes. */
export const readBoundedResponseBytes = async (
  response: Response,
  { maxBytes, signal }: { maxBytes: number; signal: AbortSignal },
): Promise<Uint8Array<ArrayBuffer>> => {
  const body = response.body;
  if (!body) throw new Error('File response has no body');
  if (signal.aborted || Number(response.headers.get('content-length')) > maxBytes) {
    void body.cancel().catch(() => {});
    signal.throwIfAborted();
    throw new OfficePreviewSizeError();
  }
  const reader = body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new OfficePreviewSizeError();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};

/** Office reads retain runtime authorization and cancellation without a byte ceiling. */
export const readOfficePreviewBytes = async ({
  path, directory, allowOutsideWorkspace, signal: callerSignal, readFailedMessage,
}: {
  path: string;
  directory?: string;
  allowOutsideWorkspace?: boolean;
  signal: AbortSignal;
  readFailedMessage: string;
}): Promise<Uint8Array<ArrayBuffer>> => {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(60_000)]);
  signal.throwIfAborted();
  const response = await runtimeFetch('/api/fs/raw', {
    signal,
    cache: 'no-store',
    query: { path, directory, allowOutsideWorkspace: allowOutsideWorkspace ? 'true' : undefined },
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(readFailedMessage);
  }
  return readBoundedResponseBytes(response, { maxBytes: Number.POSITIVE_INFINITY, signal });
};
