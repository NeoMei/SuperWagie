import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installBuiltinSkills } from './install.js';

const makeSkill = (root, name) => {
  fs.mkdirSync(path.join(root, 'skills', name), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
};

let root;
let sourceDir;
let skillDir;
let dataDir;
let cacheDir;
let otherDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-builtin-skills-'));
  sourceDir = path.join(root, 'bundle');
  skillDir = path.join(root, 'config', 'skills');
  dataDir = path.join(root, 'data');
  cacheDir = path.join(root, 'cache');
  otherDir = path.join(root, 'other', 'skills');
  fs.mkdirSync(otherDir, { recursive: true });
  makeSkill(sourceDir, 'alpha');
  makeSkill(sourceDir, 'supervideo');
  fs.mkdirSync(path.join(sourceDir, 'superppt', 'skills', 'superppt'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'superppt', 'skills', 'superppt', 'SKILL.md'), '---\nname: superppt\n---\n');
  fs.writeFileSync(path.join(sourceDir, 'superppt', 'package.json'), '{"name":"superppt"}\n');
  fs.mkdirSync(path.join(sourceDir, 'supervideo-engine'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'supervideo-engine', 'engine-manifest.json'), '{}\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const run = (overrides = {}) => installBuiltinSkills({
  sourceDir,
  skillDir,
  dataDir,
  cacheDir,
  existingSkillDirs: [skillDir, otherDir],
  ...overrides,
});

describe('installBuiltinSkills', () => {
  it('copies bundled skills, links superppt and installs the engine once', async () => {
    const first = await run();
    expect(first.installed).toEqual(['alpha', 'supervideo', 'superppt']);
    expect(fs.readFileSync(path.join(skillDir, 'alpha', 'SKILL.md'), 'utf8')).toContain('alpha');
    expect(fs.realpathSync(path.join(skillDir, 'superppt')))
      .toBe(fs.realpathSync(path.join(dataDir, 'skills-runtime', 'superppt', 'skills', 'superppt')));
    expect(fs.existsSync(path.join(cacheDir, 'supervideo', 'engines', 'c9c0d0fdd953c29cd540f56fe8f79cb1d959054714d3189cf8a9846b78e98748', 'engine-manifest.json'))).toBe(true);

    const second = await run();
    expect(second.installed).toEqual([]);
    expect(second.skipped).toEqual(['alpha', 'supervideo', 'superppt']);
  });

  it('never overwrites a skill the user already has', async () => {
    fs.mkdirSync(path.join(skillDir, 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'alpha', 'SKILL.md'), 'mine\n');
    const result = await run();
    expect(result.skipped).toContain('alpha');
    expect(fs.readFileSync(path.join(skillDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('mine\n');
  });

  it('installs a packaged skill from its extra resource and restores vendored modules', async () => {
    makeSkill(sourceDir, 'superweb');
    const extraDir = path.join(root, 'resources');
    fs.mkdirSync(path.join(extraDir, 'superweb', 'vendor', 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(extraDir, 'superweb', 'SKILL.md'), '---\nname: superweb\n---\n');
    fs.writeFileSync(path.join(extraDir, 'superweb', 'vendor', 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');

    const result = await run({ extraSkillsDir: extraDir });

    expect(result.installed).toContain('superweb');
    expect(fs.readFileSync(path.join(skillDir, 'superweb', 'SKILL.md'), 'utf8')).toContain('superweb');
    expect(fs.existsSync(path.join(skillDir, 'superweb', 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'superweb', 'vendor'))).toBe(false);
  });

  it('skips a skill found in another host directory', async () => {
    fs.mkdirSync(path.join(otherDir, 'alpha'), { recursive: true });
    const result = await run();
    expect(result.skipped).toContain('alpha');
    expect(fs.existsSync(path.join(skillDir, 'alpha'))).toBe(false);
  });
});
