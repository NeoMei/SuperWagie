import { describe, expect, it, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { registerTtsRoutes, speechVoiceHeaderValue } from './routes.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';

const createApp = (sayTTSCapability = null) => {
  const app = express();
  app.use(express.json());
  registerTtsRoutes(app, {
    resolveZenModel: async () => 'gpt-5-nano',
    sayTTSCapability,
  });
  return app;
};

describe('tts routes', () => {
  it.skipIf(process.platform !== 'darwin')('passes voice and text without shell interpretation and isolates concurrent output', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'say-route-test-'));
    const originalPath = process.env.PATH;
    const originalLog = process.env.SAY_TEST_PATH_LOG;
    const logPath = path.join(directory, 'paths');
    const marker = path.join(directory, 'injected');
    await writeFile(path.join(directory, 'say'), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -v|-r) shift 2;;
    -o) output="$2"; shift 2;;
    -f) input_file="$2"; shift 2;;
    --data-format=*) shift;;
    *) input="$1"; shift;;
  esac
done
printf '%s\\n' "$output" >> "$SAY_TEST_PATH_LOG"
if [ -n "$input_file" ]; then cat "$input_file" > "$output"; else printf '%s' "$input" > "$output"; fi
`, { mode: 0o755 });
    process.env.PATH = `${directory}:${originalPath || ''}`;
    process.env.SAY_TEST_PATH_LOG = logPath;
    vi.spyOn(Date, 'now').mockReturnValue(12345);
    try {
      const app = createApp();
      const results = await Promise.all([
        request(app).post('/api/tts/say/speak').send({ text: '-first', voice: `Samantha$(touch ${marker})` }),
        request(app).post('/api/tts/say/speak').send({ text: 'second', voice: 'Samantha' }),
      ]);
      expect(results.map((result) => result.status)).toEqual([200, 200]);
      expect(results.map((result) => result.body.toString())).toEqual(['-first', 'second']);
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      const paths = (await readFile(logPath, 'utf8')).trim().split('\n');
      expect(new Set(paths).size).toBe(2);
      for (const output of paths) await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.restoreAllMocks();
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.SAY_TEST_PATH_LOG; else process.env.SAY_TEST_PATH_LOG = originalLog;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a non-numeric speech rate', async () => {
    const response = await request(createApp()).post('/api/tts/say/speak').send({ text: 'hello', rate: '200; exit 0' });
    expect(response.status).toBe(400);
  });

  it.skipIf(process.platform !== 'darwin')('removes the private temporary directory after say fails', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'say-route-failure-test-'));
    const originalPath = process.env.PATH;
    const originalLog = process.env.SAY_TEST_PATH_LOG;
    const logPath = path.join(directory, 'path');
    await writeFile(path.join(directory, 'say'), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then printf '%s' "$2" > "$SAY_TEST_PATH_LOG"; break; fi
  shift
done
exit 2
`, { mode: 0o755 });
    process.env.PATH = `${directory}:${originalPath || ''}`;
    process.env.SAY_TEST_PATH_LOG = logPath;
    try {
      const response = await request(createApp()).post('/api/tts/say/speak').send({ text: 'hello' });
      expect(response.status).toBe(500);
      const output = await readFile(logPath, 'utf8');
      await expect(readFile(path.join(path.dirname(output), 'input.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.SAY_TEST_PATH_LOG; else process.env.SAY_TEST_PATH_LOG = originalLog;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('waits for the authoritative macOS say capability', async () => {
    let resolveCapability;
    const capability = new Promise((resolve) => {
      resolveCapability = resolve;
    });
    const pending = request(createApp(capability)).get('/api/tts/say/status');

    resolveCapability({ available: true, voices: [{ name: 'Samantha', locale: 'en_US' }] });

    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      available: true,
      voices: [{ name: 'Samantha', locale: 'en_US' }],
    });
  });

  it('switches the say voice to the language of the text when asked to', async () => {
    const capability = Promise.resolve({
      available: true,
      voices: [
        { name: 'Samantha', locale: 'en_US' },
        { name: 'Lesya', locale: 'uk_UA' },
        { name: 'Lesya (Enhanced)', locale: 'uk_UA' },
      ],
    });
    const app = createApp(capability);
    const response = await request(app)
      .post('/api/tts/say/speak')
      .send({ text: 'Привіт! Це відповідь українською мовою, і вона досить довга.', voice: 'Samantha', language: 'auto' });

    // On macOS the route synthesizes; elsewhere it refuses before running say.
    // Either way the chosen voice must be the Ukrainian one when the platform
    // allows the request to proceed.
    if (process.platform === 'darwin') {
      expect(response.status).toBe(200);
      expect(response.headers['x-speech-voice']).toBe('Lesya%20(Enhanced)');
      expect(response.headers['x-speech-language']).toBe('uk');
    } else {
      expect(response.status).toBe(503);
    }
  });

  it('keeps localized say voice names HTTP-header-safe', () => {
    const encoded = speechVoiceHeaderValue('Milena (Русский (Россия))');
    // Header values must stay printable ASCII or Node rejects the response outright.
    expect(encoded).toMatch(/^[\x21-\x7E]*$/);
    expect(decodeURIComponent(encoded)).toBe('Milena (Русский (Россия))');
    expect(speechVoiceHeaderValue('Samantha')).toBe('Samantha');
  });

  it('refuses OpenAI cloud speech in enterprise mode and says so in the status', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = 'true';
    try {
      const app = createApp();
      const status = await request(app).get('/api/tts/status');
      expect(status.body).toMatchObject({ available: false, enterpriseMode: true });
      const speak = await request(app).post('/api/tts/speak').send({ text: 'The migration is done', apiKey: 'sk-test' });
      expect(speak.status).toBe(403);
      expect((await request(app).post('/api/voice/token').send({})).status).toBe(403);
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('returns local note fallback while model summarization is retired', async () => {
    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({
        text: 'First sentence. Second sentence with the useful insight.',
        threshold: 0,
        maxLength: 100,
        mode: 'note',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: 'First sentence.',
      summarized: false,
      reason: 'Model summarization provider unavailable',
    });
  });

  it('keeps notification fallback behavior without calling zen', async () => {
    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({
        text: 'Notification text that should fall back cleanly.',
        threshold: 0,
        maxLength: 100,
        mode: 'notification',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: 'Notification text that should fall back cleanly.',
      summarized: false,
      reason: 'Model summarization provider unavailable',
    });
  });
});

