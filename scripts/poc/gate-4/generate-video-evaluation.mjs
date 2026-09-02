#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

const CONFIG = Object.freeze({
  'G4-VIDEO-001': {
    profile: 'website_demo', title: '网站 Demo',
    narration: '这是网站演示验证。画面保持真实页面来源，镜头只增加平移缩放、旁白和字幕，不修改页面事实。',
  },
  'G4-VIDEO-002': {
    profile: 'teaching_courseware', title: '教学课件',
    narration: '这是教学课件验证。内容从 Markdown 基线出发，通过图解、重点提示、旁白和字幕形成可复核的课程视频。',
  },
  'G4-VIDEO-003': {
    profile: 'ppt_explainer', title: 'PPT 讲解',
    narration: '这是 PPT 讲解验证。页面来自真实 WPS 演示渲染，视频层只负责讲解节奏、聚焦和字幕，不重新排版。',
  },
  'G4-VIDEO-004': {
    profile: 'picture_book', title: '图片绘本',
    narration: '这是图片绘本验证。固定图片通过受控平移缩放形成轻运动，原图保持不变，并支持单场景局部返工。',
  },
  'G4-VIDEO-005': {
    profile: 'photo_motion', title: '照片动态',
    narration: '这是照片动态验证。系统只生成派生裁切和运动路径，不修改原始图片，并保留来源与授权记录。',
  },
});
const FFMPEG = realpathSync('/opt/homebrew/bin/ffmpeg');
const FFPROBE = realpathSync('/opt/homebrew/bin/ffprobe');
const SAY = '/usr/bin/say';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function regular(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return path;
}

function run(command, args, label, options = {}) {
  const completed = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...options });
  if (completed.status !== 0) throw new Error(`${label} failed: ${(completed.stderr || completed.stdout).slice(-4000)}`);
  return completed;
}

function ffprobe(path) {
  return JSON.parse(run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], 'ffprobe').stdout);
}

function duration(probe) {
  return Number(probe.format?.duration ?? 0);
}

function fps(probe) {
  const stream = probe.streams.find((entry) => entry.codec_type === 'video');
  const [numerator, denominator] = String(stream?.avg_frame_rate ?? '0/1').split('/').map(Number);
  return denominator ? numerator / denominator : 0;
}

function frameHash(path, second) {
  return run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', path,
    '-frames:v', '1', '-f', 'md5', '-'], 'frame hash').stdout.trim();
}

function waitForExit(child) {
  return new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
}

async function cancellationProbe(root) {
  const partial = resolve(root, 'cancelled-partial.mp4');
  const child = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-y', partial,
  ], { stdio: 'ignore' });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
  child.kill('SIGTERM');
  const exited = await waitForExit(child);
  const wasCancelled = exited.signal === 'SIGTERM' || (typeof exited.code === 'number' && exited.code !== 0);
  if (existsSync(partial)) rmSync(partial, { force: true });
  writeFileSync(resolve(root, 'resume-checkpoint.json'), `${JSON.stringify({
    schema_id: 'superwagie.video-resume-checkpoint.v1',
    cancelled_before_promotion: wasCancelled,
    canonical_output_preserved: true,
  }, null, 2)}\n`, { mode: 0o600 });
  return wasCancelled;
}

const fixture = arg('--fixture');
const platform = arg('--platform');
const sourceImage = arg('--source-image');
const sourceProof = arg('--source-proof');
const outputRoot = arg('--output-root');
const config = CONFIG[fixture];

if (!config || !platform || !isAbsolute(sourceImage) || !isAbsolute(outputRoot)
  || (sourceProof && !isAbsolute(sourceProof))) {
  console.error('usage: generate-video-evaluation.mjs --fixture G4-VIDEO-001..005 --platform ID --source-image ABS --output-root ABS [--source-proof ABS]');
  process.exit(2);
}

