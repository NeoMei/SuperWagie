import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installBuiltinSkills } from './install.js';
import { BUNDLE, RECEIPT, inventory, writeBundleIdentity } from './managed-tree.js';

const payload = fileURLToPath(new URL('../../builtin-skills/', import.meta.url));
const prompts = ['grilling', 'grill-me', 'grill-with-docs', 'to-spec', 'domain-modeling'];
const names = [...prompts, 'superwriter'];
let temporary;

beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'writing-bundle-')); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

const frontmatter = (text) => parse(text.split('---')[1]);
async function files(root, relative = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, child));
    else result.push(child);
  }
  return result;
}

describe('bundled writing dependencies', () => {
  it('copies templates atomically and rejects final symlink destinations', () => {
    const result = spawnSync('python3', [
      fileURLToPath(new URL('./fixtures/tender-template.py', import.meta.url)),
      path.join(payload, 'skills/superwriter'),
    ], {
      encoding: 'utf8', cwd: temporary,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '', PYTHONNOUSERSITE: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('resolves declared dependency names and installed prompt/template references', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(payload, 'skills/superwriter/references/依赖清单.json')));
    const ids = manifest.dependencies.map((dependency) => dependency.id);
    for (const name of prompts) {
      expect(ids).toContain(name);
      const root = path.join(payload, 'skills', name);
      const instructions = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8');
      expect(frontmatter(instructions).name).toBe(name);
      if (name !== 'grilling' && name !== 'domain-modeling') {
        expect(frontmatter(instructions)['disable-model-invocation']).toBe(false);
      }
      for (const file of (await files(root)).filter((file) => file.endsWith('.md'))) {
        const text = (await fs.readFile(path.join(root, file), 'utf8')).replace(/```[\s\S]*?```/g, '');
        for (const match of text.matchAll(/\]\((\.\.?\/[^)#]+)(?:#[^)]*)?\)/g)) {
          await expect(fs.stat(path.resolve(root, path.dirname(file), match[1]))).resolves.toBeDefined();
        }
      }
    }
    for (const name of names) {
      const root = path.join(payload, 'skills', name);
      const snapshot = JSON.parse(await fs.readFile(path.join(root, 'VENDOR-SNAPSHOT.json')));
      const owned = (await files(root)).filter((file) => file !== BUNDLE && file !== 'VENDOR-SNAPSHOT.json' && !file.split('/').includes('__pycache__'));
      expect(snapshot.files.map((file) => file.path).sort()).toEqual(owned.sort());
      for (const file of snapshot.files) {
        expect(file.upstreamSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(file.sourcePath.split('/')).not.toContain('..');
        for (const adaptation of file.adaptations || []) expect(snapshot.adaptations[adaptation]).toBeTruthy();
      }
    }
    const writer = path.join(payload, 'skills/superwriter');
    for (const file of (await files(writer)).filter((file) => file.endsWith('.md'))) {
      const text = await fs.readFile(path.join(writer, file), 'utf8');
      for (const match of text.matchAll(/`(references\/[^`]+\.\w+)`/g)) {
        const reference = file === 'references/legacy-v1/SKILL.md' && /references\/(阶段契约\.json|门禁清单\.md|验收清单模板\.json)$/.test(match[1])
          ? match[1].replace('references/', 'references/legacy-v1/') : match[1];
        await expect(fs.stat(path.join(writer, reference))).resolves.toBeDefined();
      }
    }
  });

  it('installs complete owned trees, runs the installed verifier, and preserves edited upgrades', async () => {
    const source = path.join(temporary, 'bundle');
    const skillDir = path.join(temporary, 'config/skills');
    const previous = path.join(temporary, 'previous');
    const otherSkills = path.join(temporary, 'other-skills');
    await fs.mkdir(previous);
    await fs.mkdir(path.join(otherSkills, 'superppt'), { recursive: true });
    for (const name of names) {
      const root = path.join(previous, 'skills', name);
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, 'SKILL.md'), `---\nname: ${name}\n---\nPrevious controlled fixture.\n`);
      await fs.writeFile(path.join(root, 'obsolete.txt'), 'previous owned file');
      await writeBundleIdentity(root, { sourceOnly: true });
    }
    const options = { skillDir, dataDir: path.join(temporary, 'data'), cacheDir: path.join(temporary, 'cache'), existingSkillDirs: [skillDir, otherSkills] };
    const old = await installBuiltinSkills({ ...options, sourceDir: previous });
    expect(old.failed).toEqual([]);
    expect(old.installed.sort()).toEqual([...names].sort());
    await fs.mkdir(path.join(source, 'skills'), { recursive: true });
    for (const name of names) {
      await fs.cp(path.join(payload, 'skills', name), path.join(source, 'skills', name), { recursive: true });
    }
    const updated = await installBuiltinSkills({ ...options, sourceDir: source });
    expect(updated.failed).toEqual([]);
    expect(updated.updated.sort()).toEqual([...names].sort());
    const freshSkills = path.join(temporary, 'fresh/skills');
    const fresh = await installBuiltinSkills({ ...options, sourceDir: source, skillDir: freshSkills, existingSkillDirs: [freshSkills, otherSkills] });
    expect(fresh.failed).toEqual([]);
    expect(fresh.installed.sort()).toEqual([...names].sort());
    for (const name of names) {
      const destination = path.join(skillDir, name);
      const receipt = JSON.parse(await fs.readFile(path.join(destination, RECEIPT)));
      expect(receipt.owner).toBe('superwagie-builtin-skills');
      expect(receipt.name).toBe(name);
      expect(receipt.entries).toEqual((await inventory(destination)).entries);
      const freshReceipt = JSON.parse(await fs.readFile(path.join(freshSkills, name, RECEIPT)));
      expect(freshReceipt.entries).toEqual(receipt.entries);
      await expect(fs.stat(path.join(destination, 'obsolete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const writer = path.join(skillDir, 'superwriter');
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '', PYTHONNOUSERSITE: '1' };
    const invoke = (script, args = []) => spawnSync('python3', [path.join(writer, 'scripts', script), ...args], { encoding: 'utf8', env, cwd: temporary });
    const help = invoke('collaboration_state.py', ['--help']);
    expect(help.status, help.stderr).toBe(0);
    const missing = invoke('verify_acceptance.py', ['--help']);
    expect(missing.status).toBe(1);
    expect(missing.stderr.trim()).toBe('FAIL: acceptance manifest is missing: 验收清单.json');
    const runtime = spawnSync('python3', [fileURLToPath(new URL('./fixtures/writing-runtime.py', import.meta.url)), writer], { encoding: 'utf8', env, cwd: temporary });
    expect(runtime.status, runtime.stderr).toBe(0);
    expect(runtime.stdout.trim().split('\n')).toEqual(['PASS current', 'PASS legacy', 'PASS template']);
    const template = spawnSync('python3', [fileURLToPath(new URL('./fixtures/tender-template.py', import.meta.url)), writer], { encoding: 'utf8', env, cwd: temporary });
    expect(template.status, template.stderr).toBe(0);
    const receipts = new Map();
    for (const name of names) receipts.set(name, await fs.readFile(path.join(skillDir, name, RECEIPT)));
    const skipped = await installBuiltinSkills({ ...options, sourceDir: source });
    expect(skipped.skipped.filter((name) => names.includes(name)).sort()).toEqual([...names].sort());
    for (const name of names) {
      await fs.appendFile(path.join(skillDir, name, 'SKILL.md'), '\nUser-owned instructions.\n');
      const root = path.join(source, 'skills', name);
      await fs.writeFile(path.join(root, 'next-release.txt'), 'controlled proposed update');
      await writeBundleIdentity(root, { sourceOnly: true });
    }
    const preserved = await installBuiltinSkills({ ...options, sourceDir: source, warn: () => {} });
    expect(preserved.updated).toEqual([]);
    expect(preserved.failed).toEqual([]);
    expect(preserved.skipped.filter((name) => names.includes(name)).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(await fs.readFile(path.join(skillDir, name, RECEIPT))).toEqual(receipts.get(name));
      await expect(fs.stat(path.join(skillDir, name, 'next-release.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fs.readFile(path.join(skillDir, name, 'SKILL.md'), 'utf8')).endsWith('User-owned instructions.\n')).toBe(true);
    }
  });
});
