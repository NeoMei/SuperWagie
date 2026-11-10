/** The Go embed endpoint rejects a request above 1 MiB of JSON. Leave room for
 * the rest of the envelope so a long Chinese conversation cannot become a 400. */
export const MAX_EMBED_BYTES = 768 * 1024;

export const truncateUtf8 = (text) => {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_EMBED_BYTES) return text;
  let cut = MAX_EMBED_BYTES;
  // A continuation byte belongs to the character before it, so step back to
  // that character's leading byte instead of emitting a replacement glyph.
  while (cut > 0 && (bytes[cut] & 0xC0) === 0x80) cut--;
  return bytes.subarray(0, cut).toString('utf8');
};
