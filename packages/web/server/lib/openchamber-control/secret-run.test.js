import fs from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenChamberControlService } from './service.js';
import { registerOpenChamberControlRoutes } from './routes.js';
import { createSavedSecretStore } from './secret-store.js';
import { createSecretRequests } from './secret-request.js';
import { createSecretLeases, redactSecrets, secretRunCommandLine, SECRET_LEASE_MS } from './secret-run.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createHarness = async ({ enabled = true, now, hasUnreadChat, savedStore, projectForDirectory, resolveSessionDirectory } = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-secret-run-'));
  temporaryDirectories.push(directory);
  const events = new EventEmitter();
  const onWaitChange = vi.fn((change) => events.emit(change.type));
  const leases = createSecretLeases({ now });
  const requests = createSecretRequests({ isEnabled: async () => enabled, files: null, onWaitChange, hasUnreadChat, leases, savedStore, projectForDirectory, resolveSessionDirectory });
  return { directory, requests, onWaitChange, leases, waitForCard: () => once(events, 'waiting') };
};

// The real runtime, so the child, its environment and its output are what a user gets.
const printToken = {
  program: process.execPath,
  args: ['-e', 'console.log("token is " + process.env.API_TOKEN); console.error("user " + process.env.API_USER); process.exit(3)'],
  reason: 'To log in to the staging API.',
  inputs: [{ env: 'API_TOKEN', label: 'Staging API token' }, { env: 'API_USER', label: 'User name' }],
};
const call = (directory, extra = {}) => ({ sessionId: 'ses_1', callId: 'call_1', directory, authorized: true, ...extra });

