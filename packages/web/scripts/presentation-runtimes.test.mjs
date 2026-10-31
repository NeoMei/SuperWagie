import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { preparePresentationRuntimes, requireNativeTarget, verifyPresentationResource } from './prepare-presentation-runtimes.mjs';
import { installBuiltinSkills } from '../server/lib/builtin-skills/install.js';
import { isImagePlaceholder, exposePresentationSkill } from '../server/lib/builtin-skills/presentation-runtime.js';

const web = fileURLToPath(new URL('../', import.meta.url));
const resourceDir = process.env.PRESENTATION_RESOURCE_DIR || path.join(web, 'server/presentation-runtime');
const run = (args, options = {}) => {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
};

test('foreign architecture is rejected before dependency installation', () => {
  assert.throws(() => requireNativeTarget(process.platform, process.arch === 'arm64' ? 'x64' : 'arm64'), /native build worker/);
});

test('exact old placeholder migrates, edited and extra files remain owned by the user', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'presentation-placeholder-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const skillDir = path.join(temp, 'skills');
  const skill = path.join(skillDir, 'image-to-editable-pptx');
  await fs.mkdir(skill, { recursive: true });
  await fs.cp(path.join(web, 'scripts/fixtures/image-placeholder'), skill, { recursive: true });
  assert.equal(await isImagePlaceholder(skill), true);
  await fs.writeFile(path.join(skill, 'custom.txt'), 'keep');
  assert.equal(await isImagePlaceholder(skill), false);
  await fs.rm(path.join(skill, 'custom.txt'));
  const runtime = path.join(temp, 'runtime');
  await fs.mkdir(path.join(runtime, 'skills/image-to-editable-pptx'), { recursive: true });
  await assert.rejects(exposePresentationSkill({ name: 'image-to-editable-pptx', skillDir, runtime, replacePlaceholder: true, io: { ...fs, symlink: async () => { throw new Error('injected link failure'); } } }), /injected link failure/);
  assert.equal(await isImagePlaceholder(skill), true);
  await fs.rename(skill, `${skill}.superwagie-placeholder`);
  await exposePresentationSkill({ name: 'image-to-editable-pptx', skillDir, runtime });
  assert.equal(await fs.realpath(skill), await fs.realpath(path.join(runtime, 'skills/image-to-editable-pptx')));
});

