import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { dataPreviewKind, parseNotebookPreview, readZipDirectory } from './dataFilePreview';
type NotebookFixture = { nbformat: number; cells: { cell_type: string; source: string | string[]; outputs?: { output_type: string; text?: string[]; data?: { 'text/html'?: string; 'text/plain'?: string[] } }[] }[] };
const encode = (value: NotebookFixture) => new TextEncoder().encode(JSON.stringify(value));

describe('read-only data file previews', () => {
  test('selects only the explicitly supported file formats', () => {
    expect(dataPreviewKind('/repo/资料.ZIP')).toBe('zip');
    expect(dataPreviewKind('/repo/work.ipynb')).toBe('notebook');
    expect(dataPreviewKind('/repo/main.sqlite3')).toBe('sqlite');
    expect(dataPreviewKind('/repo/data.parquet')).toBe('parquet');
    expect(dataPreviewKind('/repo/book.xlsx')).toBeNull();
    expect(dataPreviewKind('/repo/task.md')).toBeNull();
  });
  test('lists archive paths without extracting archive content', async () => {
    const zip = new JSZip();
    zip.file('资料/预算.txt', 'private contents', { createFolders: false });
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const directory = await readZipDirectory(bytes);
    expect(directory).toEqual([{ name: '资料/预算.txt', directory: false }]);
    expect(JSON.stringify(directory)).not.toContain('private contents');
  });
  test('rejects malformed, oversized and excessive-entry archives', async () => {
    await expect(readZipDirectory(new Uint8Array([1, 2, 3]))).rejects.toThrow('invalid');
    await expect(readZipDirectory(new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toThrow('tooLarge');
    const zip = new JSZip();
    for (let index = 0; index < 2001; index += 1) zip.file(`${index}.txt`, '', { createFolders: false });
    await expect(readZipDirectory(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('tooLarge');
  });
  test('notebook code and HTML remain inert text with unsupported output explicit', () => {
    const preview = parseNotebookPreview(encode({ nbformat: 4, cells: [
      { cell_type: 'markdown', source: ['# 预算\n', '<img src="https://example.test/leak">'] },
      { cell_type: 'code', source: ['print(2)'], outputs: [
        { output_type: 'stream', text: ['2\n'] },
        { output_type: 'display_data', data: { 'text/html': '<script>bad()</script>' } },
        { output_type: 'execute_result', data: { 'text/plain': ['value'] } },
      ] },
    ] }));
    expect(preview.cells[0]?.source).toContain('<img');
    expect(preview.cells[1]?.outputs).toEqual(['2\n', 'value']);
    expect(preview.omittedOutputs).toBe(1);
  });
  test('rejects malformed and oversized notebook inputs', () => {
    expect(() => parseNotebookPreview(new TextEncoder().encode('{broken'))).toThrow('invalid');
    expect(() => parseNotebookPreview(encode({ nbformat: 3, cells: [] }))).toThrow('unsupported');
    expect(() => parseNotebookPreview(encode({ nbformat: 4, cells: Array.from({ length: 501 }, () => ({ cell_type: 'raw', source: '' })) }))).toThrow('tooLarge');
    expect(() => parseNotebookPreview(new Uint8Array(5 * 1024 * 1024 + 1))).toThrow('tooLarge');
  });
});
