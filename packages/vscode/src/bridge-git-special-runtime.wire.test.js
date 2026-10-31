import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { gitService } from './bridge-git-special-runtime.test-fixture.js';

const { generateBridgeCommitMessage, handleSpecialGitBridgeMessage, resetBridgeGitModelCatalogForTest, setUnavailableRetryDelaysForTest } = await import('./bridge-git-special-runtime');
const directory = '/fixture/中文 folder';
const location = { directory };
const selectedModel = { providerID: 'fixture', modelID: 'fixture-model' };
let server, apiUrl, timeoutSpy;
let requests = [], errors = [], holdGeneration = false;
const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = { method: req.method, path: new URL(req.url, 'http://fixture').pathname, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    requests.push(request);
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (request.path === '/api/model') return send({ location, data: [] });
    if (request.path === '/api/agent/title') return send({ _tag: 'AgentNotFoundError', agentID: 'title', message: 'No configured title agent' }, 404);
    if (request.path === '/api/experimental/generate/text') {
      const error = errors.shift();
      if (error) return send(error, { ModelNotFoundError: 404, ServiceUnavailableError: 503 }[error._tag] ?? 400);
      if (holdGeneration) return;
      return send({ location, data: { text: '{"subject":"fix: synthetic change","highlights":[],"title":"Synthetic PR","body":"Synthetic description"}' } });
    }
    send({ _tag: 'InvalidRequestError', message: 'Unexpected legacy endpoint' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  requests = []; errors = []; holdGeneration = false;
  gitService.getGitRangeFiles.mockImplementation(async () => ['file.ts']);
  gitService.getGitRangeDiff.mockImplementation(async () => ({ diff: '+synthetic change' }));
  gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'file.ts', index: 'M', working_dir: ' ' }] }));
  gitService.getGitLog.mockImplementation(async () => ({ all: [] }));
  gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: '+synthetic change' }));
  resetBridgeGitModelCatalogForTest();
  setUnavailableRetryDelaysForTest([1, 1]);
});
afterEach(() => {
  timeoutSpy?.mockRestore(); timeoutSpy = undefined;
  setUnavailableRetryDelaysForTest();
  server.closeAllConnections();
});
afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

const deps = { readSettings: () => ({}), readPromptOverrides: async () => ({}), execGit: async () => { throw new Error('Unexpected Git execution'); } };
const authHeaders = { Authorization: 'Basic synthetic-fixture' };
const pr = () => handleSpecialGitBridgeMessage({ id: 'fixture', type: 'api:git/pr-description', payload: { directory, base: 'main', head: 'feature', providerId: 'fixture', modelId: 'fixture-model' } }, {
  manager: { getApiUrl: () => apiUrl, getOpenCodeAuthHeaders: () => authHeaders },
}, deps);
const generationRequests = () => requests.filter(request => request.path === '/api/experimental/generate/text');
const missing = { _tag: 'ModelNotFoundError', ...selectedModel, message: 'Synthetic model unavailable' };
const plugin = { _tag: 'ServiceUnavailableError', service: 'plugin', message: 'Location plugins did not finish activating' };

describe('Git generation through the real OpenCode SDK', () => {
  it('sends commit and PR prompts to the text endpoint with auth and directory intact', async () => {
    expect(await generateBridgeCommitMessage({ directory, files: ['file.ts'], apiUrl, authHeaders, settings: {}, promptOverrides: {}, payloadModel: { providerId: 'fixture', modelId: 'fixture-model' }, execGit: deps.execGit })).toMatchObject({ subject: 'fix: synthetic change' });
    expect(await pr()).toMatchObject({ success: true, data: { title: 'Synthetic PR', body: 'Synthetic description' } });
    expect(generationRequests()).toHaveLength(2);
    for (const request of generationRequests()) {
      expect(request.method).toBe('POST');
      expect(request.headers.authorization).toBe('Basic synthetic-fixture');
      expect(request.headers['x-opencode-directory']).toBe(encodeURIComponent(directory));
      expect(request.headers['x-opencode-capabilities'] ?? '').not.toContain('experimental-media-uri');
      expect(request.body.model).toEqual({ providerID: 'fixture', id: 'fixture-model' });
      expect(request.body.prompt).toContain('+synthetic change');
    }
  });

  it.each([missing, plugin])('retries the exact pre-dispatch error %j with the same model and prompt', async error => {
    errors = [error];
    expect((await pr()).success).toBe(true);
    expect(generationRequests()).toHaveLength(2);
    expect(generationRequests()[0].body).toEqual(generationRequests()[1].body);
  });

  it('stops when the bounded pre-dispatch retry schedule runs out', async () => {
    errors = [missing, missing, missing];
    expect((await pr()).success).toBe(false);
    expect(generationRequests()).toHaveLength(3);
  });

  it.each([
    { ...missing, providerID: 'other' },
    { ...missing, modelID: 'other' },
    { ...plugin, service: 'provider' },
    { _tag: 'InvalidRequestError', message: 'Model unavailable: fixture/fixture-model' },
  ])('does not replay unrelated or provider-dispatch errors %j', async error => {
    errors = [error];
    expect((await pr()).success).toBe(false);
    expect(generationRequests()).toHaveLength(1);
  });

  it('applies the same deadline across plugin retry waits', async () => {
    timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation(ms => nativeTimeout(ms === 120_000 ? 40 : ms));
    setUnavailableRetryDelaysForTest([200]);
    errors = [plugin];
    expect((await pr()).success).toBe(false);
    expect(generationRequests()).toHaveLength(1);
  });

  it('aborts a pending generation without replaying it', async () => {
    timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation(ms => nativeTimeout(ms === 120_000 ? 40 : ms));
    holdGeneration = true;
    expect((await pr()).success).toBe(false);
    expect(generationRequests()).toHaveLength(1);
  });
});
