/** The Go embed endpoint rejects a request above 1 MiB of JSON. Leave room for
 * the rest of the envelope so a long Chinese conversation cannot become a 400. */
export const MAX_EMBED_BYTES = 768 * 1024;
// Some embedding providers reject a single short Chinese sentence once it
// crosses a few dozen bytes. Card content is embedded in overlapping slices
// and averaged, so neither the request nor one provider's per-input ceiling
// decides whether an experience can be indexed.
const EMBED_SEGMENT_BYTES = 40;

export const truncateUtf8 = (text) => {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_EMBED_BYTES) return text;
  let cut = MAX_EMBED_BYTES;
  // A continuation byte belongs to the character before it, so step back to
  // that character's leading byte instead of emitting a replacement glyph.
  while (cut > 0 && (bytes[cut] & 0xC0) === 0x80) cut--;
  return bytes.subarray(0, cut).toString('utf8');
};

/** Split on UTF-8 boundaries without dropping text or emitting half glyphs. */
export const embedSegments = (text, budget = EMBED_SEGMENT_BYTES) => {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') <= budget) return value.trim() ? [value] : [];
  const segments = [];
  let offset = 0;
  while (offset < value.length) {
    let end = offset;
    let bytes = 0;
    while (end < value.length) {
      const point = value.codePointAt(end);
      const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (bytes && bytes + width > budget) break;
      bytes += width;
      end += width === 4 ? 2 : 1;
    }
    if (end === offset) break;
    segments.push(value.slice(offset, end));
    offset = end;
  }
  return segments.filter((segment) => segment.trim());
};

/** Average vectors without making one segment's length dominate the centroid. */
export const averageVectors = (vectors) => {
  const usable = vectors.filter((vector) => Array.isArray(vector) && vector.length);
  if (!usable.length) return [];
  const width = usable[0].length;
  if (usable.some((vector) => vector.length !== width)) throw Object.assign(new Error('embedding_dimension_mismatch'), { code: 'embedding_dimension_mismatch' });
  const sum = new Array(width).fill(0);
  for (const vector of usable) for (let index = 0; index < width; index += 1) sum[index] += vector[index];
  return sum.map((value) => value / usable.length);
};
