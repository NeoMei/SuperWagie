import { contentFingerprint, HighlightResultCache, utf16Bytes } from './highlightResultCache';
import { highlightsBlockHtml, highlightsNow, loadHighlights, stripAnsi } from './highlightsEngine';
import { LANGUAGE_RELATIVES } from '@/lib/shiki/languageRelatives';

// Highlighted HTML for code views outside Markdown: whole-block `<pre>` HTML
// and per-line inner HTML, rendered by Highlights on the main thread. A block
// takes about a millisecond per 100 KB, so a view that asks synchronously
// paints highlighted in its first frame.
//
// Results are memoized by content fingerprint and language: unchanged content
// must not be tokenized again on every render (openchamber/openchamber#2769),
// and fingerprints keep large files from being duplicated as cache keys.
// Colors are the `--md-*` CSS variables, so a theme switch repaints through
// CSS and no entry depends on the theme.

// Block HTML and line HTML share one bounded cache, keyed by kind.
type Cached = { block: string };

const results = new HighlightResultCache<Cached>({ maxEntries: 2000, maxBytes: 24 * 1024 * 1024 });

const cacheKey = (kind: 'block' | 'lines', code: string, lang: string): string => `${kind}:${lang}:${contentFingerprint(code)}`;

/**
 * Whole-block `<pre>` HTML, now: null until Highlights has loaded, and for
 * good where it cannot run (the caller keeps plain code).
 */
export const getHighlightedCode = (code: string, lang: string): string | null => {
  const key = cacheKey('block', code, lang);
  const cached = results.get(key);
  if (cached && 'block' in cached) return cached.block;
  const language = lang === 'ansi' ? 'text' : lang;
  const relative = LANGUAGE_RELATIVES.get(language);
  const input = highlightsNow(language) ?? (relative ? highlightsNow(relative) : null) ?? highlightsNow('text');
  if (!input) return null;
  const html = highlightsBlockHtml(input, lang === 'ansi' ? stripAnsi(code) : code);
  results.set(key, { block: html }, utf16Bytes(key) + utf16Bytes(html));
  return html;
};

/** `getHighlightedCode` after the Highlights import has finished. */
export const highlightCode = async (code: string, lang: string): Promise<string | null> => {
  await loadHighlights();
  return getHighlightedCode(code, lang);
};