describe('secret.run', () => {
  it('runs the command once with the values in its environment and keeps them out of the result', async () => {
    const { directory, requests, onWaitChange, waitForCard } = await createHarness();
    const pending = requests.run(printToken, call(directory));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_1', callId: 'call_1' })).toEqual({ fields: ['API_TOKEN', 'API_USER'], reused: [] });
    expect(onWaitChange).toHaveBeenCalledWith(expect.objectContaining({ type: 'waiting', title: 'Staging API token, User name' }));

    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'tok-secret-1', API_USER: 'alice-secret' } }))
      .resolves.toEqual({ status: 'submitted' });
    const result = await pending;

    expect(result.answer).toEqual({ status: 'ran', outcome: 'exited', exitCode: 3 });
    expect(result.stdout.trim()).toBe('token is [secret:API_TOKEN]');
    expect(result.stderr.trim()).toBe('user [secret:API_USER]');
    expect(result.remembered).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/tok-secret-1|alice-secret/);
  });

  it('runs in the session directory', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const pending = requests.run({ ...printToken, args: ['-e', 'console.log(process.cwd())'], inputs: [printToken.inputs[0]] }, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'x-1234' } });
    expect((await pending).stdout.trim()).toBe(await fs.realpath(directory));
  });

  it('reuses only the fields the user let the chat remember, and asks for the rest', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const first = requests.run(printToken, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'tok-secret-1', API_USER: 'alice-secret' }, remember: ['API_TOKEN'] });
    expect((await first).remembered).toEqual(['API_TOKEN']);

    const second = requests.run(printToken, call(directory, { callId: 'call_2' }));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_1', callId: 'call_2' })).toEqual({ fields: ['API_USER'], reused: ['API_TOKEN'] });
    // A value for a field the card did not ask for is refused.
    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_2', values: { API_USER: 'bob', API_TOKEN: 'other' } })).rejects.toMatchObject({ statusCode: 400 });
    requests.answer({ sessionId: 'ses_1', callId: 'call_2', values: { API_USER: 'bob-secret' } });
    const result = await second;
    expect(result.stdout.trim()).toBe('token is [secret:API_TOKEN]');
    expect(result.stderr.trim()).toBe('user [secret:API_USER]');
  });

  it('runs at once when every field is remembered, in this session only', async () => {
    const { directory, requests, leases, onWaitChange, waitForCard } = await createHarness();
    leases.keep('ses_1', 'API_TOKEN', 'tok-secret-1');
    const result = await requests.run({ ...printToken, inputs: [printToken.inputs[0]] }, call(directory));
    expect(onWaitChange).not.toHaveBeenCalled();
    expect(result.stdout.trim()).toBe('token is [secret:API_TOKEN]');

    const other = requests.run({ ...printToken, inputs: [printToken.inputs[0]] }, call(directory, { sessionId: 'ses_2' }));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_2', callId: 'call_1' })).toEqual({ fields: ['API_TOKEN'], reused: [] });
    requests.answer({ sessionId: 'ses_2', callId: 'call_1', declined: true });
    await expect(other).resolves.toMatchObject({ answer: { status: 'declined' } });
  });

  it('forgets a remembered value when its time is up or the agent forgets it', async () => {
    let clock = 1_000;
    const leases = createSecretLeases({ now: () => clock });
    leases.keep('ses_1', 'A', 'one');
    leases.keep('ses_1', 'B', 'two');
    clock += SECRET_LEASE_MS - 1;
    expect(leases.read('ses_1', 'A')).toBe('one');
    clock += 1;
    expect(leases.read('ses_1', 'A')).toBeNull();
    leases.keep('ses_1', 'A', 'again');
    expect(leases.forget('ses_1')).toBe(2);
    expect(leases.read('ses_1', 'A')).toBeNull();
  });

  it('does not run when the user declines', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const marker = path.join(directory, 'ran');
    const pending = requests.run({ ...printToken, args: ['-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`] }, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', declined: true });
    await expect(pending).resolves.toMatchObject({ answer: { status: 'declined' } });
    await expect(fs.access(marker)).rejects.toThrow();
    // A card that stopped waiting has no fields to read.
    expect(() => requests.fields({ sessionId: 'ses_1', callId: 'call_1' })).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it('stops the command when the call is stopped', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const controller = new AbortController();
    const marker = path.join(directory, 'started');
    const pending = requests.run({ ...printToken, args: ['-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "ready"); setTimeout(() => {}, 60000)`], inputs: [printToken.inputs[0]] }, call(directory, { signal: controller.signal }));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'x-1234' } });
    await vi.waitFor(async () => expect(await fs.readFile(marker, 'utf8')).toBe('ready'), { timeout: 10_000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ statusCode: 499 });
  });

  it('reports a timeout and a program that does not start, with the values out of the message', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const slow = requests.run({ ...printToken, args: ['-e', 'setTimeout(() => {}, 60000)'], inputs: [printToken.inputs[0]], timeoutMs: 300 }, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'x-1234' } });
    await expect(slow).resolves.toMatchObject({ answer: { status: 'ran', outcome: 'timeout', exitCode: null } });

    const missing = requests.run({ ...printToken, program: 'no-such-program-oc', inputs: [printToken.inputs[0]] }, call(directory, { callId: 'call_2' }));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_2', values: { API_TOKEN: 'x-1234' } });
    await expect(missing).resolves.toMatchObject({ answer: { outcome: 'not-started' }, error: expect.stringContaining('no-such-program-oc') });
  });

  it('refuses a call that did not come through the secret tool, or that is malformed, before any card', async () => {
    const { directory, requests, onWaitChange } = await createHarness();
    await expect(requests.run(printToken, call(directory, { authorized: false }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(requests.run({ ...printToken, program: '' }, call(directory))).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.run({ ...printToken, inputs: [{ env: 'BAD-NAME', label: 'x' }] }, call(directory))).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.run({ ...printToken, inputs: [printToken.inputs[0], printToken.inputs[0]] }, call(directory))).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.run({ ...printToken, args: 'oops' }, call(directory))).rejects.toMatchObject({ statusCode: 400 });
    expect(onWaitChange).not.toHaveBeenCalled();
  });

  it('does not wait or run when the user wrote in the chat first, remembered values or not', async () => {
    const { directory, requests, onWaitChange, leases } = await createHarness({ hasUnreadChat: async () => true });
    await expect(requests.run(printToken, call(directory))).resolves.toMatchObject({ answer: { answered: false, reason: 'chat-sent-earlier' } });
    expect(onWaitChange).not.toHaveBeenCalled();

    leases.keep('ses_1', 'API_TOKEN', 'tok-secret-1');
    const marker = path.join(directory, 'ran');
    const remembered = { ...printToken, args: ['-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], inputs: [printToken.inputs[0]] };
    await expect(requests.run(remembered, call(directory))).resolves.toMatchObject({ answer: { answered: false, reason: 'chat-sent-earlier' } });
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('refuses a value no environment can hold, so the runtime never quotes it', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const pending = requests.run({ ...printToken, inputs: [printToken.inputs[0]] }, call(directory));
    await waitForCard();
    const nul = String.fromCharCode(0);
    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: `head${nul}tail` } })).rejects.toMatchObject({ statusCode: 400 });
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', declined: true });
    await pending;
  });

  it('drops a secret cut in half where the output was cut at its limit', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const secret = `S${'k'.repeat(15_000)}END-OF-SECRET`;
    // About 1.05 MB, so the runner keeps the last 1 MB and cuts one copy apart.
    const script = 'for (let i = 0; i < 70; i++) process.stdout.write(process.env.API_TOKEN + "\\n")';
    const pending = requests.run({ ...printToken, args: ['-e', script], inputs: [printToken.inputs[0]] }, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: secret } });
    const result = await pending;
    expect(result.truncated).toEqual({ stdout: true, stderr: false });
    expect(result.stdout).not.toContain('END-OF-SECRET');
    expect(result.stdout).not.toContain('kkkk');
    expect(result.stdout).toContain('[secret:API_TOKEN]');
  });

  it('hides a repeating secret cut at the limit, where a shifted match would leave a piece', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const secret = '0123456789'.repeat(1500);
    const script = 'for (let i = 0; i < 70; i++) process.stdout.write(process.env.API_TOKEN + "\\n")';
    const pending = requests.run({ ...printToken, args: ['-e', script], inputs: [printToken.inputs[0]] }, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: secret } });
    const { stdout } = await pending;
    expect(stdout).not.toMatch(/\d/);
  });

  it('answers 403 while the tool is off', async () => {
    const { directory, requests } = await createHarness({ enabled: false });
    await expect(requests.run(printToken, call(directory))).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('saved secret consent', () => {
  const input = { ...printToken, inputs: [printToken.inputs[0]] };
  const identity = { sessionId: 'ses_1', callId: 'call_1' };
  const project = { id: 'project-a', path: '/projects/a' };

  const withSavedToken = async () => {
    let currentDirectory;
    let currentProject = project;
    let entry = { scope: 'project', revision: 'v1', value: 'project-token-fixture' };
    const harness = await createHarness({
      savedStore: { read: () => ({ API_TOKEN: entry }) },
      projectForDirectory: async () => currentProject,
      resolveSessionDirectory: async () => currentDirectory,
    });
    currentDirectory = harness.directory;
    const pending = harness.requests.run(input, call(harness.directory));
    await harness.waitForCard();
    return {
      ...harness, pending,
      moveSession: () => { currentDirectory = '/projects/b'; },
      replaceProject: () => { currentProject = { id: 'project-b', path: '/projects/b' }; },
      replaceToken: () => { entry = { ...entry, revision: 'v2', value: 'replacement-fixture' }; },
    };
  };

  it('persists both scopes across service restarts and revokes only the selected saved credential', async () => {
    let sessionDirectory;
    let currentProject = project;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-saved-secrets-'));
    temporaryDirectories.push(root);
    const filePath = path.join(root, 'private', 'saved-secrets.json');
    const start = async () => {
      const harness = await createHarness({
        savedStore: createSavedSecretStore({ filePath }),
        projectForDirectory: async () => currentProject,
        resolveSessionDirectory: async () => sessionDirectory,
      });
      sessionDirectory = harness.directory;
      return harness;
    };

    const first = await start();
    const save = first.requests.run(printToken, call(first.directory, { sessionId: 'ses_old' }));
    await first.waitForCard();
    try {
      const { consent } = first.requests.fields({ ...identity, sessionId: 'ses_old' });
      await first.requests.answer({
        ...identity, sessionId: 'ses_old', consent,
        values: { API_TOKEN: 'project-fixture', API_USER: 'global-fixture' },
        save: ['API_TOKEN'], saveGlobally: ['API_USER'],
      });
      await expect(save).resolves.toMatchObject({
        stdout: 'token is [secret:API_TOKEN]\n', stderr: 'user [secret:API_USER]\n', remembered: [],
      });
      if (process.platform !== 'win32') {
        expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
      }
    } finally {
      await first.requests.answer({ ...identity, sessionId: 'ses_old', declined: true }).catch(() => undefined);
      await save;
    }

    const next = await start();
    currentProject = { id: 'project-b', path: '/projects/b' };
    const otherProject = next.requests.run(printToken, call(next.directory));
    await next.waitForCard();
    try {
      const fields = next.requests.fields(identity);
      expect(fields.saved).toEqual({ API_USER: 'global' });
      await next.requests.answer({ ...identity, consent: fields.consent, values: { API_TOKEN: 'once-fixture' } });
      await expect(otherProject).resolves.toMatchObject({ stderr: 'user [secret:API_USER]\n' });
    } finally {
      await next.requests.answer({ ...identity, declined: true }).catch(() => undefined);
      await otherProject;
    }

    currentProject = project;
    const sameProject = next.requests.run(printToken, call(next.directory));
    await next.waitForCard();
    try {
      const fields = next.requests.fields(identity);
      expect(fields.saved).toEqual({ API_TOKEN: 'project', API_USER: 'global' });
      const updated = await next.requests.answer({ ...identity, forgetSaved: 'API_TOKEN', consent: fields.consent });
      expect(updated.saved).toEqual({ API_USER: 'global' });
      await expect(next.requests.answer({
        ...identity, consent: fields.consent, values: { API_TOKEN: 'once-fixture' },
      })).rejects.toMatchObject({ statusCode: 409 });
      await next.requests.answer({
        ...identity, consent: updated.consent, values: { API_TOKEN: 'once-fixture' },
      });
      await expect(sameProject).resolves.toMatchObject({
        stdout: 'token is [secret:API_TOKEN]\n', stderr: 'user [secret:API_USER]\n',
      });
    } finally {
      await next.requests.answer({ ...identity, declined: true }).catch(() => undefined);
      await sameProject;
    }

    const later = await start();
    const run = later.requests.run(printToken, call(later.directory));
    await later.waitForCard();
    try {
      expect(later.requests.fields(identity).saved).toEqual({ API_USER: 'global' });
    } finally {
      await later.requests.answer({ ...identity, declined: true });
      await run;
    }
  });

  it('delivers saved credentials through the control service and private HTTP card routes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-secret-control-'));
    temporaryDirectories.push(directory);
    const store = createSavedSecretStore({ filePath: path.join(directory, 'private', 'saved-secrets.json') });
    store.update(project.id, { set: [
      { env: 'API_TOKEN', scope: 'global', value: 'global-http-fixture' },
      { env: 'API_TOKEN', scope: 'project', value: 'project-http-fixture' },
    ] });
    const client = {
      session: {
        inbox: { list: async () => [] },
        list: async () => ({ data: [{ id: identity.sessionId, location: { directory } }] }),
      },
    };
    const events = new EventEmitter();
    const service = createOpenChamberControlService({
      savedSecretStore: store,
      projectForSecretDirectory: async () => project,
      createClient: () => client,
      buildOpenCodeUrl: () => 'http://localhost',
      getOpenCodeAuthHeaders: () => ({}),
      onPageWaitChange: (change) => events.emit(change.type),
    });
    const app = express();
    registerOpenChamberControlRoutes(app, { controlService: service });
    const waiting = once(events, 'waiting');
    const pending = service.execute('secret.run', input, directory, {
      contextSessionId: identity.sessionId, contextCallId: identity.callId, authorized: true,
    });
    await waiting;
    try {
      const browser = request(app);
      const fields = await browser.post('/api/openchamber/secret/fields').send(identity).expect(200);
      expect(fields.body.saved).toEqual({ API_TOKEN: 'project' });
      expect(fields.text).not.toContain('project-http-fixture');
      await browser.post('/api/openchamber/secret/answer').send({ ...identity, values: {} }).expect(409);
      const response = await browser.post('/api/openchamber/secret/answer')
        .send({ ...identity, values: {}, consent: fields.body.consent }).expect(200);
      expect(response.body).toEqual({ status: 'submitted' });
      await expect(pending).resolves.toMatchObject({ stdout: 'token is [secret:API_TOKEN]\n' });
    } finally {
      await service.answerSecret({ ...identity, declined: true }).catch(() => undefined);
      await pending;
    }
  });

  it('shows only the saved scope and runs with the value only after explicit card consent', async () => {
    const { requests, pending } = await withSavedToken();
    try {
      const fields = requests.fields(identity);
      expect(fields).toMatchObject({
        fields: ['API_TOKEN'], reused: [], saved: { API_TOKEN: 'project' },
        projectPath: project.path, consent: expect.any(String),
      });
      expect(JSON.stringify(fields)).not.toContain('project-token-fixture');
      await expect(requests.answer({ ...identity, values: {} })).rejects.toMatchObject({ statusCode: 409 });
      await expect(requests.answer({ ...identity, values: {}, consent: fields.consent })).resolves.toEqual({ status: 'submitted' });
      await expect(pending).resolves.toMatchObject({ stdout: 'token is [secret:API_TOKEN]\n', remembered: [] });
    } finally {
      await requests.answer({ ...identity, declined: true }).catch(() => undefined);
      await pending;
    }
  });

  it.each([
    ['session directory', 'moveSession'],
    ['configured project', 'replaceProject'],
    ['saved value', 'replaceToken'],
  ])('refuses consent when the %s changed while the card was open', async (_changed, change) => {
    const harness = await withSavedToken();
    const { requests, pending } = harness;
    try {
      const { consent } = requests.fields(identity);
      harness[change]();
      await expect(requests.answer({ ...identity, values: {}, consent })).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await requests.answer({ ...identity, declined: true }).catch(() => undefined);
    }
    await expect(pending).resolves.toMatchObject({ answer: { status: 'declined' } });
  });
});

describe('secret run helpers', () => {
  it('replaces every value, a longer one before one inside it', () => {
    expect(redactSecrets('a=abc123 b=abc', { SHORT: 'abc', LONG: 'abc123' })).toBe('a=[secret:LONG] b=[secret:SHORT]');
  });

  it('hides overlapping occurrences together, and the end of a value a cut text starts with', () => {
    expect(redactSecrets('x abab ababab y', { V: 'abab' })).toBe('x [secret:V] [secret:V] y');
    expect(redactSecrets('cdef tail', { V: 'abcdef' }, { cutAtStart: true })).toBe('[secret:V] tail');
    expect(redactSecrets('cdef tail', { V: 'abcdef' })).toBe('cdef tail');
  });

  it('quotes what is not plain and shows characters that would hide or reorder text', () => {
    expect(secretRunCommandLine('wrangler', ['deploy', '--env', 'prod'])).toBe('wrangler deploy --env prod');
    expect(secretRunCommandLine('sh', ['-c', "echo 'hi' && x"])).toBe("sh -c 'echo '\\''hi'\\'' && x'");
    expect(secretRunCommandLine('echo', [`safe${String.fromCharCode(0x202e)}txt`])).toBe("echo 'safe\\u{202E}txt'");
  });
});