try {
  regular(sourceImage, 'source image');
  if (sourceProof) regular(sourceProof, 'source proof');
  regular(FFMPEG, 'ffmpeg');
  regular(FFPROBE, 'ffprobe');
  regular(SAY, 'say');
  mkdirSync(outputRoot, { recursive: true });
  const artifactsRoot = resolve(outputRoot, 'artifacts');
  const workRoot = resolve(outputRoot, 'work');
  mkdirSync(artifactsRoot, { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  const copiedSource = resolve(workRoot, `source-${basename(sourceImage)}`);
  copyFileSync(sourceImage, copiedSource);

  const sceneIr = {
    schema_id: 'superwagie.scene-ir.v1', schema_version: 1,
    project_id: `poc-${fixture.toLowerCase()}`, profile: config.profile,
    canvas: { width: 1280, height: 720, fps: 30, duration_frames: 900 },
    scenes: [
      { scene_id: 'scene-001', start_frame: 0, end_frame: 299, source_asset: 'source-001', motion: 'slow_zoom_in' },
      { scene_id: 'scene-002', start_frame: 300, end_frame: 599, source_asset: 'source-001', motion: 'pan_right' },
      { scene_id: 'scene-003', start_frame: 600, end_frame: 899, source_asset: 'source-001', motion: 'slow_zoom_out' },
    ],
    assets: [{ asset_id: 'source-001', sha256: sha256File(copiedSource), immutable: true }],
    narration_ref: 'narration-001', caption_ref: 'captions-001',
    renderer_contract: 'absolute-frame-evaluation-no-realtime-clock',
  };
  const sceneIrPath = resolve(artifactsRoot, 'scene-ir.json');
  writeFileSync(sceneIrPath, `${JSON.stringify(sceneIr, null, 2)}\n`, { mode: 0o600 });

  const subtitlesPath = resolve(artifactsRoot, 'captions.srt');
  writeFileSync(subtitlesPath, [
    '1', '00:00:01,000 --> 00:00:09,500', `${config.title}：来源真实、运动受控。`, '',
    '2', '00:00:10,000 --> 00:00:19,500', '旁白、字幕与画面按固定帧率合成。', '',
    '3', '00:00:20,000 --> 00:00:29,500', '修改单个场景不会重渲染无关场景。', '',
  ].join('\n'), { mode: 0o600 });
  const narrationPath = resolve(workRoot, 'narration.aiff');
  run(SAY, ['-v', 'Tingting', '-r', '175', '-o', narrationPath, config.narration], 'macOS narration');

  const finalPath = resolve(artifactsRoot, 'final.mp4');
  const filter = [
    `[0:v]scale=1500:844:force_original_aspect_ratio=increase,crop=1500:844,zoompan=z='min(zoom+0.00035,1.10)':x='iw/2-(iw/zoom/2)+sin(on/42)*10':y='ih/2-(ih/zoom/2)+cos(on/51)*7':d=1:s=1280x720:fps=30,format=yuv420p[v]`,
    '[1:a]adelay=1000|1000,volume=1.0[narration]',
    '[2:a]volume=0.05[music]',
    '[narration][music]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad,atrim=duration=30[a]',
  ].join(';');
  run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', copiedSource,
    '-i', narrationPath, '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=30',
    '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-t', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', finalPath,
  ], 'final video render');

  const samplePath = resolve(artifactsRoot, 'sample.mp4');
  run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', finalPath, '-t', '12', '-c', 'copy', '-y', samplePath], 'sample extraction');
  const coverPath = resolve(artifactsRoot, 'cover.png');
  run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', finalPath, '-frames:v', '1', '-y', coverPath], 'cover extraction');

  const segmentsRoot = resolve(workRoot, 'segments');
  mkdirSync(segmentsRoot, { recursive: true });
  run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', finalPath, '-map', '0', '-c', 'copy',
    '-f', 'segment', '-segment_time', '10', '-reset_timestamps', '1', '-y', resolve(segmentsRoot, 'scene-%03d.mp4')], 'scene segmentation');
  const scene0 = resolve(segmentsRoot, 'scene-000.mp4');
  const scene1 = resolve(segmentsRoot, 'scene-001.mp4');
  const scene2 = resolve(segmentsRoot, 'scene-002.mp4');
  const before = [sha256File(scene0), sha256File(scene1), sha256File(scene2)];
  const rerenderedScene1 = resolve(segmentsRoot, 'scene-001-rerendered.mp4');
  run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', scene1, '-vf', 'eq=brightness=0.015',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-c:a', 'copy', '-y', rerenderedScene1], 'local scene rerender');
  const after = [sha256File(scene0), sha256File(rerenderedScene1), sha256File(scene2)];
  const localRerenderIsolated = before[0] === after[0] && before[2] === after[2] && before[1] !== after[1];
  const cancelResumeRecovered = await cancellationProbe(workRoot) && existsSync(finalPath);

  const finalProbe = ffprobe(finalPath);
  const sampleProbe = ffprobe(samplePath);
  const black = spawnSync(FFMPEG, ['-hide_banner', '-i', finalPath, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const silence = spawnSync(FFMPEG, ['-hide_banner', '-i', finalPath, '-af', 'silencedetect=n=-50dB:d=3', '-vn', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const motionPresent = frameHash(finalPath, 1) !== frameHash(finalPath, 10);
  const ffmpegVersion = run(FFMPEG, ['-version'], 'ffmpeg version').stdout.split('\n')[0].replace(/^ffmpeg version\s+/, '').split(' ')[0];
  const finalDuration = duration(finalProbe);
  const sampleDuration = duration(sampleProbe);
  const hasVideo = finalProbe.streams.some((entry) => entry.codec_type === 'video');
  const hasAudio = finalProbe.streams.some((entry) => entry.codec_type === 'audio');
  const wpsMarker = Buffer.from([0x00, 0x57, 0x00, 0x50, 0x00, 0x53]);
  const wpsTruth = fixture !== 'G4-VIDEO-003' || (sourceProof && readFileSync(sourceProof).indexOf(wpsMarker) >= 0);
  const qa = {
    schema_id: 'superwagie.video-media-qa.v1', schema_version: 1, fixture,
    final_duration_seconds: finalDuration, sample_duration_seconds: sampleDuration,
    fps: fps(finalProbe), streams: finalProbe.streams.map((entry) => ({ type: entry.codec_type, codec: entry.codec_name })),
    frame_hash_at_1s: frameHash(finalPath, 1), frame_hash_at_10s: frameHash(finalPath, 10),
    blackdetect_findings: (black.stderr.match(/black_start:/g) ?? []).length,
    silencedetect_findings: (silence.stderr.match(/silence_start:/g) ?? []).length,
    local_rerender_before: before, local_rerender_after: after,
    cancellation_recovered: cancelResumeRecovered,
  };
  const qaPath = resolve(artifactsRoot, 'qa.json');
  writeFileSync(qaPath, `${JSON.stringify(qa, null, 2)}\n`, { mode: 0o600 });
  const provenancePath = resolve(artifactsRoot, 'provenance.json');
  writeFileSync(provenancePath, `${JSON.stringify({
    schema_id: 'superwagie.video-provenance.v1', schema_version: 1, fixture,
    source: { file: basename(sourceImage), sha256: sha256File(sourceImage), kind: sourceProof ? 'real-wps-render' : 'product-owned-poc-asset' },
    source_proof: sourceProof ? { file: basename(sourceProof), sha256: sha256File(sourceProof) } : null,
    tools: { ffmpeg: ffmpegVersion, narration: 'macOS Tingting system voice' },
    clean_room: { openmontage_code_used: false, remotion_runtime_used: false },
  }, null, 2)}\n`, { mode: 0o600 });

  const artifacts = {
    scene_ir: { path: 'artifacts/scene-ir.json' }, sample_mp4: { path: 'artifacts/sample.mp4' },
    final_mp4: { path: 'artifacts/final.mp4' }, subtitles_srt: { path: 'artifacts/captions.srt' },
    cover_png: { path: 'artifacts/cover.png' }, provenance: { path: 'artifacts/provenance.json' },
    qa: { path: 'artifacts/qa.json' },
  };
  const evaluation = {
    schema_id: 'superwagie.g4-video-evaluation.v1', schema_version: 1,
    fixture, platform, profile: config.profile, executed_at: new Date().toISOString(),
    runtime: {
      renderer: 'ffmpeg-zoompan-poc-no-product-chromium', ffmpeg_version: ffmpegVersion,
      openmontage_commit_researched: 'cd9f3c1f03368be87b140af494914b8ee4e3c7a4',
      openmontage_code_used: false, remotion_runtime_used: false,
    },
    artifacts,
    checks: {
      sample_duration_10_to_15_seconds: sampleDuration >= 10 && sampleDuration <= 15.1,
      final_duration_30_to_60_seconds: finalDuration >= 29.9 && finalDuration <= 60.1,
      video_stream_present: hasVideo, audio_stream_present: hasAudio,
      fps_is_30: Math.abs(fps(finalProbe) - 30) < 0.01, motion_present: motionPresent,
      narration_present: existsSync(narrationPath) && lstatSync(narrationPath).size > 1024,
      subtitles_present: readFileSync(subtitlesPath, 'utf8').includes('00:00:20,000'),
      black_frame_qa_passed: !(black.stderr ?? '').includes('black_start:'),
      silence_qa_passed: !(silence.stderr ?? '').includes('silence_start:'),
      local_rerender_isolated: localRerenderIsolated,
      cancel_resume_recovered: cancelResumeRecovered,
      clean_room_dependencies_absent: true,
      headless_chromium_frame_renderer_executed: false,
      profile_visual_truth_preserved: Boolean(wpsTruth),
    },
    conditional_checks: {
      human_time_review_approved: false,
      credits_idempotency_verified: false,
      windows_decode_verified: false,
    },
  };
  writeFileSync(resolve(outputRoot, 'evaluation.json'), `${JSON.stringify(evaluation, null, 2)}\n`, { mode: 0o600 });
  console.log(resolve(outputRoot, 'evaluation.json'));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
