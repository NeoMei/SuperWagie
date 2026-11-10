import { expect, test } from 'bun:test';
import { averageVectors, embedSegments, MAX_EMBED_BYTES, truncateUtf8 } from './embed-limit.js';

test('leaves bytes at or below the embed limit unchanged', () => {
  const exact = '中'.repeat(Math.floor(MAX_EMBED_BYTES / 3));
  expect(truncateUtf8(exact)).toBe(exact);
  expect(Buffer.byteLength(truncateUtf8('short'), 'utf8')).toBe(5);
});

test('cuts a long Chinese payload on a character boundary below the limit', () => {
  const text = '经验'.repeat(200_000);
  const truncated = truncateUtf8(text);
  const bytes = Buffer.from(truncated, 'utf8');
  expect(bytes.length).toBeLessThanOrEqual(MAX_EMBED_BYTES);
  expect(bytes.length).toBeGreaterThan(MAX_EMBED_BYTES - 3);
  expect(truncated).not.toContain('\uFFFD');
  expect(text.startsWith(truncated)).toBe(true);
});

test('handles an astral character straddling the limit', () => {
  const prefix = 'a'.repeat(MAX_EMBED_BYTES - 1);
  const truncated = truncateUtf8(`${prefix}😀`);
  expect(truncated).toBe(prefix);
  expect(Buffer.byteLength(truncated, 'utf8')).toBe(MAX_EMBED_BYTES - 1);
});

test('splits long text into budgeted UTF-8 segments and rejoins it unchanged', () => {
  const text = '经验学习'.repeat(20) + '😀' + '边界'.repeat(10);
  const segments = embedSegments(text, 40);
  expect(segments.length).toBeGreaterThan(1);
  expect(segments.join('')).toBe(text);
  expect(segments.every((segment) => Buffer.byteLength(segment, 'utf8') <= 40)).toBe(true);
  expect(segments.every((segment) => !segment.includes('\uFFFD'))).toBe(true);
});

test('averages vectors and refuses mixed widths', () => {
  expect(averageVectors([[1, 3], [3, 5]])).toEqual([2, 4]);
  expect(averageVectors([])).toEqual([]);
  expect(() => averageVectors([[1, 2], [1]])).toThrow('embedding_dimension_mismatch');
});
