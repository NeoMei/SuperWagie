import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

export const FFMPEG = realpathSync('/opt/homebrew/bin/ffmpeg');
export const FFPROBE = realpathSync('/opt/homebrew/bin/ffprobe');
export const SAY = realpathSync('/usr/bin/say');

function run(command, args, label) {
  const completed = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (completed.status !== 0) throw new Error(`${label} failed: ${(completed.stderr || completed.stdout || '').slice(-4000)}`);
  return completed;
}

export function buildSubtitles({ title }) {
  return [
    '1', '00:00:01,000 --> 00:00:09,500', `${title}：来源固定，运动受控。`, '',
    '2', '00:00:10,000 --> 00:00:19,500', '旁白、字幕与画面按固定帧率合成。', '',
    '3', '00:00:20,000 --> 00:00:29,500', '局部返工不会重渲染无关场景。', '',
  ].join('\n') + '\n';
}

export function buildVideoArgs({ frameDirectory, narrationPath, outputPath, durationSeconds = 30 }) {
  const filter = [
    '[0:v]scale=1280:720:flags=neighbor,format=yuv420p[v]',
    '[1:a]adelay=500|500,apad=whole_dur=30,atrim=duration=30[narration]',
    '[2:a]volume=0.08[music]',
    '[narration][music]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad,atrim=duration=30[a]',
  ].join(';');
  return [
    '-hide_banner', '-loglevel', 'error',
    '-framerate', '30', '-start_number', '0', '-i', join(frameDirectory, 'frame-%04d.png'),
    '-i', narrationPath,
    '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${durationSeconds}`,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '[a]', '-t', String(durationSeconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', outputPath,
  ];
}

export function generateNarration({ text, outputPath }) {
  run(SAY, ['-v', 'Tingting', '-r', '175', '-o', outputPath, text], 'Task 6 narration');
  return outputPath;
}

export function encodeVideo(options) {
  run(FFMPEG, buildVideoArgs(options), 'Task 6 video encode');
}

export function extractSample({ inputPath, outputPath, durationSeconds = 12 }) {
  run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-t', String(durationSeconds),
    '-c', 'copy', '-y', outputPath], 'Task 6 sample extraction');
}

export function extractCover({ inputPath, outputPath }) {
  run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', inputPath,
    '-frames:v', '1', '-y', outputPath], 'Task 6 cover extraction');
}

export function probeMedia(path) {
  return JSON.parse(run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], 'Task 6 ffprobe').stdout);
}

function frameHash(path, second) {
  return run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', path,
    '-frames:v', '1', '-f', 'md5', '-'], 'Task 6 frame hash').stdout.trim();
}

export function inspectMedia(path) {
  const probe = probeMedia(path);
  const black = run(FFMPEG, ['-hide_banner', '-i', path, '-vf', 'blackdetect=d=0.5:pix_th=0.10',
    '-an', '-f', 'null', '-'], 'Task 6 black detection');
  const silence = run(FFMPEG, ['-hide_banner', '-i', path, '-af', 'silencedetect=n=-50dB:d=3',
    '-vn', '-f', 'null', '-'], 'Task 6 silence detection');
  return {
    probe,
    blackFindings: (black.stderr.match(/black_start:/g) ?? []).length,
    silenceFindings: (silence.stderr.match(/silence_start:/g) ?? []).length,
    frameHashAt1: frameHash(path, 1),
    frameHashAt10: frameHash(path, 10),
  };
}

export function evaluateMediaQa({ probe, blackFindings, silenceFindings, frameHashAt1, frameHashAt10 }) {
  const duration = Number(probe.format?.duration ?? 0);
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  const [numerator, denominator] = String(video?.avg_frame_rate ?? '0/1').split('/').map(Number);
  const fps = denominator ? numerator / denominator : 0;
  const failures = [];
  if (duration < 29.9 || duration > 60.1) failures.push('final_duration_30_to_60_seconds');
  if (!video) failures.push('video_stream_present');
  if (!audio) failures.push('audio_stream_present');
  if (Math.abs(fps - 30) >= 0.01) failures.push('fps_is_30');
  if (blackFindings > 0) failures.push('black_frame_qa_passed');
  if (silenceFindings > 0) failures.push('silence_qa_passed');
  if (frameHashAt1 === frameHashAt10) failures.push('motion_present');
  return { pass: failures.length === 0, failures, duration, fps };
}
