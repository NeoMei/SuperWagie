import { DataPreviewError } from './dataFilePreview';
import { readBoundedResponseBytes } from './officePreviewBytes';

let sqliteWasm: Uint8Array<ArrayBuffer> | null = null;

/** Vite stages the approved SQL.js WASM beside app assets; no CDN or decoder URL is accepted. */
export const loadSqlitePreviewWasm = async (signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> => {
  signal.throwIfAborted();
  if (sqliteWasm) return sqliteWasm;
  const { default: wasmUrl } = await import('sql.js/dist/sql-wasm-browser.wasm?url');
  signal.throwIfAborted();
  const response = await fetch(wasmUrl, { signal });
  if (!response.ok) throw new DataPreviewError('workerUnavailable');
  const bytes = await readBoundedResponseBytes(response, { maxBytes: 4 * 1024 * 1024, signal });
  signal.throwIfAborted();
  sqliteWasm = bytes;
  return bytes;
};
