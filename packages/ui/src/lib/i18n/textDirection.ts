// A word: letters with their marks and the zero-width non-joiner Persian uses
// inside words.
const WORD = /\p{L}[\p{L}\p{M}‌]*/gu;
const RTL_SCRIPTS = '\\p{Script=Arabic}\\p{Script=Hebrew}\\p{Script=Syriac}\\p{Script=Thaana}\\p{Script=Nko}\\p{Script=Adlam}\\p{Script=Samaritan}\\p{Script=Mandaic}';
const RTL_LETTER = new RegExp(`^[${RTL_SCRIPTS}]`, 'u');
const HAS_RTL_LETTER = new RegExp(`[${RTL_SCRIPTS}]`, 'u');
const HAS_LETTER = /\p{L}/u;

type TextDirection = 'rtl' | 'ltr';

const majorityDirection = (words: readonly string[]): TextDirection | undefined => {
  let rtl = 0;
  for (const word of words) {
    if (RTL_LETTER.test(word)) rtl += 1;
  }
  if (words.length === 0) return undefined;
  // A tie goes right to left: a mixed line is usually right-to-left prose
  // quoting left-to-right terms.
  return rtl * 2 >= words.length ? 'rtl' : 'ltr';
};

const INLINE_CODE_OR_URL = /`[^`\n]*`|https?:\/\/\S+/g;

/**
 * The direction of one paragraph or line of chat prose by its word majority,
 * so Arabic that opens with "React"
 * runs right to left. Here a word is a whitespace-separated token led by its
 * first letter, so a path or a dotted name counts once, and inline code and
 * URLs do not count. Undefined without letters.
 */
export const proseTextDirection = (text: string): TextDirection | undefined => {
  if (!HAS_RTL_LETTER.test(text)) return HAS_LETTER.test(text) ? 'ltr' : undefined;
  return majorityDirection(text.replace(INLINE_CODE_OR_URL, ' ').split(/\s+/).flatMap((token) => {
    const word = token.match(WORD)?.[0];
    return word ? [word] : [];
  }));
};
