import type { Locale } from '@/lib/i18n';

/**
 * Release feeds can carry one note for each supported UI language. Older
 * feeds remain plain Markdown and pass through unchanged. Comment markers
 * stay invisible to older Markdown renderers.
 */
export function selectLocalizedUpdateNotes(body: string, locale: Locale): string {
  const blocks = [...body.matchAll(/<!-- release-notes:(zh-CN|en) -->\s*([\s\S]*?)\s*<!-- \/release-notes -->/g)];
  if (blocks.length === 0) {
    return body;
  }

  const requested = blocks.find((block) => block[1] === locale && block[2]?.trim());
  const fallback = blocks.find((block) => block[1] === 'en' && block[2]?.trim());
  return (requested?.[2] ?? fallback?.[2] ?? '').trim();
}
