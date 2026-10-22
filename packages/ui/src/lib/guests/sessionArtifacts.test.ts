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

  for (const text of [
    '`C:/work/交付/方案.pdf`', '[成品](C:/work/交付/方案.pdf)', '文件：C:/work/交付/方案.pdf',
    '`C:\\work\\交付\\方案.pdf`', '文件：C:\\work\\交付\\方案.pdf',
    '`file:///C:/work/%E4%BA%A4%E4%BB%98/%E6%96%B9%E6%A1%88.pdf`',
    '[成品](file://localhost/C:/work/%E4%BA%A4%E4%BB%98/%E6%96%B9%E6%A1%88.pdf)',
  ]) {
    test(`keeps the Windows artifact absolute without duplicate fragments: ${text}`, () => {
      expect(sessionArtifactsInText(text, 'C:/work')).toEqual([
        { path: 'C:/work/交付/方案.pdf', name: '方案.pdf' },
      ]);
    });
  }

  test('preserves the share in a UNC file URL', () => {
    expect(sessionArtifactsInText('`file://server/share/work/report.pdf`', 'C:/work')).toEqual([
      { path: '//server/share/work/report.pdf', name: 'report.pdf' },
    ]);
  });

  test('keeps relative Windows artifacts in the session directory and skips previews', () => {
    expect(sessionArtifactsInText('`交付\\方案.pdf` `C:\\work\\planning\\preview.html`', 'C:/work')).toEqual([
      { path: 'C:/work/交付/方案.pdf', name: '方案.pdf' },
    ]);
  });

  test('ignores remote links and malformed file URLs', () => {
    expect(sessionArtifactsInText('[remote](//example.com/report.pdf) `file://[bad/report.pdf`', 'C:/work')).toEqual([]);
  });
});
