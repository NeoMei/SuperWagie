import { describe, expect, it } from 'vitest';

import { markdownFileLink } from '../src/project/markdown-link.js';

describe('markdown links', () => {
  it('encodes local file paths before embedding them in Markdown links', () => {
    expect(
    markdownFileLink('deck.pptx', '/tmp/新 PPT/report #1.pptx'),
    ).toBe('[deck.pptx](<file:///tmp/%E6%96%B0%20PPT/report%20%231.pptx>)');
  });
});
