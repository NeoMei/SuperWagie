import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { tableSelection, type TableCell, type TableQuote } from './tableSelection';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';
import { delimiterForPath, parseDelimitedText } from './delimitedText';

const ROW_HEIGHT_ESTIMATE = 25;
const MIN_COLUMN_CHARS = 4;
const MAX_COLUMN_CHARS = 64;

/**
 * Column widths from the longest value in each column, in `ch` of the
 * monospace cell font. Only the visible rows are in the DOM, so an automatic
 * table layout would resize the columns on every scroll step.
 */
const measureColumnChars = (header: string[], rows: string[][], columnCount: number): number[] => {
  const widths = Array.from({ length: columnCount }, (_, column) => (header[column] ?? '').length);
  for (const row of rows) {
    for (let column = 0; column < row.length; column += 1) {
      const length = row[column]?.length ?? 0;
      if (length > widths[column]) widths[column] = length;
    }
  }
  return widths.map((width) => Math.min(MAX_COLUMN_CHARS, Math.max(MIN_COLUMN_CHARS, width)));
};

/**
 * CSV/TSV as a grid: a sticky header row, monospace cells, and a hard cap on
 * rows so a large export renders at all. The cap is stated in the meta line,
 * not hidden, because "2,000 rows" and "the first 2,000 rows" mean different
 * things to someone checking a result. Only rows near the viewport mount,
 * keeping wide exports from adding every cell to the DOM at once.
 */
