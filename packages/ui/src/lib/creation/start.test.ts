import { expect, test } from 'bun:test';

import { createCreationIntentQueue } from './start';

test('queues a creation entry clicked while another start is pending', async () => {
  const started: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstFinished = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const queue = createCreationIntentQueue(async (kind) => {
    started.push(kind);
    if (kind === 'doc') await firstFinished;
  });

  queue.enqueue('doc');
  queue.enqueue('video');

  expect(started).toEqual(['doc']);
  releaseFirst?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(started).toEqual(['doc', 'video']);
});
