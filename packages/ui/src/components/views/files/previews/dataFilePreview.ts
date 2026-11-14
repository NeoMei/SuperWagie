import { z } from 'zod';
import { getFileExtension } from '@/lib/toolHelpers';

export type DataPreviewKind = 'zip' | 'notebook' | 'sqlite' | 'parquet';
export const dataPreviewKind = (path: string): DataPreviewKind | null => {
  const extension = getFileExtension(path).toLowerCase();
  if (extension === 'zip') return 'zip';
  if (extension === 'ipynb') return 'notebook';
  if (extension === 'sqlite' || extension === 'sqlite3' || extension === 'db') return 'sqlite';
  if (extension === 'parquet') return 'parquet';
  return null;
};
export const dataPreviewByteLimit = (kind: DataPreviewKind): number => kind === 'notebook' ? 5 * 1024 * 1024 : kind === 'zip' ? 10 * 1024 * 1024 : 20 * 1024 * 1024;
export class DataPreviewError extends Error {
  constructor(readonly reason: 'invalid' | 'tooLarge' | 'unsupported' | 'timeout' | 'workerUnavailable') { super(reason); this.name = 'DataPreviewError'; }
}
export type ZipDirectoryEntry = { name: string; directory: boolean };

/** Checks entry count before JSZip allocates entries. No archive member is inflated. */
export const readZipDirectory = async (bytes: Uint8Array): Promise<ZipDirectoryEntry[]> => {
  if (bytes.byteLength > dataPreviewByteLimit('zip')) throw new DataPreviewError('tooLarge');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength) { end = offset; break; }
  }
  if (end < 0) throw new DataPreviewError('invalid');
  const count = view.getUint16(end + 10, true);
  if (count > 2000) throw new DataPreviewError('tooLarge');
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 8, true) !== count) throw new DataPreviewError('unsupported');
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (directoryOffset + directorySize > end) throw new DataPreviewError('invalid');
  let cursor = directoryOffset;
  let counted = 0;
  while (cursor < directoryOffset + directorySize) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new DataPreviewError('invalid');
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    if (nameLength > 4096 || ++counted > 2000) throw new DataPreviewError('tooLarge');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (cursor > directoryOffset + directorySize) throw new DataPreviewError('invalid');
  }
  if (counted !== count) throw new DataPreviewError('invalid');
  try {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(bytes, { createFolders: false, checkCRC32: false });
    const files = Object.values(zip.files);
    if (files.length !== count) throw new DataPreviewError('unsupported');
    const entries = files.map((file) => ({ name: file.unsafeOriginalName ?? file.name, directory: file.dir }));
    if (entries.some((entry) => entry.name.length > 4096)) throw new DataPreviewError('tooLarge');
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error instanceof DataPreviewError) throw error;
    throw new DataPreviewError('invalid');
  }
};

const textSchema = z.union([z.string(), z.array(z.string())]);
const outputSchema = z.object({
  text: textSchema.optional(),
  data: z.object({ 'text/plain': textSchema.optional() }).optional(),
  ename: z.string().optional(),
  evalue: z.string().optional(),
  traceback: z.array(z.string()).optional(),
});
const notebookSchema = z.object({
  nbformat: z.literal(4),
  cells: z.array(z.object({
    cell_type: z.enum(['markdown', 'code', 'raw']),
    source: textSchema,
    outputs: z.array(outputSchema).optional(),
  })),
});
export type NotebookCell = { kind: 'markdown' | 'code' | 'raw'; source: string; outputs: string[] };
export type NotebookPreview = { cells: NotebookCell[]; omittedOutputs: number };
const joinedText = (text: z.infer<typeof textSchema>): string => Array.isArray(text) ? text.join('') : text;

/** Notebook source and text outputs are plain text. HTML, scripts and rich media never mount. */
export const parseNotebookPreview = (bytes: Uint8Array): NotebookPreview => {
  if (bytes.byteLength > dataPreviewByteLimit('notebook')) throw new DataPreviewError('tooLarge');
  let json: unknown;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new DataPreviewError('invalid'); }
  const version = z.object({ nbformat: z.number() }).safeParse(json);
  if (version.success && version.data.nbformat !== 4) throw new DataPreviewError('unsupported');
  const parsed = notebookSchema.safeParse(json);
  if (!parsed.success) throw new DataPreviewError('invalid');
  if (parsed.data.cells.length > 500) throw new DataPreviewError('tooLarge');
  let omittedOutputs = 0;
  let characters = 0;
  let outputCount = 0;
  const cells = parsed.data.cells.map((cell): NotebookCell => {
    const source = joinedText(cell.source);
    characters += source.length;
    const outputs: string[] = [];
    for (const output of cell.outputs ?? []) {
      outputCount += 1;
      let text: string | null = null;
      if (output.text !== undefined) text = joinedText(output.text);
      else if (output.data?.['text/plain'] !== undefined) text = joinedText(output.data['text/plain']);
      else if (output.ename !== undefined) text = [output.ename, output.evalue ?? '', ...(output.traceback ?? [])].join('\n');
      else omittedOutputs += 1;
      if (text !== null) { characters += text.length; outputs.push(text); }
    }
    return { kind: cell.cell_type, source, outputs };
  });
  if (characters > 1_000_000 || outputCount > 1000) throw new DataPreviewError('tooLarge');
  return { cells, omittedOutputs };
};
