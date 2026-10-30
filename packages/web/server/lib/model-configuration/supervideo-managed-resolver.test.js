import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

import { createModelConfigurationRuntime } from './runtime.js';
import { resolveSpeechBinding, configuredDefaultVoice, requestConfiguredSpeech } from '../../builtin-skills/supervideo-engine/src/providers/model-configuration.mjs';
import { createProject } from '../../builtin-skills/supervideo-engine/src/core/store.mjs';
import { synthesize } from '../../builtin-skills/supervideo-engine/src/providers/tts.mjs';

const directories = [];
const hasAudioTools = ['ffmpeg', 'ffprobe'].every((command) => spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0);
const previous = { ...process.env };
afterEach(async () => {
  for (const key of ['OPENCHAMBER_DATA_DIR', 'SUPERWAGIE_MODEL_RESOLVER', 'SUPERWAGIE_MODEL_NODE', 'OPENCHAMBER_UNIHUB_PROXY_URL', 'OPENCHAMBER_UNIHUB_PROXY_TOKEN']) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it.skipIf(!hasAudioTools).each([
  ['audio/mpeg', 'mp3', true],
  ['audio/wav; rate=24000', 'wav', true],
  ['audio/wav', 'mp3', false],
  ['audio/mp3', 'wav', false],
])('checks real %s audio against its %s container', async (contentType, container, matches) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'supervideo-managed-real-audio-'));
  directories.push(dataDir);
  const runtime = createModelConfigurationRuntime({ dataDir });
  const state = await runtime.saveConnection({ revision: 0, connection: { name: 'Managed', providerId: 'unihub', protocol: 'managed-media', baseUrl: 'https://llmrouter.quukk.com/platform/v1', apiKey: 'requires-managed-session' } });
  await runtime.saveBinding('tts', { revision: state.revision, binding: { connectionId: state.connections[0].id, model: 'qwen3-tts-flash', parameters: {} } });
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
  process.env.SUPERWAGIE_MODEL_RESOLVER = fileURLToPath(new URL('./resolve-cli.js', import.meta.url));
  process.env.SUPERWAGIE_MODEL_NODE = process.execPath;
  const projectDir = path.join(dataDir, 'project');
  await createProject(projectDir, { mode: 'book', output: { width: 1280, height: 720, fps: 30 } });
  const voice = await configuredDefaultVoice();
  const bytes = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.2', '-f', container, '-']);
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the request */ }
    res.writeHead(200, { 'content-type': contentType });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.OPENCHAMBER_UNIHUB_PROXY_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.OPENCHAMBER_UNIHUB_PROXY_TOKEN = 'fixture-token';
  try {
    const result = synthesize(projectDir, { id: 'sentence-1', text: 'local fixture' }, { voice, runtime: { ffprobe: 'ffprobe', ffmpeg: 'ffmpeg' } });
    if (matches) {
      const segment = await result;
      expect(path.extname(segment.path)).toBe(container === 'wav' ? '.wav' : '.mp3');
      expect(await fs.readFile(path.join(projectDir, segment.path))).toEqual(bytes);
    } else {
      await expect(result).rejects.toMatchObject({ code: 'OUTPUT_INVALID' });
    }
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }
});

