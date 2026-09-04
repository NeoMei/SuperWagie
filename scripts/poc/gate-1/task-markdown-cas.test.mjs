import assert from 'node:assert/strict';
import test from 'node:test';
import { createRevisionedMarkdown } from './task-markdown-cas.mjs';

test('stale Markdown revision is rejected without invoking or writing the proposed update', () => {
  let content = '- [ ] Task ^task-1';
  let updateCalled = false;
  const markdown = createRevisionedMarkdown({
    read: () => content,
    write: (next) => { content = next; },
    initialRevision: 10,
  });

  markdown.externalWrite('- [ ] Externally renamed ^task-1');
  const before = content;
  const result = markdown.submit({
    expectedRevision: 10,
    update: () => { updateCalled = true; return '- [x] stale overwrite ^task-1'; },
  });

  assert.deepEqual(result, {
    ok: false,
    code: 'SW_WORKSPACE_REVISION_CONFLICT',
    currentRevision: 11,
  });
  assert.equal(updateCalled, false);
  assert.equal(content, before);
});

test('current Markdown revision can re-anchor a task update by stable block id', () => {
  let content = '- [ ] Externally renamed ^task-1';
  const markdown = createRevisionedMarkdown({
    read: () => content,
    write: (next) => { content = next; },
    initialRevision: 11,
  });

  const result = markdown.submit({
    expectedRevision: 11,
    update: (current) => current.replace(/^- \[ \](?=.*\^task-1$)/m, '- [x]'),
  });

  assert.deepEqual(result, { ok: true, revision: 12 });
  assert.equal(content, '- [x] Externally renamed ^task-1');
});
