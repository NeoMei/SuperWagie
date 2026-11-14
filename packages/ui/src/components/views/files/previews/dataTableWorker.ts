import { DataPreviewError } from './dataFilePreview';
import { DATA_TABLE_TIMEOUT_MS, dataTableRequestSchema, dataTableResponseSchema, type DataTable, type DataTableRequest } from './dataTableProtocol';

/** Each page has a disposable CPU owner. Abort and timeout terminate the decoder. */
export const decodeTableInWorker = (request: DataTableRequest, signal: AbortSignal): Promise<DataTable> => {
  signal.throwIfAborted();
  const parsed = dataTableRequestSchema.safeParse(request);
  if (!parsed.success) return Promise.reject(new DataPreviewError('invalid'));
  if (!globalThis.Worker) return Promise.reject(new DataPreviewError('workerUnavailable'));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    // Vite recognizes this literal constructor and emits compiled Worker assets.
    try { worker = new Worker(new URL('./dataTable.worker.ts', import.meta.url), { type: 'module', name: 'data-file-preview' }); }
    catch { reject(new DataPreviewError('workerUnavailable')); return; }
    let done = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
    };
    const finish = (value: DataTable | Error) => {
      if (done) return;
      done = true;
      cleanup();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const abort = () => finish(new DOMException('Data file preview cancelled', 'AbortError'));
    const timer = window.setTimeout(() => finish(new DataPreviewError('timeout')), DATA_TABLE_TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      const answer = dataTableResponseSchema.safeParse(data);
      if (!answer.success) { finish(new DataPreviewError('invalid')); return; }
      finish(answer.data.ok ? answer.data.table : new DataPreviewError(answer.data.reason));
    };
    worker.onerror = (event) => { event.preventDefault(); finish(new DataPreviewError('invalid')); };
    worker.onmessageerror = () => finish(new DataPreviewError('invalid'));
    const bytes = new Uint8Array(parsed.data.bytes);
    const wasmBinary = parsed.data.wasmBinary ? new Uint8Array(parsed.data.wasmBinary) : undefined;
    try { worker.postMessage({ ...parsed.data, bytes, wasmBinary }, wasmBinary ? [bytes.buffer, wasmBinary.buffer] : [bytes.buffer]); }
    catch { finish(new DataPreviewError('invalid')); }
    if (signal.aborted) abort();
  });
};
