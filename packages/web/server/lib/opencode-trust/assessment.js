import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const configNames = ['opencode.json', 'opencode.jsonc'];
const agentDirectories = ['agent', 'agents', 'mode', 'modes'];
const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);
const scriptExtension = /\.[cm]?[jt]sx?$/i;
const importExtensions = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const aliases = { write: 'edit', patch: 'edit', apply_patch: 'edit', bash: 'shell', task: 'subagent' };
const hash = (data) => createHash('sha256').update(data).digest('hex');
const effect = z.enum(['allow', 'ask', 'deny']);
const permissionRule = z.object({ action: z.string(), resource: z.string().default('*'), effect });
const legacyPermission = z.union([
  effect.transform((value) => [{ action: '*', resource: '*', effect: value }]),
  z.record(z.string(), z.union([
    effect.transform((value) => [{ resource: '*', effect: value }]),
    z.record(z.string(), effect).transform((values) => (
      Object.entries(values).map(([resource, effect]) => ({ resource, effect }))
    )),
  ])).transform((entries) => Object.entries(entries).flatMap(([action, rules]) => (
    rules.map((rule) => ({ action, ...rule }))
  ))),
]);
const permissionSettings = z.object({
  permission: legacyPermission.default([]),
  permissions: z.array(permissionRule).default([]),
  tools: z.record(z.string(), z.boolean()).default({}),
});
const agentSettings = z.record(z.string(), permissionSettings).default({});
const permissionConfig = permissionSettings.extend({
  agent: agentSettings, agents: agentSettings, mode: agentSettings, modes: agentSettings,
});
const pluginSetting = z.union([
  z.string().transform((value) => ({ spec: value, value })),
  z.tuple([z.string()]).rest(z.json()).transform((value) => ({ spec: value[0], value })),
  z.looseObject({ package: z.string() }).transform((value) => ({ spec: value.package, value })),
]);
const commandSetting = z.union([
  z.looseObject({ command: z.array(z.string()).optional() }),
  z.boolean().transform(() => null),
]);
const commandMap = z.record(z.string(), commandSetting);
const optionalCommandMap = z.union([commandMap, z.boolean().transform(() => ({}))]).default({});
const mcpSettings = z.object({
  servers: commandMap.default({}),
  timeout: z.union([z.number(), z.object({ startup: z.number().optional(), catalog: z.number().optional(), execution: z.number().optional() })]).optional(),
}).catchall(commandSetting).transform(({ servers, timeout, ...legacy }) => ({ ...legacy, ...servers }));
const trustConfig = permissionConfig.extend({
  plugin: z.array(pluginSetting).default([]),
  plugins: z.array(pluginSetting).default([]),
  mcp: mcpSettings.default({}),
  lsp: optionalCommandMap,
  formatter: optionalCommandMap,
  shell: z.string().optional(),
});
const optional = async (read) => {
  try {
    return await read();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
};

const levels = (directory, home) => {
  const result = [];
  for (let current = directory; current !== home;) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
};

const globalDirectories = (home, env) => [
  path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode'),
  env.OPENCODE_CONFIG_DIR,
  process.platform === 'darwin' ? '/Library/Application Support/opencode'
    : process.platform === 'win32' ? path.join(env.ProgramData || 'C:\\ProgramData', 'opencode') : '/etc/opencode',
].filter(Boolean);

const parseConfig = (text, schema = trustConfig) => {
  const errors = [];
  const config = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) return null;
  const parsed = schema.safeParse(config);
  return parsed.success ? parsed.data : null;
};

const actionRules = ({ permission, permissions, tools }) => [
  ...permission,
  ...permissions,
  ...Object.entries(tools).map(([action, enabled]) => ({ action, resource: '*', effect: enabled ? 'allow' : 'deny' })),
].map(({ action, resource, effect }) => ({ action: Object.hasOwn(aliases, action) ? aliases[action] : action, resource, effect }));

