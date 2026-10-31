import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import {
  BatchJobSchema,
  CheckpointSchema,
  beginRequest,
  finishRequest,
  readBatchCheckpoint,
  requestCapacity,
  type BatchJob,
} from '../src/generation/task-batch.js';
import { hash, initializeTask, updateTask, writeTaskJson } from '../src/project/task-store.js';

const jobId = '11111111-1111-4111-8111-111111111111';
const firstSlide = '22222222-2222-4222-8222-222222222222';
const secondSlide = '33333333-3333-4333-8333-333333333333';

describe('batch generation concurrency bookkeeping', () => {
  it('migrates a legacy single in-flight checkpoint into the multi-request shape', () => {
    const checkpoint = CheckpointSchema.parse({
      jobId,
      requestCount: 1,
      inFlightSlideId: firstSlide,
      completed: {},
    });

    assert.deepEqual(checkpoint.inFlightSlideIds, [firstSlide]);
    assert.equal(checkpoint.inFlightSlideId, firstSlide);
  });

  it('reserves capacity from both the worker limit and the paid call budget', () => {
    const job = { maxConcurrency: 2, callBudget: 4 } as Pick<BatchJob, 'maxConcurrency' | 'callBudget'>;
    const checkpoint = CheckpointSchema.parse({
      jobId,
      requestCount: 2,
      inFlightSlideIds: [firstSlide, secondSlide],
      completed: {},
    });

    assert.equal(requestCapacity(job, checkpoint), 0);
    assert.equal(requestCapacity({ ...job, maxConcurrency: 3 }, checkpoint), 1);
  });

  it('allows two pages to finish out of order and clears both in-flight slots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superppt-batch-'));
    const state = await initializeTask(root, 'Parallel batch');
    const job = BatchJobSchema.parse({
      jobId,
      contentRevision: state.contentRevision,
      kind: 'deck',
      styleLock: {
        recipe: { id: 'glass', name: 'Glass', level: 2, paletteId: 'cool', promptTemplate: '{{CONTENT_RELATIONSHIPS}} {{SLIDE_COPY}}' },
        representativeSlideId: firstSlide, approvalState: 'approved', approvedSample: null, references: [], applyDependencyDefaultStyle: false,
      },
      generationIntent: { purpose: 'training', audience: 'designers' },
      callBudget: 2,
      pages: [
        { slideId: firstSlide, prompt: 'first', target: `generation/jobs/${jobId}/images/${firstSlide}.png`, cached: null },
        { slideId: secondSlide, prompt: 'second', target: `generation/jobs/${jobId}/images/${secondSlide}.png`, cached: null },
      ],
      createdAt: new Date().toISOString(),
      maxConcurrency: 2,
    });
    await mkdir(join(root, 'generation/jobs', jobId, 'images'), { recursive: true });
    await writeTaskJson(root, `generation/jobs/${jobId}/job.json`, job);
    await writeTaskJson(root, `generation/jobs/${jobId}/checkpoint.json`, {
      jobId, requestCount: 0, inFlightSlideIds: [], completed: {}, pages: {},
    });
    await updateTask(root, current => ({ ...current, activeJobId: jobId, stage: 'deck-generation' }));

    await beginRequest(root, jobId, firstSlide);
    await beginRequest(root, jobId, secondSlide);
    const image = await sharp({ create: { width: 16, height: 9, channels: 3, background: 'navy' } }).png().toBuffer();
    const second = { path: `generation/jobs/${jobId}/images/${secondSlide}.png`, sha256: hash(image) };
    const first = { path: `generation/jobs/${jobId}/images/${firstSlide}.png`, sha256: hash(image) };
    await writeFile(join(root, second.path), image);
    await writeFile(join(root, first.path), image);
    await finishRequest(root, jobId, { slideId: secondSlide, status: 'success', artifact: second, raw: null, provider: 'openai', channel: 'api', referencesUsed: [] });
    await finishRequest(root, jobId, { slideId: firstSlide, status: 'success', artifact: first, raw: null, provider: 'openai', channel: 'api', referencesUsed: [] });
    const checkpoint = await readBatchCheckpoint(root, jobId);
    assert.deepEqual(checkpoint.inFlightSlideIds, []);
    assert.deepEqual(Object.keys(checkpoint.completed).sort(), [firstSlide, secondSlide].sort());
  });
});
