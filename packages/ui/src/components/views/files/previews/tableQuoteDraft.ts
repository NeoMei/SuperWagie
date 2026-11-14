import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { delimiterForPath } from './delimitedText';
import type { TableQuote } from './tableSelection';

/** A basename-safe label keeps file, format and range visible in composer inspection. */
export function tableQuoteDraft(name: string, path: string, quote: TableQuote, format?: 'XLSX'): Omit<InlineCommentDraft, 'id' | 'createdAt' | 'sessionKey'> {
  return {
    source: 'file-quote', fileLabel: `${name} · ${format ?? (delimiterForPath(path) === '\t' ? 'TSV' : 'CSV')} · ${quote.range}`,
    startLine: 0, endLine: 0, code: quote.values, language: 'json', text: '',
  };
}