const globMatches = (pattern, value) => {
  const regexp = pattern.replace(/[.+^$()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp('^' + regexp + '$', 'i').test(value);
};
const overlaps = (a, b) => a === b || globMatches(a, b) || globMatches(b, a) || (/[?*[{}]/.test(a) && /[?*[{}]/.test(b));
const allAgentRules = ({ agent, agents, mode, modes }) => [agent, agents, mode, modes].flatMap((entries) => (
  Object.entries(entries).map(([name, settings]) => [name, actionRules(settings)])
));

const sortedEntries = async (io, directory) => (
  (await optional(() => io.readdir(directory, { withFileTypes: true })) || []).sort((a, b) => a.name.localeCompare(b.name, 'en'))
);

const agentFiles = async (io, directory, recursive, seen = new Set()) => {
  const resolved = await optional(() => io.realpath(directory));
  if (!resolved || seen.has(resolved)) return [];
  seen.add(resolved);
  const files = [];
  for (const entry of await sortedEntries(io, directory)) {
    if (ignored.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const info = entry.isSymbolicLink() ? await optional(() => io.stat(file)) : entry;
    if (info?.isDirectory() && recursive) files.push(...await agentFiles(io, file, recursive, seen));
    if (info?.isFile() && file.endsWith('.md')) files.push(file);
  }
  return files;
};

const readAgents = async (io, directory) => {
  const entries = [];
  for (const group of agentDirectories) {
    const root = path.join(directory, group);
    for (const file of await agentFiles(io, root, group === 'agent' || group === 'agents')) {
      const text = await optional(() => io.readFile(file, 'utf8'));
      const yaml = text?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      if (yaml === undefined) continue;
      const name = path.relative(root, file).slice(0, -3);
      try {
        const parsed = permissionSettings.parse(parseYaml(yaml, { merge: true }) ?? {});
        entries.push({ file, name, rules: actionRules(parsed), unparsed: null });
      } catch {
        entries.push({ file, name, rules: [], unparsed: /permissions?|tools/.test(yaml) ? hash(text) : null });
      }
    }
  }
  return entries;
};

const getRestrictions = async (io, home, global, env) => {
  const documents = [...global, home, path.join(home, '.opencode')].flatMap((dir) => configNames.map((name) => path.join(dir, name)));
  if (env.OPENCODE_CONFIG) documents.push(env.OPENCODE_CONFIG);
  const texts = await Promise.all(documents.map((file) => optional(() => io.readFile(file, 'utf8'))));
  const configs = [...texts, env.OPENCODE_CONFIG_CONTENT].filter(Boolean).map((text) => parseConfig(text, permissionConfig)).filter(Boolean);
  const rules = configs.flatMap((config) => [...actionRules(config), ...allAgentRules(config).flatMap(([, rules]) => rules)]);
  for (const directory of [...global, path.join(home, '.opencode')]) {
    for (const entry of await readAgents(io, directory)) {
      rules.push(...entry.rules);
      if (entry.unparsed) rules.push({ action: '*', effect: 'ask' });
    }
  }
  return [...new Set(rules.filter(({ effect }) => effect !== 'allow').map(({ action }) => action))];
};

const repositoryIdentity = async (io, directory) => {
  for (const level of levels(directory, null)) {
    const marker = path.join(level, '.git');
    const info = await optional(() => io.stat(marker));
    if (info?.isDirectory()) return { root: level, key: await io.realpath(marker) };
    if (!info?.isFile()) continue;
    const pointer = (await io.readFile(marker, 'utf8')).match(/^gitdir:\s*(.+)$/m)?.[1];
    if (!pointer) continue;
    const gitDir = path.resolve(level, pointer.trim());
    const common = (await optional(() => io.readFile(path.join(gitDir, 'commondir'), 'utf8')))?.trim();
    const commonDirectory = common ? path.resolve(gitDir, common) : gitDir;
    const key = await optional(() => io.realpath(commonDirectory));
    if (key) return { root: level, key };
  }
  return { root: directory, key: directory };
};

const localPlugin = (spec) => spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('file:') || path.isAbsolute(spec);
const pluginPath = (spec, directory) => spec.startsWith('file:') ? fileURLToPath(spec) : path.resolve(directory, spec);

const pluginDigest = async (io, target) => {
  const seen = new Set();
  const contents = [];
  let bytes = 0;
  const base = path.dirname(target);
  const visit = async (candidate) => {
    const resolved = await optional(() => io.realpath(candidate));
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    if (seen.size > 500) throw new Error('OpenCode plugin directory is too large to assess');
    const info = await io.stat(resolved);
    if (info.isDirectory()) {
      for (const entry of await sortedEntries(io, candidate)) {
        if (!ignored.has(entry.name)) await visit(path.join(candidate, entry.name));
      }
      return;
    }
    if (!info.isFile()) return;
    bytes += info.size;
    if (bytes > 16 * 1024 * 1024) throw new Error('OpenCode plugin content is too large to assess');
    const data = await io.readFile(resolved);
    contents.push([path.relative(base, candidate), hash(data)]);
    if (!scriptExtension.test(candidate)) return;
    for (const match of data.toString('utf8').matchAll(/\b(?:from|import|require)\s*\(?\s*(['"])([^'"\n]+)\1/g)) {
      const spec = match[2];
      if (!localPlugin(spec)) continue;
      const child = pluginPath(spec, path.dirname(candidate));
      for (const suffix of importExtensions) {
        if (await optional(() => io.stat(child + suffix))) {
          await visit(child + suffix);
          break;
        }
      }
    }
  };
  await visit(target);
  return hash(JSON.stringify(contents));
};

export const assessOpenCodeFolder = async (directory, {
  io = fs,
  homeDirectory = os.homedir(),
  environment = process.env,
  globalConfigDirectories = globalDirectories(homeDirectory, environment),
} = {}) => {
  const proposed = path.resolve(directory);
  const canonical = await optional(() => io.realpath(proposed));
  if (!canonical || !(await io.stat(canonical)).isDirectory()) {
    return { directory: proposed, repository: proposed, fingerprint: null, items: [] };
  }
  const home = await optional(() => io.realpath(homeDirectory)) ?? path.resolve(homeDirectory);
  const global = await Promise.all(globalConfigDirectories.map(async (dir) => await optional(() => io.realpath(dir)) ?? path.resolve(dir)));
  const restricted = await getRestrictions(io, home, global, environment);
  const repository = await repositoryIdentity(io, canonical);
  const items = [];
  const fingerprints = [];
  const add = (file, kind, name = '', detail = '', digest = '') => {
    const source = path.relative(repository.root, file).split(path.sep).join('/');
    items.push({ source, kind, name, detail });
    fingerprints.push([source, kind, name, detail, digest]);
  };
  const addPermissions = (file, agent, rules) => {
    for (const { action, effect, resource } of rules) {
      if (effect === 'allow' && restricted.some((rule) => overlaps(action, rule))) {
        add(file, 'permission', agent, action + ' ' + resource);
      }
    }
  };
  const assessConfig = async (file) => {
    const text = await optional(() => io.readFile(file, 'utf8'));
    if (text === null) return;
    const config = parseConfig(text);
    if (!config) {
      add(file, 'config', '', '', hash(text));
      return;
    }
    const variables = new Set();
    for (const match of text.matchAll(/\{(env|file):([^}]+)\}/g)) {
      const [, kind, name] = match;
      const line = text.lastIndexOf('\n', match.index - 1) + 1;
      if (text.slice(line, match.index).trimStart().startsWith('//')) continue;
      const key = kind + ':' + name;
      if (variables.has(key)) continue;
      variables.add(key);
      add(file, kind, name, '', hash(text));
    }
    for (const { spec, value } of [...config.plugin, ...config.plugins]) {
      if (!spec || spec.startsWith('-')) continue;
      const digest = hash(JSON.stringify(value));
      if (localPlugin(spec)) {
        add(file, 'plugin', spec, '', digest + await pluginDigest(io, pluginPath(spec, path.dirname(file))));
      } else {
        add(file, 'package', spec, '', digest);
      }
    }
    for (const kind of ['mcp', 'lsp', 'formatter']) {
      for (const [name, value] of Object.entries(config[kind])) {
        if (value?.command?.length) {
          add(file, kind, name, '', hash(JSON.stringify(value)));
        }
      }
    }
    if (config.shell?.trim()) add(file, 'shell', '', '', hash(config.shell));
    addPermissions(file, '', actionRules(config));
    for (const [name, rules] of allAgentRules(config)) addPermissions(file, name, rules);
  };

  if (!global.includes(canonical)) {
    for (const level of levels(canonical, home)) {
      if (global.includes(level)) continue;
      const settings = path.join(level, '.opencode');
      for (const root of [level, settings]) {
        for (const name of configNames) await assessConfig(path.join(root, name));
      }
      for (const group of ['plugin', 'plugins']) {
        const root = path.join(settings, group);
        for (const entry of await sortedEntries(io, root)) {
          const candidate = path.join(root, entry.name);
          const info = entry.isSymbolicLink() ? await optional(() => io.stat(candidate)) : entry;
          if (info?.isDirectory() || (info?.isFile() && scriptExtension.test(entry.name))) {
            add(candidate, 'plugin', '', '', await pluginDigest(io, candidate));
          }
        }
      }
      if (restricted.length) {
        for (const entry of await readAgents(io, settings)) {
          if (entry.unparsed) add(entry.file, 'config', entry.name, '', entry.unparsed);
          else addPermissions(entry.file, entry.name, entry.rules);
        }
      }
    }
  }
  return {
    directory: canonical,
    repository: repository.key,
    fingerprint: fingerprints.length ? hash(JSON.stringify(fingerprints)) : null,
    items,
  };
};
