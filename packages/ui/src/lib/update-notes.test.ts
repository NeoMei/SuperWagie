import { describe, expect, test } from 'bun:test';

import { selectLocalizedUpdateNotes } from './update-notes';

const notes = `<!-- release-notes:zh-CN -->\n中文更新说明。\n<!-- /release-notes -->\n\n<!-- release-notes:en -->\nEnglish update notes.\n<!-- /release-notes -->`;

describe('selectLocalizedUpdateNotes', () => {
  test('selects the active language block', () => {
    expect(selectLocalizedUpdateNotes(notes, 'zh-CN')).toBe('中文更新说明。');
    expect(selectLocalizedUpdateNotes(notes, 'en')).toBe('English update notes.');
  });

  test('keeps older unmarked notes unchanged', () => {
    expect(selectLocalizedUpdateNotes('Older release notes.', 'zh-CN')).toBe('Older release notes.');
  });

  test('falls back to English when the requested block is absent', () => {
    expect(selectLocalizedUpdateNotes('<!-- release-notes:en -->English only.<!-- /release-notes -->', 'zh-CN')).toBe('English only.');
  });

  test('does not expose an empty or malformed marked block as a translation', () => {
    expect(selectLocalizedUpdateNotes('<!-- release-notes:zh-CN -->\n\n<!-- /release-notes -->', 'zh-CN')).toBe('');
    const incomplete = '<!-- release-notes:en -->Incomplete older notes.';
    expect(selectLocalizedUpdateNotes(incomplete, 'en')).toBe(incomplete);
  });
});
