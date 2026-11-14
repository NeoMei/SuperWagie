import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';
import { DataPreviewError, dataPreviewByteLimit } from './dataFilePreview';
import { OfficePreviewSizeError } from './officePreviewBytes';
import { loadSqlitePreviewWasm } from './dataTableAssets';
import { decodeTableInWorker } from './dataTableWorker';
import { DATA_TABLE_ROWS, type DataTable } from './dataTableProtocol';

type PreviewReason = DataPreviewError['reason'] | 'readFailed';
type Source = { status: 'loading' } | { status: 'ready'; bytes: Uint8Array<ArrayBuffer> } | { status: 'error'; reason: PreviewReason };
type Decoded = { status: 'loading'; previous: DataTable | null } | { status: 'ready'; table: DataTable } | { status: 'error'; reason: PreviewReason; previous: DataTable | null };
const errorReason = (error: Error): PreviewReason => error instanceof DataPreviewError ? error.reason : error instanceof OfficePreviewSizeError ? 'tooLarge' : 'readFailed';

/** A page request runs in a disposable worker, against an in-memory copy of the authorized bytes. */
export const DataTableArtifact: React.FC<{
  kind: 'sqlite' | 'parquet';
  path: string;
  revision: number;
  sizeBytes: number | null;
  readBytes: (signal: AbortSignal, maxBytes: number) => Promise<Uint8Array>;
  download?: React.ReactNode;
}> = ({ kind, path, revision, sizeBytes, readBytes, download }) => {
  const { t } = useI18n();
  const readRef = React.useRef(readBytes);
  readRef.current = readBytes;
  const [source, setSource] = React.useState<Source>({ status: 'loading' });
  const [decoded, setDecoded] = React.useState<Decoded>({ status: 'loading', previous: null });
  const [selection, setSelection] = React.useState<{ table: string | null; page: number }>({ table: null, page: 0 });
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => {
    const controller = new AbortController();
    setSource({ status: 'loading' });
    setDecoded({ status: 'loading', previous: null });
    setSelection({ table: null, page: 0 });
    void readRef.current(controller.signal, dataPreviewByteLimit(kind)).then((bytes) => {
      controller.signal.throwIfAborted();
      if (bytes.byteLength > dataPreviewByteLimit(kind)) throw new DataPreviewError('tooLarge');
      setSource({ status: 'ready', bytes: new Uint8Array(bytes) });
    }).catch((error) => { if (!controller.signal.aborted) setSource({ status: 'error', reason: error instanceof Error ? errorReason(error) : 'readFailed' }); });
    return () => controller.abort();
  }, [attempt, kind, path, revision]);
  React.useEffect(() => {
    if (source.status !== 'ready') return;
    const controller = new AbortController();
    setDecoded((previous) => ({ status: 'loading', previous: previous.status === 'ready' ? previous.table : previous.previous }));
    void (async () => {
      try {
        const wasmBinary = kind === 'sqlite' ? await loadSqlitePreviewWasm(controller.signal) : undefined;
        controller.signal.throwIfAborted();
        const table = await decodeTableInWorker({ kind, bytes: source.bytes, wasmBinary, table: selection.table, page: selection.page }, controller.signal);
        controller.signal.throwIfAborted();
        setDecoded({ status: 'ready', table });
      } catch (error) {
        if (!controller.signal.aborted) setDecoded((previous) => ({ status: 'error', reason: error instanceof Error ? errorReason(error) : 'readFailed', previous: previous.status === 'ready' ? previous.table : previous.previous }));
      }
    })();
    return () => controller.abort();
  }, [kind, selection, source]);
  const table = decoded.status === 'ready' ? decoded.table : decoded.previous;
  const loading = source.status === 'loading' || source.status === 'ready' && decoded.status === 'loading';
  const reason = source.status === 'error' ? source.reason : decoded.status === 'error' ? decoded.reason : null;
  const errorText = reason === null ? null : reason === 'tooLarge'
    ? t('filesView.artifact.data.tooLarge', { limit: formatArtifactSize(dataPreviewByteLimit(kind)) })
    : reason === 'timeout' ? t('filesView.artifact.data.timeout')
      : reason === 'workerUnavailable' ? t('filesView.artifact.data.workerUnavailable')
        : t(reason === 'unsupported' ? 'filesView.artifact.data.tableUnsupported' : reason === 'invalid' ? 'filesView.artifact.data.invalid' : 'filesView.artifact.data.readFailed');
  const rowStart = (table?.page ?? 0) * DATA_TABLE_ROWS;
  const actions = <>
    {kind === 'sqlite' ? <Select value={selection.table ?? table?.selectedTable ?? ''} onValueChange={(value) => setSelection({ table: value, page: 0 })}><SelectTrigger className="max-w-40" disabled={loading || !table?.tables.length} aria-label={t('filesView.artifact.data.tablePicker')}><SelectValue dir="auto">{selection.table ?? table?.selectedTable ?? t('filesView.artifact.data.tablePicker')}</SelectValue></SelectTrigger><SelectContent>{table?.tables.map((name) => <SelectItem key={name} value={name} dir="auto">{name}</SelectItem>)}</SelectContent></Select> : null}
    <Button size="sm" variant="outline" disabled={loading || !table || selection.page === 0} aria-label={t('filesView.artifact.data.previousPage')} onClick={() => setSelection((current) => ({ ...current, page: current.page - 1 }))}><Icon name="arrow-left-s" className="size-4" /></Button>
    <Button size="sm" variant="outline" disabled={loading || !table?.hasMore || selection.page >= 10_000} aria-label={t('filesView.artifact.data.nextPage')} onClick={() => setSelection((current) => ({ ...current, page: current.page + 1 }))}><Icon name="arrow-right-s" className="size-4" /></Button>
    {download}
  </>;
  return <div className="flex h-full min-h-0 flex-col">
    <ArtifactMetaBar items={[kind === 'sqlite' ? 'SQLite' : 'Parquet', formatArtifactSize(sizeBytes), t('filesView.artifact.data.readOnly')]} actions={actions} />
    <div className="min-h-9 px-3 py-2 typography-meta text-muted-foreground" aria-live="polite">
      {loading ? t('filesView.artifact.data.loading') : errorText ?? (table?.rows.length ? table.totalRows === null
        ? t('filesView.artifact.data.rowRange', { start: rowStart + 1, end: rowStart + table.rows.length })
        : t('filesView.artifact.data.rowRangeTotal', { start: rowStart + 1, end: rowStart + table.rows.length, total: table.totalRows }) : t(kind === 'sqlite' && table?.tables.length === 0 ? 'filesView.artifact.data.tablesEmpty' : 'filesView.artifact.data.rowsEmpty'))}
    </div>
    {reason ? <div className="px-3 pb-3"><Button variant="outline" size="sm" onClick={retry}>{t('filesView.artifact.office.retry')}</Button></div> : null}
    {!loading && !reason && table ? <>
      <div className="min-h-0 flex-1 overflow-auto"><table className="w-full border-collapse text-start typography-meta"><thead className="sticky top-0 bg-[var(--surface-background)]"><tr>{table.columns.map((column, index) => <th key={index} className="px-3 py-2 text-start font-medium" scope="col"><span className="oc-ui-start-align block truncate" dir="auto" title={column}>{column}</span><span className="font-normal text-muted-foreground">{table.columnTypes[index]}</span></th>)}</tr></thead><tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex} className="odd:bg-[var(--surface-subtle)]">{row.map((cell, columnIndex) => <td key={columnIndex} className="max-w-sm whitespace-pre-wrap break-words px-3 py-1 align-top font-mono" dir="auto">{cell}</td>)}</tr>)}</tbody></table></div>
      {table.cellsTruncated ? <p className="px-3 py-1 typography-meta text-muted-foreground">{t('filesView.artifact.data.cellsTruncated')}</p> : null}
      {kind === 'sqlite' ? <p className="px-3 py-1 typography-meta text-muted-foreground">{t('filesView.artifact.data.physicalTables')}</p> : null}
    </> : null}
  </div>;
};