export const TableArtifact: React.FC<{
  path: string;
  content: string;
  sizeBytes: number | null;
  onQuote?: (quote: TableQuote) => boolean;
}> = ({ path, content, sizeBytes, onQuote }) => {
  const { t } = useI18n();
  const table = React.useMemo(() => parseDelimitedText(content, delimiterForPath(path)), [content, path]);
  const [selection, setSelection] = React.useState<{ anchor: TableCell; end: TableCell } | null>(null);
  const dragging = React.useRef(false);
  React.useEffect(() => { setSelection(null); dragging.current = false; }, [table]);
  React.useEffect(() => {
    const stop = () => { dragging.current = false; };
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, []);
  const selected = selection ? tableSelection(table, selection.anchor, selection.end) : null;
  const columnChars = React.useMemo(
    () => measureColumnChars(table.header, table.rows, table.columnCount),
    [table],
  );
  const columnMeasureRef = React.useRef<HTMLSpanElement>(null);
  const [columnMetrics, setColumnMetrics] = React.useState({ character: 8, padding: 17 });
  React.useLayoutEffect(() => {
    const probe = columnMeasureRef.current;
    if (!probe) return;
    const measure = () => {
      const character = probe.getBoundingClientRect().width;
      const padding = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) + 1;
      if (character > 0) setColumnMetrics((previous) => (
        previous.character === character && previous.padding === padding ? previous : { character, padding }
      ));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [table.columnCount]);
  const columnWidths = React.useMemo(() => columnChars.map((chars) => chars * columnMetrics.character + columnMetrics.padding), [columnChars, columnMetrics]);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: table.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 12,
  });
  const columnVirtualizer = useVirtualizer({
    count: table.columnCount,
    horizontal: true,
    getScrollElement: () => scrollRef.current,
    estimateSize: (column) => columnWidths[column],
    overscan: 3,
  });
  React.useLayoutEffect(() => { columnVirtualizer.measure(); }, [columnVirtualizer, columnWidths]);
  const virtualColumns = columnVirtualizer.getVirtualItems();
  const paddingStart = virtualColumns[0]?.start ?? 0;
  const paddingEnd = virtualColumns.length > 0
    ? columnVirtualizer.getTotalSize() - virtualColumns[virtualColumns.length - 1].end : 0;
  const spacerCell = (width: number) => width > 0 ? <td aria-hidden="true" style={{ width, padding: 0, border: 0 }} /> : null;
  const summary = table.totalRows === 1
    ? t('filesView.artifact.table.rowsSingle', { rows: table.totalRows, columns: table.columnCount })
    : t('filesView.artifact.table.rowsPlural', { rows: table.totalRows, columns: table.columnCount });
  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows[0]?.start ?? 0;
  const paddingBottom = virtualRows.length > 0
    ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar
        items={[
          summary,
          table.truncated ? t('filesView.artifact.table.truncated', { shown: table.rows.length, total: table.totalRows }) : '',
          formatArtifactSize(sizeBytes),
          selected?.status === 'ready' ? selected.quote.range : '',
          selected && selected.status !== 'ready' ? t(selected.status === 'too-large' ? 'filesView.artifact.table.selectionTooLarge' : 'filesView.artifact.table.selectionUnavailable') : '',
        ]}
        actions={onQuote ? <Button variant="outline" size="sm" disabled={selected?.status !== 'ready'} onClick={() => {
          if (selected?.status !== 'ready') return;
          if (onQuote(selected.quote)) setSelection(null);
          else toast.error(t('filesView.artifact.table.quoteFailed'));
        }}>{t('chat.textSelection.actions.addToInput')}</Button> : undefined}
      />
      {table.columnCount === 0 ? (
        <div className="p-3 typography-ui text-muted-foreground">{t('filesView.artifact.table.empty')}</div>
      ) : (
        <div ref={scrollRef} dir="ltr" className="min-h-0 flex-1 overflow-auto" style={{ overflowAnchor: 'none' }}>
          <span ref={columnMeasureRef} className="font-mono typography-meta" aria-hidden="true" style={{ position: 'absolute', visibility: 'hidden', width: '1ch', height: 0 }} />
          <table
            aria-colcount={table.columnCount}
            className="table-fixed border-separate border-spacing-0 font-mono typography-meta"
            style={{ width: columnVirtualizer.getTotalSize() }}
          >
            <colgroup>
              {paddingStart > 0 ? <col style={{ width: paddingStart }} /> : null}
              {virtualColumns.map((column) => <col key={column.index} style={{ width: column.size }} />)}
              {paddingEnd > 0 ? <col style={{ width: paddingEnd }} /> : null}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-[var(--surface-subtle)]">
              <tr>
                {spacerCell(paddingStart)}
                {virtualColumns.map(({ index: column }) => (
                  <th
                    key={column}
                    scope="col"
                    aria-colindex={column + 1}
                    className="truncate border-b border-e border-border/40 px-2 py-1 text-start font-medium text-foreground last:border-e-0"
                    title={table.header[column] ?? ''}
                  >
                    {table.header[column] ?? ''}
                  </th>
                ))}
                {spacerCell(paddingEnd)}
              </tr>
            </thead>
            <tbody>
              {paddingTop > 0 ? <tr aria-hidden="true" style={{ height: paddingTop }} /> : null}
              {virtualRows.map((virtualRow) => {
                const row = table.rows[virtualRow.index] ?? [];
                return (
                  <tr
                    key={virtualRow.index}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className={virtualRow.index % 2 === 0 ? 'bg-[var(--surface-background)]' : 'bg-[var(--surface-subtle)]/40'}
                  >
                    {spacerCell(paddingStart)}
                    {virtualColumns.map(({ index: column }) => (
                      <td
                        key={column}
                        aria-colindex={column + 1}
                        className={`truncate border-b border-e border-border/30 px-2 py-1 align-top last:border-e-0 ${selection
                          && virtualRow.index >= Math.min(selection.anchor.row, selection.end.row) && virtualRow.index <= Math.max(selection.anchor.row, selection.end.row)
                          && column >= Math.min(selection.anchor.column, selection.end.column) && column <= Math.max(selection.anchor.column, selection.end.column)
                          ? 'bg-interactive-selection text-interactive-selection-foreground' : 'text-foreground'}`}
                        onPointerDown={onQuote ? (event) => {
                          if (event.button !== 0 || event.pointerType === 'touch') return;
                          event.preventDefault();
                          dragging.current = true;
                          const cell = { row: virtualRow.index, column };
                          setSelection((previous) => ({ anchor: event.shiftKey && previous ? previous.anchor : cell, end: cell }));
                        } : undefined}
                        onPointerUp={onQuote ? (event) => {
                          if (event.pointerType !== 'touch') return;
                          const cell = { row: virtualRow.index, column };
                          setSelection({ anchor: cell, end: cell });
                        } : undefined}
                        onPointerEnter={onQuote ? () => {
                          if (dragging.current) setSelection((previous) => previous ? { ...previous, end: { row: virtualRow.index, column } } : null);
                        } : undefined}
                        title={row[column] ?? ''}
                      >
                        {row[column] ?? ''}
                      </td>
                    ))}
                    {spacerCell(paddingEnd)}
                  </tr>
                );
              })}
              {paddingBottom > 0 ? <tr aria-hidden="true" style={{ height: paddingBottom }} /> : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
