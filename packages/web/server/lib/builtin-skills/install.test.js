import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  const bundled = fileURLToPath(new URL('../../builtin-skills', import.meta.url));
  fs.cpSync(path.join(bundled, 'supervideo-engine'), path.join(sourceDir, 'supervideo-engine'), { recursive: true, force: true });
  fs.copyFileSync(path.join(bundled, 'skills', 'supervideo', 'runtime.lock.json'), path.join(sourceDir, 'skills', 'supervideo', 'runtime.lock.json'));
  fs.mkdirSync(path.join(sourceDir, 'skills', 'supervideo', 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(bundled, 'skills', 'supervideo', 'scripts', 'video.mjs'), path.join(sourceDir, 'skills', 'supervideo', 'scripts', 'video.mjs'));
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
    const lock = JSON.parse(fs.readFileSync(path.join(sourceDir, 'skills', 'supervideo', 'runtime.lock.json'), 'utf8'));
    expect(fs.existsSync(path.join(cacheDir, 'supervideo', 'engines', lock.engineManifestSha256, 'engine-manifest.json'))).toBe(true);

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

  it('keeps the installed engine available to runtimes sharing a skill directory across cache roots', async () => {
    const bundledSkill = fileURLToPath(new URL('../../builtin-skills/skills/supervideo', import.meta.url));
    fs.cpSync(bundledSkill, path.join(sourceDir, 'skills', 'supervideo'), { recursive: true, force: true });
    await run();
    const alternateCache = path.join(root, 'other-cache');
    const concurrent = await Promise.all([run(), run({ cacheDir: alternateCache })]);
    expect(concurrent.flatMap((result) => result.failed)).not.toContain('supervideo-engine');
    const installedLock = JSON.parse(fs.readFileSync(path.join(skillDir, 'supervideo', 'runtime.lock.json')));
    const initialLock = JSON.parse(fs.readFileSync(path.join(sourceDir, 'skills', 'supervideo', 'runtime.lock.json')));
    expect(installedLock.engineManifestSha256).toBe(initialLock.engineManifestSha256);
    const launcher = path.join(skillDir, 'supervideo', 'scripts', 'video.mjs');
    for (const selectedCache of [cacheDir, alternateCache]) {
      const result = spawnSync('node', [launcher, '--help'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: root, XDG_CACHE_HOME: selectedCache, SUPERVIDEO_ENGINE_CACHE: path.join(selectedCache, 'supervideo', 'engines') },
      });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it('keeps both cache roots usable when real old and new bundles install concurrently', async () => {
    const bundle = fileURLToPath(new URL('./fixtures/supervideo-previous-bundle.tar.gz', import.meta.url));
    const extracted = path.join(root, 'previous-bundle-extracted');
    fs.mkdirSync(extracted, { recursive: true });
    const unpack = spawnSync('tar', ['-xzf', bundle, '-C', extracted], { encoding: 'utf8' });
    expect(unpack.status, unpack.stderr).toBe(0);
    const previousBuiltin = path.join(extracted, 'packages/web/server/builtin-skills');
    const previousSource = path.join(root, 'previous-bundle');
    fs.cpSync(sourceDir, previousSource, { recursive: true });
    fs.rmSync(path.join(previousSource, 'supervideo-engine'), { recursive: true, force: true });
    fs.rmSync(path.join(previousSource, 'skills', 'supervideo'), { recursive: true, force: true });
    fs.cpSync(path.join(previousBuiltin, 'supervideo-engine'), path.join(previousSource, 'supervideo-engine'), { recursive: true });
    fs.cpSync(path.join(previousBuiltin, 'skills', 'supervideo'), path.join(previousSource, 'skills', 'supervideo'), { recursive: true });
    const previousLock = JSON.parse(fs.readFileSync(path.join(previousSource, 'skills', 'supervideo', 'runtime.lock.json')));
    expect(previousLock.engineManifestSha256).toBe('1e0433d6e916bfcfacad226151f809b19a6400625400aff2ef0bf3f2e6a0be91');
    const previousCache = path.join(root, 'previous-cache');
    const installed = await run({ sourceDir: previousSource, cacheDir: previousCache });
    expect(installed.failed).not.toContain('supervideo-engine');
    const concurrency = await Promise.all([run(), run({ sourceDir: previousSource, cacheDir: previousCache })]);
    expect(concurrency.flatMap((result) => result.failed)).not.toContain('supervideo-engine');
    const installedLock = JSON.parse(fs.readFileSync(path.join(skillDir, 'supervideo', 'runtime.lock.json')));
    const currentLock = JSON.parse(fs.readFileSync(path.join(sourceDir, 'skills', 'supervideo', 'runtime.lock.json')));
    expect(installedLock.engineManifestSha256).toBe(currentLock.engineManifestSha256);
    const launcher = path.join(skillDir, 'supervideo', 'scripts', 'video.mjs');
    for (const selectedCache of [cacheDir, previousCache]) {
      const result = spawnSync(process.execPath, [launcher, '--help'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: root, XDG_CACHE_HOME: selectedCache, SUPERVIDEO_ENGINE_CACHE: path.join(selectedCache, 'supervideo', 'engines') },
      });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it.each(['previous', 'custom', 'missing'])('refreshes managed vision QA safely when the installed reader is %s', async (state) => {
    const bundled = fileURLToPath(new URL('../../builtin-skills/skills/ai-image-to-ppt', import.meta.url));
    const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));
    const source = path.join(sourceDir, 'skills', 'ai-image-to-ppt');
    const destination = path.join(skillDir, 'ai-image-to-ppt');
    fs.cpSync(bundled, source, { recursive: true });
    fs.cpSync(bundled, destination, { recursive: true });
    const credential = path.join(destination, 'scripts', 'provider_credentials.py');
    const vision = path.join(destination, 'scripts', 'vision_check_gemini.py');
    fs.copyFileSync(path.join(fixtures, 'provider_credentials.previous.py'), credential);
    if (state === 'previous') fs.copyFileSync(path.join(fixtures, 'vision_check_gemini.previous.py'), vision);
    if (state === 'custom') fs.writeFileSync(vision, 'custom vision helper\n');
    if (state === 'missing') fs.rmSync(vision);
    const warnings = [];
    const result = await run({ warn: (message) => warnings.push(message) });
    expect(result.updated).toContain('ai-image-to-ppt');
    expect(fs.readFileSync(credential)).toEqual(fs.readFileSync(path.join(source, 'scripts', 'provider_credentials.py')));
    if (state === 'previous') expect(fs.readFileSync(vision)).toEqual(fs.readFileSync(path.join(source, 'scripts', 'vision_check_gemini.py')));
    if (state === 'custom') {
      expect(fs.readFileSync(vision, 'utf8')).toBe('custom vision helper\n');
      expect(warnings.some((message) => message.includes('model readers were not refreshed'))).toBe(true);
    }
    if (state === 'missing') expect(fs.existsSync(vision)).toBe(false);
  });

  it('preserves the working old vision helper when the credentials reader is customized', async () => {
    const bundled = fileURLToPath(new URL('../../builtin-skills/skills/ai-image-to-ppt', import.meta.url));
    const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));
    const source = path.join(sourceDir, 'skills', 'ai-image-to-ppt');
    const destination = path.join(skillDir, 'ai-image-to-ppt');
    fs.cpSync(bundled, source, { recursive: true });
    fs.cpSync(bundled, destination, { recursive: true });
    const credential = path.join(destination, 'scripts', 'provider_credentials.py');
    const vision = path.join(destination, 'scripts', 'vision_check_gemini.py');
    const customized = `${fs.readFileSync(path.join(fixtures, 'provider_credentials.previous.py'), 'utf8')}\n# user customization\n`;
    fs.writeFileSync(credential, customized);
    fs.copyFileSync(path.join(fixtures, 'vision_check_gemini.previous.py'), vision);
    const previousVision = fs.readFileSync(vision);
    const before = spawnSync('python3', [vision, '--help'], { encoding: 'utf8' });
    expect(before.status, before.stderr).toBe(0);

    await run();

    expect(fs.readFileSync(credential, 'utf8')).toBe(customized);
    expect(fs.readFileSync(vision)).toEqual(previousVision);
    const after = spawnSync('python3', [vision, '--help'], { encoding: 'utf8' });
    expect(after.status, after.stderr).toBe(0);
  });

  it('upgrades the previously shipped model credentials reader and preserves a customized copy', async () => {
    const bundled = fileURLToPath(new URL('../../builtin-skills/skills/ai-image-to-ppt', import.meta.url));
    const previous = fileURLToPath(new URL('./fixtures/provider_credentials.head.py', import.meta.url));
    const source = path.join(sourceDir, 'skills', 'ai-image-to-ppt');
    const destination = path.join(skillDir, 'ai-image-to-ppt');
    fs.cpSync(bundled, source, { recursive: true });
    fs.cpSync(bundled, destination, { recursive: true });
    const credentials = path.join(destination, 'scripts', 'provider_credentials.py');
    fs.copyFileSync(previous, credentials);
    expect((await run()).updated).toContain('ai-image-to-ppt');
    expect(fs.readFileSync(credentials)).toEqual(fs.readFileSync(path.join(source, 'scripts', 'provider_credentials.py')));

    const custom = `${fs.readFileSync(previous, 'utf8')}\n# user customization\n`;
    fs.writeFileSync(credentials, custom);
    await run();
    expect(fs.readFileSync(credentials, 'utf8')).toBe(custom);
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
    fs.mkdirSync(path.join(skillDir, 'supervideo', 'scripts'));
    fs.copyFileSync(fileURLToPath(new URL('./fixtures/video.previous.txt', import.meta.url)), path.join(skillDir, 'supervideo', 'scripts', 'video.mjs'));
    const bundledLock = fs.readFileSync(path.join(sourceDir, 'skills', 'supervideo', 'runtime.lock.json'), 'utf8');
    const updated = await run();
    expect(updated.updated).toContain('supervideo');
    expect(fs.readFileSync(path.join(skillDir, 'supervideo', 'runtime.lock.json'), 'utf8')).toBe(bundledLock);
    const previousLock = { ...lock, engineManifestSha256: '8506f1cdb3e5cc4cbc4dd8af44e5994fc132b70f84e66dee547438a91b76cb88' };
    fs.writeFileSync(path.join(skillDir, 'supervideo', 'runtime.lock.json'), `${JSON.stringify(previousLock, null, 2)}\n`);
    expect((await run()).updated).toContain('supervideo');
    expect(fs.readFileSync(path.join(skillDir, 'supervideo', 'runtime.lock.json'), 'utf8')).toBe(bundledLock);
    const managedLock = { ...lock, engineManifestSha256: '1e0433d6e916bfcfacad226151f809b19a6400625400aff2ef0bf3f2e6a0be91' };
    fs.writeFileSync(path.join(skillDir, 'supervideo', 'runtime.lock.json'), `${JSON.stringify(managedLock, null, 2)}\n`);
    expect((await run()).updated).toContain('supervideo');
    expect(fs.readFileSync(path.join(skillDir, 'supervideo', 'runtime.lock.json'), 'utf8')).toBe(bundledLock);
    fs.writeFileSync(path.join(skillDir, 'supervideo', 'runtime.lock.json'), 'user-custom-lock\n');
    const preserved = await run();
    expect(preserved.updated).not.toContain('supervideo');
    expect(fs.readFileSync(path.join(skillDir, 'supervideo', 'runtime.lock.json'), 'utf8')).toBe('user-custom-lock\n');
  });

  it('preserves a customized launcher and its previous lock', async () => {
    const destination = path.join(skillDir, 'supervideo');
    fs.mkdirSync(path.join(destination, 'scripts'), { recursive: true });
    const oldLock = '{\n  "schemaVersion": 1,\n  "protocolVersion": 1,\n  "engineVersion": "0.1.0",\n  "engineManifest": "engine-manifest.json",\n  "engineManifestSha256": "1e0433d6e916bfcfacad226151f809b19a6400625400aff2ef0bf3f2e6a0be91"\n}\n';
    fs.writeFileSync(path.join(destination, 'runtime.lock.json'), oldLock);
    fs.writeFileSync(path.join(destination, 'scripts', 'video.mjs'), '// customized launcher\n');
    await run();
    expect(fs.readFileSync(path.join(destination, 'runtime.lock.json'), 'utf8')).toBe(oldLock);
    expect(fs.readFileSync(path.join(destination, 'scripts', 'video.mjs'), 'utf8')).toBe('// customized launcher\n');
  });

  it('migrates the exact old launcher without interrupting its existing locked engine', async () => {
    const destination = path.join(skillDir, 'supervideo');
    const bundled = fileURLToPath(new URL('../../builtin-skills/skills/supervideo', import.meta.url));
    fs.cpSync(bundled, destination, { recursive: true });
    const launcher = path.join(destination, 'scripts', 'video.mjs');
    fs.copyFileSync(fileURLToPath(new URL('./fixtures/video.previous.txt', import.meta.url)), launcher);
    const lock = JSON.parse(fs.readFileSync(path.join(destination, 'runtime.lock.json')));
    fs.cpSync(path.join(sourceDir, 'supervideo-engine'), path.join(cacheDir, 'supervideo', 'engines', lock.engineManifestSha256), { recursive: true });
    const command = () => spawnSync(process.execPath, [launcher, '--help'], { env: { ...process.env, XDG_CACHE_HOME: cacheDir }, encoding: 'utf8' });
    expect(command().status).toBe(0);
    await run();
    expect(fs.readFileSync(launcher)).toEqual(fs.readFileSync(path.join(bundled, 'scripts', 'video.mjs')));
    expect(command().status).toBe(0);
  });

  it('keeps the existing lock when an engine is incomplete, then installs a launchable engine after repair', async () => {
    const bundled = fileURLToPath(new URL('../../builtin-skills', import.meta.url));
    fs.cpSync(path.join(bundled, 'supervideo-engine'), path.join(sourceDir, 'supervideo-engine'), { recursive: true, force: true });
    fs.cpSync(path.join(bundled, 'skills', 'supervideo'), path.join(sourceDir, 'skills', 'supervideo'), { recursive: true, force: true });
    fs.cpSync(path.join(bundled, 'skills', 'supervideo'), path.join(skillDir, 'supervideo'), { recursive: true, force: true });
    const previousLock = {
      schemaVersion: 1, protocolVersion: 1, engineVersion: '0.1.0', engineManifest: 'engine-manifest.json',
      engineManifestSha256: '1e0433d6e916bfcfacad226151f809b19a6400625400aff2ef0bf3f2e6a0be91',
    };
    const lockPath = path.join(skillDir, 'supervideo', 'runtime.lock.json');
    const previousBytes = `${JSON.stringify(previousLock, null, 2)}\n`;
    fs.writeFileSync(lockPath, previousBytes);
    const damaged = path.join(sourceDir, 'supervideo-engine', 'src', 'core', 'model.mjs');
    const original = fs.readFileSync(damaged);
    fs.rmSync(damaged);
    const failed = await run();
    expect(failed.failed).toContain('supervideo-engine');
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(previousBytes);

    fs.writeFileSync(damaged, original);
    const repaired = await run();
    expect(repaired.failed).not.toContain('supervideo-engine');
    expect(repaired.updated).toContain('supervideo');
    const launcher = path.join(skillDir, 'supervideo', 'scripts', 'video.mjs');
    const result = spawnSync(process.execPath, [launcher, '--help'], { env: { ...process.env, XDG_CACHE_HOME: cacheDir }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status');
  });

  it.each([
    ['non-string file path', (file) => { file.path = 42; }],
    ['unsafe file size', (file) => { file.size = Number.MAX_SAFE_INTEGER + 1; }],
    ['malformed file digest', (file) => { file.sha256 = 'not-a-sha256'; }],
  ])('rejects a manifest with a %s before replacing the installed lock', async (_case, mutate) => {
    const destination = path.join(skillDir, 'supervideo');
    const bundled = fileURLToPath(new URL('../../builtin-skills/skills/supervideo', import.meta.url));
    fs.cpSync(bundled, destination, { recursive: true });
    const previousLock = fs.readFileSync(path.join(destination, 'runtime.lock.json'));
    const manifestPath = path.join(sourceDir, 'supervideo-engine', 'engine-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    mutate(manifest.files[0]);
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(manifestPath, bytes);
    const lockPath = path.join(sourceDir, 'skills', 'supervideo', 'runtime.lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath));
    lock.engineManifestSha256 = createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    expect((await run()).failed).toContain('supervideo-engine');
    expect(fs.readFileSync(path.join(destination, 'runtime.lock.json'))).toEqual(previousLock);
  });

  it('preserves an incomplete cache, restores a verified engine, and coordinates concurrent installers', async () => {
    const bundled = fileURLToPath(new URL('../../builtin-skills', import.meta.url));
    fs.cpSync(path.join(bundled, 'skills', 'supervideo'), path.join(skillDir, 'supervideo'), { recursive: true, force: true });
    const lockPath = path.join(skillDir, 'supervideo', 'runtime.lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const engine = path.join(cacheDir, 'supervideo', 'engines', lock.engineManifestSha256);
    fs.writeFileSync(path.join(sourceDir, 'supervideo-engine', 'unlisted.txt'), 'not part of the manifest');
    fs.mkdirSync(engine, { recursive: true });
    fs.writeFileSync(path.join(engine, 'partial-user-evidence'), 'retain me');
    const result = await Promise.all([run(), run()]);
    expect(result.flatMap((value) => value.failed)).not.toContain('supervideo-engine');
    expect(fs.readFileSync(path.join(engine, 'engine-manifest.json'), 'utf8')).toBe(fs.readFileSync(path.join(sourceDir, 'supervideo-engine', 'engine-manifest.json'), 'utf8'));
    expect(fs.existsSync(path.join(engine, 'unlisted.txt'))).toBe(false);
    const siblings = fs.readdirSync(path.dirname(engine));
    const preserved = siblings.filter((name) => name.startsWith(`${lock.engineManifestSha256}.incomplete-`));
    expect(preserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(engine), preserved[0], 'partial-user-evidence'), 'utf8')).toBe('retain me');
    const launcher = path.join(skillDir, 'supervideo', 'scripts', 'video.mjs');
    const output = spawnSync(process.execPath, [launcher, '--help'], { env: { ...process.env, XDG_CACHE_HOME: cacheDir }, encoding: 'utf8' });
    expect(output.status).toBe(0);
    expect(output.stdout).toContain('status');
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
