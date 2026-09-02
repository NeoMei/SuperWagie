import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSubtitles, buildVideoArgs, evaluateMediaQa } from '../src/task6-media.mjs';

test('Task 6 subtitles have fixed timing and plain profile facts', () => {
  const subtitles = buildSubtitles({ title: '网站 Demo' });
  assert.match(subtitles, /^1\n00:00:01,000 --> 00:00:09,500\n网站 Demo：来源固定，运动受控。\n$/m);
  assert.match(subtitles, /^3\n00:00:20,000 --> 00:00:29,500\n局部返工不会重渲染无关场景。\n$/m);
});

test('Task 6 encodes rendered PNG frames without zoompan', () => {
  const args = buildVideoArgs({
    frameDirectory: '/tmp/frames', narrationPath: '/tmp/narration.aiff',
    outputPath: '/tmp/final.mp4', durationSeconds: 30,
  });
  assert.equal(args[0], '-hide_banner');
  assert.ok(args.includes('-framerate'));
  assert.equal(args[args.indexOf('-framerate') + 1], '30');
  assert.ok(args.join(' ').includes('scale=1280:720:flags=neighbor'));
  assert.ok(!args.join(' ').includes('zoompan'));
  assert.ok(args.includes('/tmp/final.mp4'));
});

test('Task 6 media QA requires real streams, duration, fps, motion, and no black/silence', () => {
  const passing = evaluateMediaQa({
    probe: { format: { duration: '30.0' }, streams: [
      { codec_type: 'video', avg_frame_rate: '30/1' },
      { codec_type: 'audio', codec_name: 'aac' },
    ] },
    blackFindings: 0, silenceFindings: 0, frameHashAt1: 'a', frameHashAt10: 'b',
  });
  assert.equal(passing.pass, true);
  const failing = evaluateMediaQa({
    probe: { format: { duration: '29.0' }, streams: [{ codec_type: 'video', avg_frame_rate: '30/1' }] },
    blackFindings: 0, silenceFindings: 0, frameHashAt1: 'a', frameHashAt10: 'a',
  });
  assert.equal(failing.pass, false);
  assert.ok(failing.failures.includes('final_duration_30_to_60_seconds'));
  assert.ok(failing.failures.includes('audio_stream_present'));
  assert.ok(failing.failures.includes('motion_present'));
});
