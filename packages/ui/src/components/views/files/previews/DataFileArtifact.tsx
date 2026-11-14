import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';
import { DataTableArtifact } from './DataTableArtifact';
import { OfficePreviewSizeError } from './officePreviewBytes';
import { DataPreviewError, dataPreviewByteLimit, parseNotebookPreview, readZipDirectory, type DataPreviewKind, type NotebookPreview, type ZipDirectoryEntry } from './dataFilePreview';

type PreviewState = { status: 'loading' }
  | { status: 'error'; reason: 'invalid' | 'tooLarge' | 'unsupported' | 'readFailed' }
  | { status: 'zip'; entries: ZipDirectoryEntry[] }
  | { status: 'notebook'; notebook: NotebookPreview };

/** Passive file content only. No archive extraction, notebook execution or original-file writes. */
type Props = {
  kind: DataPreviewKind;
  name: string;
  path: string;
  revision: number;
  sizeBytes: number | null;
  readBytes: (signal: AbortSignal, maxBytes: number) => Promise<Uint8Array>;
  download?: React.ReactNode;
};
export const DataFileArtifact: React.FC<Props> = (props) => props.kind === 'sqlite' || props.kind === 'parquet'
  ? <DataTableArtifact {...props} kind={props.kind} />
  : <PassiveDataFileArtifact {...props} />;

const PassiveDataFileArtifact: React.FC<Props> = ({ kind, name, path, revision, sizeBytes, readBytes, download }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<PreviewState>({ status: 'loading' });
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
  const readRef = React.useRef(readBytes);
  readRef.current = readBytes;
  React.useEffect(() => {
    const controller = new AbortController();
    const maxBytes = dataPreviewByteLimit(kind);
    setState({ status: 'loading' });
    void (async () => {
      try {
        const bytes = await readRef.current(controller.signal, maxBytes);
        controller.signal.throwIfAborted();
        const preview: PreviewState = kind === 'zip'
          ? { status: 'zip', entries: await readZipDirectory(bytes) }
          : { status: 'notebook', notebook: parseNotebookPreview(bytes) };
        controller.signal.throwIfAborted();
        setState(preview);
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: 'error', reason: error instanceof DataPreviewError && (error.reason === 'invalid' || error.reason === 'tooLarge' || error.reason === 'unsupported') ? error.reason : error instanceof OfficePreviewSizeError ? 'tooLarge' : 'readFailed' });
      }
    })();
    return () => controller.abort();
  }, [attempt, kind, path, revision]);

  const errorText = state.status === 'error' ? state.reason === 'unsupported'
    ? t('filesView.artifact.data.unsupported')
    : state.reason === 'tooLarge' ? t('filesView.artifact.data.tooLarge', { limit: formatArtifactSize(dataPreviewByteLimit(kind)) })
      : t(state.reason === 'invalid' ? 'filesView.artifact.data.invalid' : 'filesView.artifact.data.readFailed') : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar items={[kind === 'notebook' ? 'Notebook' : kind.toUpperCase(), formatArtifactSize(sizeBytes), t('filesView.artifact.data.readOnly')]} actions={download} />
      {state.status === 'loading' ? <div className="p-6 typography-ui text-muted-foreground">{t('filesView.artifact.data.loading')}</div> : null}
      {errorText ? <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"><div className="typography-ui-header">{name}</div><p className="max-w-md typography-ui text-muted-foreground">{errorText}</p>{state.status === 'error' && state.reason !== 'unsupported' ? <Button variant="outline" size="sm" onClick={retry}>{t('filesView.artifact.office.retry')}</Button> : null}{download}</div> : null}
      {state.status === 'zip' ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <p className="mb-2 typography-meta text-muted-foreground">{t('filesView.artifact.data.zipEntries', { count: state.entries.length })}</p>
          <ul>{state.entries.map((entry, index) => <li key={`${index}-${entry.name}`} className="flex items-center gap-2 py-1"><Icon name={entry.directory ? 'folder' : 'file-text'} className="size-3.5 shrink-0 text-muted-foreground" /><span className="break-all font-mono typography-meta" dir="auto">{entry.name}</span></li>)}</ul>
        </div>
      ) : null}
      {state.status === 'notebook' ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <p className="mb-3 typography-meta text-muted-foreground">{t('filesView.artifact.data.notebookStatic')}</p>
          {state.notebook.omittedOutputs > 0 ? <p className="mb-3 typography-meta text-muted-foreground">{t('filesView.artifact.data.omittedOutputs', { count: state.notebook.omittedOutputs })}</p> : null}
          {state.notebook.cells.map((cell, index) => <section key={index} className="mb-5"><div className="mb-1 typography-meta text-muted-foreground">{t(`filesView.artifact.data.cell.${cell.kind}`, { number: index + 1 })}</div><pre className="whitespace-pre-wrap break-words font-mono typography-meta" dir="auto">{cell.source}</pre>{cell.outputs.map((output, outputIndex) => <pre key={outputIndex} className="mt-2 whitespace-pre-wrap break-words rounded bg-[var(--surface-subtle)] p-2 font-mono typography-meta" dir="auto">{output}</pre>)}</section>)}
        </div>
      ) : null}
    </div>
  );
};
