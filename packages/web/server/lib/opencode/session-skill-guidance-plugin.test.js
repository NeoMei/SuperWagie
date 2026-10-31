import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createManagedConfigRuntime } from './managed-config-file.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const prefix = [
  'Skills provide specialized instructions and workflows for specific tasks.',
  'Use the skill tool to load a skill when a task matches its description.',
  'The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.',
];
const skill = (id) => ({ id, name: id, description: `Use ${id} for its task.`, path: `/skills/${id}/SKILL.md`, content: 'Private skill body' });
const render = (skills) => [...prefix, ...skills.length ? ['<available_skills>', ...skills.flatMap((entry) => [
  '  <skill>', `    <id>${entry.id}</id>`, `    <name>${entry.name}</name>`,
  `    <description>${entry.description}</description>`, '  </skill>',
]), '</available_skills>'] : ['No skills are currently available.']].join('\n');

const fixture = async ({ rules = [], sessionRules = [], skills = [skill('read'), skill('write')] } = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-skill-guidance-'));
  directories.push(directory);
  const runtime = createManagedConfigRuntime({ fsPromises: fs, path, instanceDir: directory, env: {}, readSettings: () => ({}), isAgentMemoryAvailable: () => false });
  const env = await runtime.buildManagedChildEnv();
  const config = JSON.parse(await fs.readFile(env.OPENCODE_CONFIG, 'utf8'));
  const hooks = new Map();
  const state = {
    session: { id: 'session', agent: 'focused', model: { providerID: 'fixture', id: 'model' }, location: { directory: '/repo' }, permissions: sessionRules },
    agent: { location: { directory: '/repo' }, data: { id: 'focused', permissions: rules } },
    skills: { location: { directory: '/repo' }, data: skills },
  };
  let reads = 0;
  for (const entry of config.plugins.filter((value) => !value.startsWith('-'))) {
    const manifest = JSON.parse(await fs.readFile(path.join(entry, 'package.json'), 'utf8'));
    if (manifest.name !== 'openchamber-session-skill-guidance') continue;
    const plugin = (await import(pathToFileURL(path.join(entry, 'index.js')).href)).default;
    await plugin.setup({
      session: { hook: async (kind, callback) => hooks.set(kind, callback), get: async () => { state.beforeRead?.(++reads); return structuredClone(state.session); } },
      agent: { get: async () => structuredClone(state.agent) },
      skill: { list: async () => structuredClone(state.skills) },
    });
  }
  const instructions = [{ key: 'core/instructions', text: 'Keep the original repository instructions.' }, { key: 'core/skill-guidance', text: render(skills) }, { key: 'core/date', text: 'Date stays unchanged.' }];
  const event = {
    sessionID: 'session', agent: 'focused', model: { providerID: 'fixture', id: 'model' },
    system: [{ text: 'Agent system stays unchanged.' }, { text: instructions.map((entry) => entry.text).join('\n\n'), metadata: { experimental: { instructions } } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'The retained original request.' }] }],
    options: { maxTokens: 64 }, tools: {},
  };
  return { hooks, state, event };
};

