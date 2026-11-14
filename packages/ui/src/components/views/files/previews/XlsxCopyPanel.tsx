import React from 'react';
import type { FilesAPI, XlsxCellEdit, XlsxCopyInspection } from '@/lib/api/types';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TableQuote } from './tableSelection';

export type XlsxCopyAPI = Required<Pick<FilesAPI, 'inspectXlsxCopy' | 'saveXlsxCopy'>>;
export const XlsxCopyPanel: React.FC<{ path: string; name: string; api: XlsxCopyAPI; onQuote?: (quote: TableQuote) => boolean }> = ({ path, name, api, onQuote }) => {
  const { t } = useI18n();
  const apiRef = React.useRef(api); apiRef.current = api;
  const owner = React.useRef<AbortController | null>(null);
  const runtimeOwner = React.useRef<() => boolean>(() => false);
  const [inspection, setInspection] = React.useState<XlsxCopyInspection | null>(null);
  const [sheetName, setSheetName] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [value, setValue] = React.useState('');
  const [kind, setKind] = React.useState<XlsxCellEdit['kind']>('string');
  const [edits, setEdits] = React.useState<XlsxCellEdit[]>([]);
  const [copyName, setCopyName] = React.useState(name.replace(/\.xlsx$/i, '-copy.xlsx'));
  const [busy, setBusy] = React.useState<'loading' | 'saving' | null>('loading');
  const [message, setMessage] = React.useState<string | null>(null);
  const [savedPath, setSavedPath] = React.useState('');
  React.useEffect(() => {
    const controller = new AbortController(); owner.current = controller;
    setInspection(null); setEdits([]); setSheetName(''); setAddress(''); setValue('');
    setBusy('loading'); setMessage(null); setSavedPath(''); setCopyName(name.replace(/\.xlsx$/i, '-copy.xlsx'));
    const current = captureRuntimeInstance();
    runtimeOwner.current = current;
    void (async () => {
      try {
        const result = await apiRef.current.inspectXlsxCopy(path, controller.signal);
        if (controller.signal.aborted || !current()) return;
        setInspection(result); setSheetName(result.sheets[0]?.name ?? ''); setBusy(null);
      } catch (error) {
        if (controller.signal.aborted || !current()) return;
        setMessage(error instanceof Error ? error.message : 'failed'); setBusy(null);
      }
    })();
    return () => { controller.abort(); owner.current = null; };
  }, [path, name]);
  const sheet = inspection?.sheets.find((item) => item.name === sheetName);
  const selected = sheet?.cells.find((cell) => cell.address === address);
  const quoteValues = selected ? JSON.stringify([[selected.value]]) : '';
  const quoteTooLarge = new TextEncoder().encode(quoteValues).byteLength > 64 * 1024;
  const failure = message === 'already-exists' ? t('filesView.xlsx.exists')
    : message === 'source-changed' ? t('filesView.xlsx.changed')
      : message === 'unsupported' || message === 'readonly' ? t('filesView.xlsx.readonly')
        : message ? t('filesView.xlsx.failed') : '';
  const apply = () => {
    if (!selected?.editable || busy) return;
    const edit = { sheet: sheetName, address, kind, value };
    setEdits((previous) => [...previous.filter((item) => item.sheet !== sheetName || item.address !== address), edit]);
    setMessage(null); setSavedPath('');
  };
  const save = async () => {
    const controller = owner.current; const current = captureRuntimeInstance();
    if (!inspection || !controller || controller.signal.aborted || !runtimeOwner.current() || busy || !edits.length) return;
    setBusy('saving'); setMessage(null); setSavedPath('');
    try {
      const result = await apiRef.current.saveXlsxCopy(path, { version: inspection.version, name: copyName, edits }, controller.signal);
      if (controller.signal.aborted || !current()) return;
      setSavedPath(result.path);
    } catch (error) {
      if (controller.signal.aborted || !current()) return;
      setMessage(error instanceof Error ? error.message : 'failed');
    } finally { if (!controller.signal.aborted && current()) setBusy(null); }
  };
  return <div className="flex h-full min-h-0 flex-col gap-2 p-3">
    <div className="typography-meta text-muted-foreground">{t('filesView.xlsx.notice')}</div>
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto">
      {inspection?.sheets.map((item) => <Button key={item.name} size="sm" variant="chip" aria-pressed={sheetName === item.name} disabled={busy === 'saving'} onClick={() => { setSheetName(item.name); setAddress(''); }}>{item.name}</Button>)}
      {sheet?.truncated ? <span className="typography-meta text-muted-foreground">{t('filesView.xlsx.truncated')}</span> : null}
    </div>
    <div className="min-h-0 flex-1 overflow-auto" dir="ltr">
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {sheet?.cells.map((cell) => <Button key={cell.address} variant="chip" size="sm" aria-pressed={address === cell.address} className="justify-start overflow-hidden" disabled={busy === 'saving'} onClick={() => {
          const pending = edits.find((item) => item.sheet === sheetName && item.address === cell.address);
          setAddress(cell.address); setValue(pending?.value ?? cell.value); setKind(pending?.kind ?? 'string');
        }}><span className="shrink-0 font-mono">{cell.address}</span><span className="ms-2 truncate">{cell.value}</span></Button>)}
      </div>
    </div>
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto">
      <span dir="ltr" className="min-w-12 font-mono typography-meta">{address}</span>
      <Input className="min-w-32" aria-label={t('filesView.xlsx.value')} inputSize="compact" maxLength={32767} value={value} disabled={!selected?.editable || !!busy} onChange={(event) => setValue(event.target.value)} />
      <Button size="sm" variant="chip" aria-pressed={kind === 'string'} disabled={!selected?.editable || !!busy} onClick={() => setKind('string')}>{t('filesView.xlsx.text')}</Button>
      <Button size="sm" variant="chip" aria-pressed={kind === 'number'} disabled={!selected?.editable || !!busy} onClick={() => setKind('number')}>{t('filesView.xlsx.number')}</Button>
      <Button size="sm" variant="outline" disabled={!selected?.editable || !!busy || edits.length >= 100 && !edits.some((item) => item.sheet === sheetName && item.address === address)} onClick={apply}>{t('filesView.xlsx.apply')}</Button>
      {onQuote ? <Button size="sm" variant="outline" disabled={!selected || !!busy || quoteTooLarge} title={quoteTooLarge ? t('filesView.artifact.table.selectionTooLarge') : undefined} onClick={() => {
        if (!selected || !runtimeOwner.current()) return;
        const range = `'${sheetName.replace(/'/g, "''")}'!${selected.address}`;
        if (!onQuote({ range, values: quoteValues })) setMessage('quote');
      }}>{t('chat.textSelection.actions.addToInput')}</Button> : null}
    </div>
    <div className="flex shrink-0 items-center gap-2">
      <Input aria-label={t('filesView.xlsx.filename')} inputSize="compact" value={copyName} dir="ltr" disabled={!!busy} onChange={(event) => setCopyName(event.target.value)} />
      <Button size="sm" disabled={!!busy || !edits.length || !copyName} onClick={() => { void save(); }}>{t('filesView.xlsx.save')}</Button>
      <span className="shrink-0 typography-meta text-muted-foreground">{t('filesView.xlsx.pending', { count: edits.length })}</span>
    </div>
    <div aria-live="polite" className="h-5 shrink-0 truncate typography-meta text-muted-foreground" title={savedPath || failure}>
      {busy ? t(busy === 'loading' ? 'filesView.artifact.office.loading' : 'filesView.xlsx.saving') : savedPath ? t('filesView.xlsx.saved', { path: savedPath }) : failure || (selected && !selected.editable ? t('filesView.xlsx.cellReadonly') : '')}
    </div>
  </div>;
};