test('prepared payload installs and refuses live CLI and library before environment or discovery', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'presentation runtime 中文 '));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  for (const name of ['superppt', 'image-to-editable-pptx']) await verifyPresentationResource(path.join(resourceDir, name));
  const sourceDir = path.join(temp, 'source');
  await fs.mkdir(path.join(sourceDir, 'skills'), { recursive: true });
  const result = await installBuiltinSkills({ sourceDir, skillDir: path.join(temp, 'skills'), dataDir: path.join(temp, 'data'), cacheDir: path.join(temp, 'cache'), extraSkillsDir: path.dirname(resourceDir), warn: (message) => { throw new Error(message); } });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.installed.sort(), ['image-to-editable-pptx', 'superppt']);
  const runtime = path.join(temp, 'data/skills-runtime/image-to-editable-pptx');
  const superppt = path.join(temp, 'data/skills-runtime/superppt');
  const help = spawnSync('/bin/sh', [path.join(superppt, 'superwagie-cli.sh'), '--help'], { env: { PATH: '/usr/bin:/bin', SUPERWAGIE_MODEL_NODE: process.env.PRESENTATION_TEST_NODE || process.execPath }, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /superppt/i);
  const script = path.join(temp, 'refusal.mjs');
  await fs.writeFile(script, `
    import assert from 'node:assert/strict';
    import {pathToFileURL} from 'node:url';
    const root=${JSON.stringify(runtime)};
    const {runCli}=await import(pathToFileURL(root+'/dist/src/cli.js'));
    const {analyzeSlide,runPipeline}=await import(pathToFileURL(root+'/dist/src/pipeline.js'));
    const env=new Proxy({}, {get(){throw Error('credentials were accessed')}});
    for(const command of ['analyze','run']) await assert.rejects(runCli([command],env),/offline reconstruction only/);
    const options=new Proxy({}, {get(){throw Error('options were accessed')}});
    await assert.rejects(analyzeSlide(options),/offline reconstruction only/);
    await assert.rejects(runPipeline(options),/offline reconstruction only/);
    let builds=0;
    await runCli(['build-v1','source.png','--analysis','legacy','--out','result'],env,{build:async()=>{builds++}});
    assert.equal(builds,1);
  `);
  run([script]);
  const denied = path.join(temp, 'denied.mjs');
  await fs.writeFile(denied, `import http from 'node:http';import https from 'node:https';import net from 'node:net';const refuse=()=>{throw Error('network denied')};globalThis.fetch=refuse;http.request=http.get=https.request=https.get=net.connect=net.createConnection=refuse;`);
  const fixture = await fs.readFile(path.join(web, 'scripts/fixtures/presentation-offline.mjs'), 'utf8');
  await fs.writeFile(path.join(runtime, 'fixture.mjs'), fixture);
  run(['--import', denied, path.join(runtime, 'fixture.mjs'), path.join(temp, 'analysis')], { cwd: runtime });
  const executable = process.env.PRESENTATION_TEST_NODE || process.execPath;
  const env = { PATH: '/usr/bin:/bin', SUPERWAGIE_MODEL_NODE: executable, NODE_OPTIONS: `--import=${JSON.stringify(denied)}` };
  const build = spawnSync('/bin/sh', [path.join(runtime, 'superwagie-cli.sh'), 'build', '--analysis', path.join(temp, 'analysis'), '--out', path.join(temp, 'output'), '--required-text-count', '1'], { env, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const fakeOcx = path.join(temp, 'ocx');
  const marker = path.join(temp, 'discovery-called');
  await fs.writeFile(fakeOcx, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  for (const command of ['analyze', 'run']) {
    const refusal = spawnSync('/bin/sh', [path.join(runtime, 'superwagie-cli.sh'), command], { env: { ...env, PATH: `${temp}:/usr/bin:/bin`, OPENAI_API_KEY: 'canary-not-a-key', DASHSCOPE_API_KEY: 'canary-not-a-key', DASHSCOPE_WORKSPACE_ID: 'canary' }, encoding: 'utf8' });
    assert.equal(refusal.status, 1);
    assert.match(refusal.stderr, /offline reconstruction only/);
    assert.doesNotMatch(refusal.stderr, /canary/);
  }
  await assert.rejects(fs.access(marker));
  const check = path.join(runtime, 'inspect.mjs');
  await fs.writeFile(check, `import fs from 'node:fs/promises';import JSZip from 'jszip';import assert from 'node:assert/strict';const zip=await JSZip.loadAsync(await fs.readFile(${JSON.stringify(path.join(temp, 'output/slide-editable.pptx'))}));assert.match(await zip.file('ppt/slides/slide1.xml').async('string'),/<a:t>Offline editable runtime<\\/a:t>/);`);
  await fs.appendFile(check, `await fs.writeFile(${JSON.stringify(path.join(temp, 'patch.json'))},JSON.stringify({mediaPath:Object.keys(zip.files).find(p=>p.startsWith('ppt/media/')&&p.endsWith('.png')),region:{x:0,y:0,width:16,height:16},background:'#ffffff',texts:[]}));`);
  run([check]);
  const patched = spawnSync('/bin/sh', [path.join(runtime, 'superwagie-cli.sh'), 'raster-patch', path.join(temp, 'output/slide-editable.pptx'), '--patch', path.join(temp, 'patch.json'), '--out', path.join(temp, 'patched.pptx')], { env, encoding: 'utf8' });
  assert.equal(patched.status, 0, patched.stderr);
  assert.ok((await fs.stat(path.join(temp, 'patched.pptx'))).size > 1000);
  const outputs = await fs.readdir(path.join(temp, 'output'));
  assert.ok(outputs.includes('manifest.json'));
  for (const preview of ['exploded-preview.png', 'layer-review.png', 'recomposition-preview.png']) assert.ok(outputs.includes(preview));
  const manifest = JSON.parse(await fs.readFile(path.join(temp, 'output/manifest.json'), 'utf8'));
  assert.equal(manifest.manifestVersion, 2);
  if (process.env.PRESENTATION_TEST_ARTIFACTS) await fs.cp(path.join(temp, 'output'), process.env.PRESENTATION_TEST_ARTIFACTS, { recursive: true });
});


test('an invalid vendor source preserves the previous complete resource', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'presentation-stale-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const destination = path.join(temp, 'resource');
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'previous'), 'valid old payload');
  await assert.rejects(preparePresentationRuntimes({ source: path.join(temp, 'missing-source'), destination }));
  assert.equal(await fs.readFile(path.join(destination, 'previous'), 'utf8'), 'valid old payload');
  assert.deepEqual(await fs.readdir(temp), ['resource']);
});
