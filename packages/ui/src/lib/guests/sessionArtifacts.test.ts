import { describe, expect, test } from 'bun:test';

import { sessionArtifactsInText } from './sessionArtifacts';

const directory = '/Users/me/Documents/SuperWagie/PPT/新 PPT 2026-10-21';

describe('sessionArtifactsInText', () => {
  test('finds a backticked absolute path with spaces', () => {
    const text = '文件：`/Users/me/Documents/SuperWagie/PPT/新 PPT 2026-10-21/task/交付/怎么礼貌地放屁.pptx`\n需要修改回来说。';
    expect(sessionArtifactsInText(text, directory)).toEqual([
      {
        path: '/Users/me/Documents/SuperWagie/PPT/新 PPT 2026-10-21/task/交付/怎么礼貌地放屁.pptx',
        name: '怎么礼貌地放屁.pptx',
      },
    ]);
  });

  test('resolves a relative markdown link and ignores non-artifacts', () => {
    const text = '见 [成品](交付/方案.pdf)、[需求](需求.md) 和 https://example.com/a.pdf';
    expect(sessionArtifactsInText(text, directory)).toEqual([
      { path: `${directory}/交付/方案.pdf`, name: '方案.pdf' },
    ]);
  });

  test('keeps an absolute file URL and drops planning previews', () => {
    const text = '`file:///Users/me/Downloads/report.pdf` `planning/style-selection.html`';
    expect(sessionArtifactsInText(text, directory)).toEqual([
      { path: '/Users/me/Downloads/report.pdf', name: 'report.pdf' },
    ]);
  });
});
