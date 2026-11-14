/// <reference lib="webworker" />
import { decodeDataTable } from './dataTableDecoder';
import { DataPreviewError } from './dataFilePreview';
import { dataTableRequestSchema, type DataTableResponse } from './dataTableProtocol';

self.onmessage = async ({ data }: MessageEvent<unknown>) => {
  const parsed = dataTableRequestSchema.safeParse(data);
  let response: DataTableResponse;
  try {
    if (!parsed.success) throw new DataPreviewError('invalid');
    response = { ok: true, table: await decodeDataTable(parsed.data) };
  } catch (error) {
    const reason = error instanceof DataPreviewError && error.reason !== 'timeout' && error.reason !== 'workerUnavailable' ? error.reason : 'invalid';
    response = { ok: false, reason };
  }
  self.postMessage(response);
};