// The audio-probe fixtures below are POSIX shell executables.
it.skipIf(process.platform === 'win32').each([
  ['audio/mpeg', '.mp3'],
  ['audio/mpeg; charset=binary', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/wav; rate=24000', '.wav'],
])('synthesizes managed narration with %s and saves the correct %s asset', async (contentType, extension) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'supervideo-managed-project-'));
  directories.push(dataDir);
  const runtime = createModelConfigurationRuntime({ dataDir });
  let state = await runtime.saveConnection({ revision: 0, connection: { name: 'Managed', providerId: 'unihub', protocol: 'managed-media', baseUrl: 'https://llmrouter.quukk.com/platform/v1', apiKey: 'requires-managed-session' } });
  await runtime.saveBinding('tts', { revision: state.revision, binding: { connectionId: state.connections[0].id, model: 'qwen3-tts-flash', parameters: {} } });
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
  process.env.SUPERWAGIE_MODEL_RESOLVER = fileURLToPath(new URL('./resolve-cli.js', import.meta.url));
  process.env.SUPERWAGIE_MODEL_NODE = process.execPath;
  const projectDir = path.join(dataDir, 'project');
  await createProject(projectDir, { mode: 'book', output: { width: 1280, height: 720, fps: 30 } });
  const voice = await configuredDefaultVoice();
  expect(voice).toEqual({ provider: 'managed-media', model: 'qwen3-tts-flash', voice: 'Cherry' });

  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'content-type': contentType });
    res.end(Buffer.from('fixture-audio'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.OPENCHAMBER_UNIHUB_PROXY_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.OPENCHAMBER_UNIHUB_PROXY_TOKEN = 'fixture-token';
  const ffprobe = path.join(dataDir, 'ffprobe');
  const ffmpeg = path.join(dataDir, 'ffmpeg');
  await fs.writeFile(ffprobe, '#!/bin/sh\nfor arg do last=$arg; done\ncase "$last" in *.wav) format=wav;; *) format=mp3;; esac\nprintf \'%s\\n\' "{\\"streams\\":[{\\"codec_type\\":\\"audio\\",\\"channels\\":1,\\"sample_rate\\":24000,\\"duration\\":\\"1\\"}],\\"format\\":{\\"format_name\\":\\"$format\\"}}"\n', { mode: 0o755 });
  await fs.writeFile(ffmpeg, '#!/bin/sh\nprintf \'%s\\n\' \'mean_volume: -10.0 dB\' \'max_volume: -3.0 dB\' >&2\n', { mode: 0o755 });
  try {
    const segment = await synthesize(projectDir, { id: 'sentence-1', text: 'local fixture' }, { voice, runtime: { ffprobe, ffmpeg } });
    expect(path.extname(segment.path)).toBe(extension);
    expect(await fs.readFile(path.join(projectDir, segment.path), 'utf8')).toBe('fixture-audio');
    expect(segment.providerReceipt).toEqual({ provider: 'managed', model: 'qwen3-tts-flash', voice: 'Cherry', status: 'succeeded' });
    expect(requests).toEqual([{ model: 'qwen3-tts-flash', text: 'local fixture', voice: 'Cherry' }]);
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }
});

it('resolves a managed narration model through the real child resolver', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'supervideo-managed-resolver-'));
  directories.push(dataDir);
  const runtime = createModelConfigurationRuntime({ dataDir });
  let state = await runtime.saveConnection({ revision: 0, connection: { name: 'Managed', providerId: 'unihub', protocol: 'managed-media', baseUrl: 'https://llmrouter.quukk.com/platform/v1', apiKey: 'requires-managed-session' } });
  state = await runtime.saveBinding('tts', { revision: state.revision, binding: { connectionId: state.connections[0].id, model: 'qwen3-tts-flash', parameters: {} } });
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
  process.env.SUPERWAGIE_MODEL_RESOLVER = fileURLToPath(new URL('./resolve-cli.js', import.meta.url));
  process.env.SUPERWAGIE_MODEL_NODE = process.execPath;
  const binding = await resolveSpeechBinding();
  expect(binding).toMatchObject({ protocol: 'managed-media', model: 'qwen3-tts-flash' });
  const voice = await configuredDefaultVoice();
  expect(voice).toEqual({ provider: 'managed-media', model: 'qwen3-tts-flash', voice: 'Cherry' });
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(Buffer.from('fixture-audio'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.OPENCHAMBER_UNIHUB_PROXY_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.OPENCHAMBER_UNIHUB_PROXY_TOKEN = 'fixture-token';
  try {
    const output = await requestConfiguredSpeech('local fixture', voice);
    expect(output.bytes.toString()).toBe('fixture-audio');
    expect(output.evidence).toMatchObject({ provider: 'managed', model: 'qwen3-tts-flash', voice: 'Cherry' });
    expect(requests).toEqual([{ url: '/media/speech', authorization: 'Bearer fixture-token', body: { model: 'qwen3-tts-flash', text: 'local fixture', voice: 'Cherry' } }]);
    expect(JSON.stringify(output.evidence)).not.toContain('fixture-token');
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }
});
