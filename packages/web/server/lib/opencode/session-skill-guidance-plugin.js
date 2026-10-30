const PLUGIN_ID = 'openchamber-session-skill-guidance';

// This function is serialized into an import-free OpenCode plugin directory.
const createPlugin = () => {
  const prefix = [
    'Skills provide specialized instructions and workflows for specific tasks.',
    'Use the skill tool to load a skill when a task matches its description.',
    'The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.',
  ].join('\n');
  const block = (skill) => [
    '  <skill>', `    <id>${skill.id}</id>`, `    <name>${skill.name}</name>`,
    `    <description>${skill.description}</description>`, '  </skill>',
  ].join('\n');
  const render = (skills) => skills.length
    ? `${prefix}\n<available_skills>\n${skills.map(block).join('\n')}\n</available_skills>`
    : `${prefix}\nNo skills are currently available.`;
  // OpenCode Permission.match semantics, including last matching rule wins.
  const matches = (value, pattern) => {
    const normalized = value.replaceAll('\\', '/');
    let expression = pattern.replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    if (expression.endsWith(' .*')) expression = `${expression.slice(0, -3)}( .*)?`;
    return new RegExp(`^${expression}$`, 's').test(normalized);
  };
  const validRules = (rules) => Array.isArray(rules) && rules.every((rule) =>
    rule && typeof rule.action === 'string' && typeof rule.resource === 'string'
    && ['allow', 'ask', 'deny'].includes(rule.effect));
  const snapshot = async (ctx, event) => {
    const [session, agent, skills] = await Promise.all([
      ctx.session.get({ sessionID: event.sessionID }),
      ctx.agent.get({ agentID: event.agent }),
      ctx.skill.list(),
    ]);
    const directory = session?.location?.directory;
    const model = session?.model ?? agent?.data?.model;
    if (session?.id !== event.sessionID || agent?.data?.id !== event.agent
      || (session.agent !== undefined && session.agent !== event.agent)
      || typeof directory !== 'string' || agent.location?.directory !== directory || skills?.location?.directory !== directory
      || model?.providerID !== event.model?.providerID || model?.id !== event.model?.id
      || !validRules(agent.data.permissions) || !validRules(session.permissions ?? [])
      || !Array.isArray(skills.data)) return;
    const catalog = skills.data.filter((skill) => skill.description !== undefined).map((skill) => ({
      id: skill.id, name: skill.name, description: skill.description,
    })).sort((a, b) => typeof a.id === 'string' && typeof b.id === 'string' ? a.id.localeCompare(b.id) : 0);
    if (!catalog.every((skill) => typeof skill.id === 'string' && typeof skill.name === 'string' && typeof skill.description === 'string')
      || new Set(catalog.map((skill) => skill.id)).size !== catalog.length) return;
    return { directory, agent: event.agent, model, rules: [...agent.data.permissions, ...(session.permissions ?? [])], catalog };
  };
  // Recognize each original block against the current registry. Arbitrary XML
  // parsing would mistake descriptions containing markup for another skill.
  const originalSkills = (text, catalog) => {
    const opening = `${prefix}\n<available_skills>\n`;
    const closing = '\n</available_skills>';
    if (!text.startsWith(opening) || !text.endsWith(closing)) return;
    let remaining = text.slice(opening.length, -closing.length);
    const result = [];
    while (remaining) {
      const found = catalog.find((skill) => remaining === block(skill) || remaining.startsWith(`${block(skill)}\n`));
      if (!found || result.some((skill) => skill.id === found.id)) return;
      result.push(found);
      remaining = remaining.slice(block(found).length);
      if (remaining.startsWith('\n')) remaining = remaining.slice(1);
    }
    return result.length ? result : undefined;
  };
  const filter = (system, current) => {
    if (!Array.isArray(system)) return;
    const skillRules = current.rules.filter((rule) => matches('skill', rule.action));
    const universal = skillRules.findLastIndex((rule) => rule.resource === '*');
    const denyAll = universal !== -1 && skillRules.slice(universal).every((rule) => rule.effect === 'deny');
    let changed = false;
    const result = [];
    for (const item of system) {
      const entries = item?.metadata?.experimental?.instructions;
      if (entries === undefined) { result.push(item); continue; }
      if (!Array.isArray(entries) || !entries.every((entry) => entry && typeof entry.key === 'string' && typeof entry.text === 'string')
        || new Set(entries.map((entry) => entry.key)).size !== entries.length
        || item.text !== entries.map((entry) => entry.text).join('\n\n')) return;
      const next = [];
      for (const entry of entries) {
        if (entry.key !== 'core/skill-guidance') { next.push(entry); continue; }
        // Persisted instruction epochs can contain older skill descriptions.
        // An unconditional deny-all does not depend on that historical catalog.
        if (denyAll && entry.text.startsWith(`${prefix}\n<available_skills>\n`)
          && entry.text.endsWith('\n</available_skills>')) {
          changed = true;
          next.push({ ...entry, text: render([]) });
          continue;
        }
        const original = originalSkills(entry.text, current.catalog);
        if (!original) return;
        const allowed = original.filter((skill) => current.rules.findLast((rule) => matches('skill', rule.action) && matches(skill.id, rule.resource))?.effect !== 'deny');
        if (allowed.length === original.length) { next.push(entry); continue; }
        changed = true;
        next.push({ ...entry, text: render(allowed) });
      }
      result.push({ ...item, text: next.map((entry) => entry.text).join('\n\n'), metadata: {
        ...item.metadata, experimental: { ...item.metadata.experimental, instructions: next },
      } });
    }
    return changed ? result : undefined;
  };
  return {
    id: 'openchamber-session-skill-guidance',
    setup: async (ctx) => {
      if (!ctx.session?.hook || !ctx.session.get || !ctx.agent?.get || !ctx.skill?.list) return;
      const update = async (event) => {
        const current = await snapshot(ctx, event);
        if (!current) return;
        const system = filter(event.system, current);
        if (!system) return;
        const checked = await snapshot(ctx, event);
        if (JSON.stringify(checked) !== JSON.stringify(current)) throw new Error('Skill guidance permissions changed during request preparation');
        event.system = system;
      };
      await ctx.session.hook('compaction', update);
      await ctx.session.hook('context', update);
    },
  };
};

export const materializeSessionSkillGuidancePlugin = async ({ fsPromises, path, instanceDir }) => {
  const directory = path.join(instanceDir, 'session-skill-guidance', PLUGIN_ID);
  await fsPromises.mkdir(directory, { recursive: true });
  await fsPromises.writeFile(path.join(directory, 'package.json'), `${JSON.stringify({
    name: PLUGIN_ID, version: '0.0.0', private: true, type: 'module', exports: { '.': './index.js' },
  }, null, 2)}\n`, { mode: 0o600 });
  await fsPromises.writeFile(path.join(directory, 'index.js'), `export default (${createPlugin.toString()})();\n`, { mode: 0o600 });
  return directory;
};