describe('current skill permissions in persisted session guidance', () => {
  it.each(['compaction', 'context'])('removes only denied skill guidance from the %s request and retains the complete history', async (kind) => {
    const { hooks, event } = await fixture({ rules: [{ action: 'skill', resource: 'write', effect: 'deny' }] });
    const before = structuredClone(event);
    await hooks.get(kind)?.(event);

    expect(event.system[1].text).not.toContain('<id>write</id>');
    expect(event.system[1].text).toContain('<id>read</id>');
    expect(event.messages).toEqual(before.messages);
    expect(event.system[0]).toEqual(before.system[0]);
    expect(event.system[1].metadata.experimental.instructions[0]).toEqual(before.system[1].metadata.experimental.instructions[0]);
    expect(event.system[1].metadata.experimental.instructions[2]).toEqual(before.system[1].metadata.experimental.instructions[2]);
    expect(event.options).toEqual({ maxTokens: 64 });
  });

  it.each([
    { rules: [{ action: 'skill', resource: '*', effect: 'deny' }], sessionRules: [{ action: 'skill', resource: 'read', effect: 'allow' }], keep: 'read', remove: 'write' },
    { rules: [{ action: '*', resource: '*', effect: 'allow' }], sessionRules: [{ action: 'sk?ll', resource: 'writ*', effect: 'deny' }], keep: 'read', remove: 'write' },
  ])('uses the native last-match permissions and keeps session overrides', async ({ rules, sessionRules, keep, remove }) => {
    const { hooks, event } = await fixture({ rules, sessionRules });
    await hooks.get('compaction')(event);
    expect(event.system[1].text).toContain(`<id>${keep}</id>`);
    expect(event.system[1].text).not.toContain(`<id>${remove}</id>`);
  });

  it('keeps every allowed skill and the request byte-for-byte when no skill is denied', async () => {
    const { hooks, event } = await fixture({ skills: Array.from({ length: 150 }, (_, index) => skill(`skill-${index}`)), rules: [{ action: '*', resource: '*', effect: 'allow' }] });
    const before = JSON.stringify(event);
    await hooks.get('context')(event);
    expect(JSON.stringify(event)).toBe(before);
  });

  it('renders the native empty-skill guidance after an explicit deny-all', async () => {
    const { hooks, event } = await fixture({ sessionRules: [{ action: '*', resource: '*', effect: 'deny' }] });
    await hooks.get('context')(event);
    expect(event.system[1].metadata.experimental.instructions[1].text).toBe(`${prefix.join('\n')}\nNo skills are currently available.`);
  });

  it.each(['compaction', 'context'])('removes historical skill descriptions after an explicit deny-all in %s', async (kind) => {
    const { hooks, state, event } = await fixture({ sessionRules: [{ action: '*', resource: '*', effect: 'deny' }] });
    const before = structuredClone(event);
    state.skills.data[0].description = 'The current registry description differs from the persisted instruction epoch.';
    await hooks.get(kind)(event);
    expect(event.system[1].metadata.experimental.instructions[1].text).toBe(`${prefix.join('\n')}\nNo skills are currently available.`);
    expect(event.messages).toEqual(before.messages);
    expect(event.system[0]).toEqual(before.system[0]);
    expect(event.system[1].metadata.experimental.instructions[0]).toEqual(before.system[1].metadata.experimental.instructions[0]);
    expect(event.system[1].metadata.experimental.instructions[2]).toEqual(before.system[1].metadata.experimental.instructions[2]);
    expect(event.options).toEqual(before.options);
  });

  it('removes historical skills no longer in the current registry only under an explicit deny-all', async () => {
    const { hooks, state, event } = await fixture({ sessionRules: [{ action: 'sk?ll', resource: '*', effect: 'deny' }, { action: 'skill', resource: 'read', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }] });
    state.skills.data.pop();
    await hooks.get('compaction')(event);
    expect(event.system[1].metadata.experimental.instructions[1].text).toBe(`${prefix.join('\n')}\nNo skills are currently available.`);
  });

  it.each(['allow', 'ask'])('preserves historical guidance when a later skill rule can %s a skill', async (effect) => {
    const { hooks, state, event } = await fixture({ sessionRules: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'skill', resource: 'read', effect }] });
    state.skills.data[0].description = 'Changed current registry description.';
    const before = JSON.stringify(event);
    await hooks.get('compaction')(event);
    expect(JSON.stringify(event)).toBe(before);
  });

  it.each([
    ['unknown guidance', (event) => {
      event.system[1].metadata.experimental.instructions[1].text = 'Unknown skill instructions';
      event.system[1].text = event.system[1].metadata.experimental.instructions.map((entry) => entry.text).join('\n\n');
    }],
    ['changed envelope', (event) => {
      event.system[1].metadata.experimental.instructions[1].text += '\nExtra instruction';
      event.system[1].text = event.system[1].metadata.experimental.instructions.map((entry) => entry.text).join('\n\n');
    }],
    ['text differing from metadata', (event) => { event.system[1].text += '\nExtra instruction'; }],
  ])('keeps %s under an explicit deny-all', async (_name, change) => {
    const { hooks, event } = await fixture({ sessionRules: [{ action: '*', resource: '*', effect: 'deny' }] });
    change(event);
    const before = JSON.stringify(event);
    await hooks.get('compaction')(event);
    expect(JSON.stringify(event)).toBe(before);
  });

  it.each([
    ['unknown guidance markup', (f) => { f.event.system[1].metadata.experimental.instructions[1].text = 'Unrecognized skill instructions'; }],
    ['text different from native metadata', (f) => { f.event.system[1].text += '\nA plugin-added instruction'; }],
    ['registry description changed', (f) => { f.state.skills.data[0].description = 'New meaning'; }],
    ['registry skill missing', (f) => { f.state.skills.data.pop(); }],
    ['wrong session', (f) => { f.state.session.id = 'another-session'; }],
    ['different selected agent', (f) => { f.state.session.agent = 'another-agent'; }],
    ['different model', (f) => { f.state.session.model.id = 'other-model'; }],
    ['different agent location', (f) => { f.state.agent.location.directory = '/other'; }],
    ['different skill location', (f) => { f.state.skills.location.directory = '/other'; }],
    ['missing authoritative rules', (f) => { delete f.state.agent.data.permissions; }],
  ])('leaves %s unchanged instead of removing instructions', async (_name, change) => {
    const f = await fixture({ rules: [{ action: 'skill', resource: 'read', effect: 'deny' }] });
    change(f);
    const before = JSON.stringify(f.event);
    await f.hooks.get('context')(f.event);
    expect(JSON.stringify(f.event)).toBe(before);
  });

  it('does not send a request using permissions that changed during the authoritative reads', async () => {
    const f = await fixture({ rules: [{ action: 'skill', resource: '*', effect: 'deny' }] });
    const before = JSON.stringify(f.event);
    f.state.beforeRead = (reads) => { if (reads === 2) f.state.session.permissions = [{ action: 'skill', resource: '*', effect: 'allow' }]; };
    await expect(f.hooks.get('context')(f.event)).rejects.toThrow('Skill guidance permissions changed during request preparation');
    expect(JSON.stringify(f.event)).toBe(before);
  });
});
