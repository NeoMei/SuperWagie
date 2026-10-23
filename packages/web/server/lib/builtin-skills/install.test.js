import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    expect(fs.existsSync(path.join(cacheDir, 'supervideo', 'engines', '8506f1cdb3e5cc4cbc4dd8af44e5994fc132b70f84e66dee547438a91b76cb88', 'engine-manifest.json'))).toBe(true);

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

  it('refreshes only the exact previous bundled SuperVideo lock and preserves a custom lock', async () => {
    const lock = {
      schemaVersion: 1,
      protocolVersion: 1,
      engineVersion: '0.1.0',
      engineManifest: 'engine-manifest.json',
      engineManifestSha256: 'c9c0d0fdd953c29cd540f56fe8f79cb1d959054714d3189cf8a9846b78e98748',
    };
    fs.mkdirSync(path.join(skillDir, 'supervideo'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'supervideo', 'runtime.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    fs.writeFileSync(path.join(sourceDir, 'skills', 'supervideo', 'runtime.lock.json'), 'new-bundled-lock\n');
    const updated = await run();
    expect(updated.updated).toContain('supervideo');
    expect(fs.readFileSync(path.join(skillDir, 'supervideo', 'runtime.lock.json'), 'utf8')).toBe('new-bundled-lock\n');
    fs.writeFileSync(path.join(skillDir, 'supervideo', 'runtime.lock.json'), 'user-custom-lock\n');
    const preserved = await run();
    expect(preserved.updated).not.toContain('supervideo');
    expect(fs.readFileSync(path.join(skillDir, 'supervideo', 'runtime.lock.json'), 'utf8')).toBe('user-custom-lock\n');
  });

  it('refuses reader refresh through an intermediate scripts symlink', async () => {
    const previousCredentials = "\"\"\"Shared loading and validation for provider API keys.\"\"\"\n\nimport os\nfrom pathlib import Path\n\n\nclass APIKeyError(ValueError):\n    \"\"\"Raised when a configured provider key is unsafe for an HTTP header.\"\"\"\n\n\ndef load_api_key(environment_name: str, secret_path: Path) -> str:\n    \"\"\"Load an environment key first, then a newline-terminated secret file.\"\"\"\n    environment_value = os.environ.get(environment_name)\n    if environment_value is not None and environment_value != \"\":\n        return environment_value\n    try:\n        return secret_path.read_text(encoding=\"utf-8\").rstrip(\"\\r\\n\")\n    except (OSError, UnicodeError):\n        return \"\"\n\n\ndef validate_api_key(value: object) -> str:\n    \"\"\"Return a header-safe key without ever including it in an error.\"\"\"\n    if (\n        not isinstance(value, str)\n        or not value\n        or not value.isascii()\n        or not value.isprintable()\n        or any(character.isspace() for character in value)\n    ):\n        raise APIKeyError(\n            \"configured API key is invalid; use non-empty printable ASCII \"\n            \"without whitespace\"\n        )\n    return value\n";
    const bundledScripts = fileURLToPath(new URL('../../builtin-skills/skills/ai-image-to-ppt/scripts', import.meta.url));
    const external = path.join(root, 'other-host-readers');
    const managedSkill = path.join(skillDir, 'ai-image-to-ppt');
    makeSkill(sourceDir, 'ai-image-to-ppt');
    fs.mkdirSync(path.join(sourceDir, 'skills', 'ai-image-to-ppt', 'scripts'), { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.mkdirSync(managedSkill, { recursive: true });
    for (const name of ['provider_credentials.py', 'gen_slide.py', 'gen_slide_openai.py', 'gen_slide_gemini.py', 'gen_slide_doubao.py']) {
      const bytes = fs.readFileSync(path.join(bundledScripts, name));
      fs.writeFileSync(path.join(sourceDir, 'skills', 'ai-image-to-ppt', 'scripts', name), bytes);
      fs.writeFileSync(path.join(external, name), name === 'provider_credentials.py' ? previousCredentials : bytes);
    }
    fs.symlinkSync(external, path.join(managedSkill, 'scripts'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await run();
    expect(result.updated).not.toContain('ai-image-to-ppt');
    expect(fs.readFileSync(path.join(external, 'provider_credentials.py'), 'utf8')).toBe(previousCredentials);
  });

  it('refuses engine cache installation through a linked parent directory', async () => {
    const external = path.join(root, 'other-host-cache');
    fs.mkdirSync(external, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.symlinkSync(external, path.join(cacheDir, 'supervideo'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await run();
    expect(result.failed).toContain('supervideo-engine');
    expect(fs.readdirSync(external)).toEqual([]);
  });

  it('skips a skill found in another host directory', async () => {
    fs.mkdirSync(path.join(otherDir, 'alpha'), { recursive: true });
    const result = await run();
    expect(result.skipped).toContain('alpha');
    expect(fs.existsSync(path.join(skillDir, 'alpha'))).toBe(false);
  });
});