describe('normalizeCustomOpenAIBaseURL', () => {
  const originalRuntime = process.env.OPENCHAMBER_RUNTIME;
  const originalAllowRemote = process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;

  afterEach(() => {
    // Restore env vars after each test
    if (originalRuntime === undefined) {
      delete process.env.OPENCHAMBER_RUNTIME;
    } else {
      process.env.OPENCHAMBER_RUNTIME = originalRuntime;
    }
    if (originalAllowRemote === undefined) {
      delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;
    } else {
      process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS = originalAllowRemote;
    }
  });

  it('rejects remote URLs when OPENCHAMBER_RUNTIME is not set (web)', () => {
    delete process.env.OPENCHAMBER_RUNTIME;
    delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;

    const result = normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1');
    expect(result.error).toMatch(/Remote custom server URLs are disabled/);
    expect(result.value).toBeUndefined();
  });

  it('allows remote URLs when OPENCHAMBER_RUNTIME is desktop', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';
    delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;

    const result = normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('https://my-tts-server.example.com/v1');
  });

  it('allows remote URLs when OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS is true', () => {
    delete process.env.OPENCHAMBER_RUNTIME;
    process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS = 'true';

    const result = normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('https://my-tts-server.example.com/v1');
  });

  it('allows localhost URLs regardless of runtime', () => {
    delete process.env.OPENCHAMBER_RUNTIME;
    delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;

    const result = normalizeCustomOpenAIBaseURL('http://localhost:8880/v1');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('http://localhost:8880/v1');
  });

  it('strips query strings and trailing slashes', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';

    const result = normalizeCustomOpenAIBaseURL('https://my-server.com/v1/?key=123');
    expect(result.value).toBe('https://my-server.com/v1');
  });

  it('keeps custom servers on this machine in enterprise mode, whatever else allows remote', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';
    process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS = 'true';
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      expect(normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1').error).toMatch(/enterprise mode/);
      expect(normalizeCustomOpenAIBaseURL('http://127.0.0.1:8880/v1').value).toBe('http://127.0.0.1:8880/v1');
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('denies remote URLs on desktop when env var is explicitly false', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';
    process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS = 'false';

    const result = normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1');
    expect(result.error).toMatch(/Remote custom server URLs are disabled/);
    expect(result.value).toBeUndefined();
  });
});
