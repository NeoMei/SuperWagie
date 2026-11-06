import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutableOnPath } from '../tunnels/executable-search.js';

const engine = fileURLToPath(new URL('../../builtin-skills/supervideo-engine', import.meta.url));
const loader = fileURLToPath(new URL('./fixtures/supervideo-test-loader.mjs', import.meta.url));
const operation = fileURLToPath(new URL('./fixtures/supervideo-operation.mjs', import.meta.url));
const dependencies = process.env.SUPERVIDEO_TEST_DEPENDENCIES;
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function pythonExecutable(env = process.env) {
  const requested = env.SUPERVIDEO_TEST_PYTHON ?? 'python3';
  if (isAbsolute(requested) || requested.includes('/') || requested.includes('\\')) return resolve(requested);
  const command = process.platform === 'win32' && requested.toLowerCase().endsWith('.exe') ? requested.slice(0, -4) : requested;
  const executable = findExecutableOnPath(command, { env });
  if (!executable) throw new Error(`Python executable is unavailable: ${requested}`);
  return resolve(executable);
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'supervideo-readiness-')); roots.push(root);
  for (const name of ['home', 'config', 'cache', 'data', 'tmp']) mkdirSync(join(root, name));
  const env = {
    HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_DATA_HOME: join(root, 'data'), TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), LANG: 'C.UTF-8',
    NODE_OPTIONS: `--import ${JSON.stringify(loader)}`, SUPERVIDEO_TEST_ENGINE: engine,
    SUPERVIDEO_TEST_DEPENDENCIES: dependencies,
  };
  return { root, env };
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, ...options });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout);
}

async function document(root, malformed = false) {
  const JSZip = createRequire(join(dependencies, 'package.json'))('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Offline fixture.</w:t></w:r></w:p>${malformed ? '' : '</w:body>'}</w:document>`);
  const file = join(root, 'tiny.docx'); writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' })); return file;
}

function executable(root, name, code) {
  const path = join(root, name); writeFileSync(path, `#!${process.execPath}\n${code}\n`); chmodSync(path, 0o700); return path;
}

function runtime(root, python) {
  const path = join(root, 'runtime.json');
  writeFileSync(path, JSON.stringify({ ...(python ? { python } : {}), markitdown: join(root, 'missing-markitdown'),
    browserExecutable: join(root, 'missing-browser'), playwrightModule: join(dependencies, 'node_modules/playwright-core'), fontPaths: [] }));
  return path;
}

describe('SuperVideo diagnostic protocol without prepared Node dependencies', () => {
  it('resolves Python outside the isolated operation PATH', () => {
    const { root, env } = workspace();
    const hostPython = run(process.env.SUPERVIDEO_TEST_PYTHON ?? 'python3', ['-I', '-S', '-c', 'import json,sys;print(json.dumps(sys.executable))'], {
      env: { ...env, PATH: process.env.PATH ?? process.env.Path ?? process.env.path,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    const outside = join(root, 'outside-path');
    symlinkSync(dirname(hostPython), outside, process.platform === 'win32' ? 'junction' : 'dir');
    const lookupEnv = { PATH: outside, PATHEXT: process.env.PATHEXT, SUPERVIDEO_TEST_PYTHON: basename(hostPython) };
    const python = pythonExecutable(lookupEnv);
    expect(env.PATH.split(delimiter)).not.toContain(outside);
    const args = ['-I', '-S', '-c', 'import json,os,sys;print(json.dumps({"major":sys.version_info.major,"home":os.environ["HOME"],"executable":os.path.normcase(os.path.realpath(sys.executable))}))'];
    const expected = run(hostPython, args, { env });
    const result = run(python, args, { env });
    expect(result).toEqual(expected);
    expect(result).toMatchObject({ major: 3, home: env.HOME });
    expect(python).toBe(resolve(outside, basename(hostPython)));
    expect(() => pythonExecutable({ ...lookupEnv, SUPERVIDEO_TEST_PYTHON: 'missing-owned-python' })).toThrow();
  });

  it('follows machine help to the shipped diagnostic API', () => {
    const { root, env } = workspace();
    const script = `
      const {runRuntime}=await import(${JSON.stringify(new URL('../../builtin-skills/supervideo-engine/src/runtime-cli.mjs', import.meta.url).href)});
      const help=await runRuntime(['--help']);
      const contract=JSON.parse(help.checks.find(check=>check.name==='runtime-contract').evidence);
      const pointer=contract.advanced.doctor;
      const api=await import(pointer.moduleUrl);
      console.log(JSON.stringify(await api[pointer.export]({say:${JSON.stringify(join(root, 'missing-say'))},markitdown:${JSON.stringify(join(root, 'missing-markitdown'))},fontPaths:[]})));
    `;
    const capabilities = run(process.execPath, ['--input-type=module', '-e', script], { env });
    expect(capabilities.find(item => item.id === 'python-ooxml')).toMatchObject({ available: false, remedy: expect.any(String) });
    expect(capabilities.find(item => item.id === 'office-browser-renderer')).toMatchObject({ available: false, remedy: expect.any(String) });
  });

  it('returns the structured missing-lxml prerequisite from the real Python entry', () => {
    const python = pythonExecutable();
    const { env } = workspace();
    const result = run(python, ['-I', '-S', join(engine, 'python/documents.py')], { env, input: '{}' });
    expect(result).toMatchObject({ error: { code: 'DEPENDENCY_MISSING' } });
    expect(result.error.detail).toMatch(/lxml.*MarkItDown/);
  });

  it('preserves an unrelated import failure at Python startup', () => {
    const python = pythonExecutable();
    const { env } = workspace();
    const script = `import builtins,runpy,sys\noriginal=builtins.__import__\ndef guarded(name,*args,**kwargs):\n if name=='lxml': raise ModuleNotFoundError('Owned unrelated import failure',name='owned_unrelated_module')\n return original(name,*args,**kwargs)\nbuiltins.__import__=guarded\nrunpy.run_path(sys.argv[1],run_name='__main__')`;
    const result = spawnSync(python, ['-I', '-S', '-c', script, join(engine, 'python/documents.py')], { env, encoding: 'utf8', timeout: 5000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(result.stdout).toBe(''); expect(result.stderr).toContain('Owned unrelated import failure');
  });
});

async function start(pythonFactory, { malformed = false } = {}) {
  const { root, env } = workspace(); const input = await document(root, malformed);
  const original = readFileSync(input);
  const python = pythonFactory?.(root, env);
  const config = runtime(root, python);
  const request = join(root, 'request.json');
  writeFileSync(request, JSON.stringify({ action: 'start', mode: 'lesson', output: { width: 640, height: 360, fps: 25 }, paths: [input], voice: { provider: 'host' } }));
  const result = run(process.execPath, [operation, engine, join(root, 'project'), request, config], { env });
  expect(result.project.sources).toEqual([]); expect(result.published).toEqual([]);
  expect(readFileSync(input)).toEqual(original);
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0].code).toBe(result.receipt.error.code);
  return result;
}

describe.skipIf(!dependencies || process.platform === 'win32')('SuperVideo readiness with an explicit prepared engine runtime', () => {
  it('executes the advertised doctor invocation with actionable unavailable capabilities', () => {
    const { root, env } = workspace();
    const config = join(root, 'runtime config.json');
    writeFileSync(config, JSON.stringify({ python: join(root, 'missing-python'), markitdown: join(root, 'missing-markitdown'), say: join(root, 'missing-say'), fontPaths: [] }));
    const manifest = JSON.parse(readFileSync(join(engine, 'runtime-manifest.json'), 'utf8'));
    const command = manifest.distribution.doctor.replace('/absolute/runtime.json', config);
    const capabilities = run('/bin/sh', ['-c', command], { env, cwd: engine });
    for (const id of ['python-ooxml', 'markitdown', 'playwright-browser', 'office-browser-renderer']) {
      expect(capabilities.find(item => item.id === id)).toMatchObject({ available: false, remedy: expect.any(String) });
    }
  });

  it.each([{ python: 'relative-python' }, { credentials: {} }, { unexpected: true }])('retains runtime configuration validation for %j', config => {
    const { root, env } = workspace(); const file = join(root, 'invalid-runtime.json');
    writeFileSync(file, JSON.stringify(config));
    const script = `const {loadRuntimeConfig}=await import(${JSON.stringify(new URL('../../builtin-skills/supervideo-engine/src/export.mjs', import.meta.url).href)});try{await loadRuntimeConfig(process.argv[1]);console.log(JSON.stringify({accepted:true}));}catch(error){console.log(JSON.stringify({code:error.code}));}`;
    expect(run(process.execPath, ['--input-type=module', '-e', script, file], { env })).toEqual({ code: 'INVALID_RUNTIME_CONFIG' });
  });

  it('reports a configured Python without lxml as an actionable dependency', async () => {
    const executable = pythonExecutable();
    const result = await start((root, env) => {
      const python = spawnSync(executable, ['-I', '-S', '-c', 'import sys; print(sys.executable)'], { env, encoding: 'utf8' });
      expect(python.status, python.stderr).toBe(0);
      const wrapper = join(root, 'python-no-lxml');
      writeFileSync(wrapper, `#!/bin/sh\nexec '${python.stdout.trim().replaceAll("'", "'\\''")}' -I -S "$@"\n`); chmodSync(wrapper, 0o700);
      return wrapper;
    });
    expect(result.receipt).toMatchObject({ status: 'needs_input', error: { code: 'DEPENDENCY_MISSING' } });
    expect(result.receipt.error.detail).toMatch(/lxml.*MarkItDown/);
    expect(result.failures[0].diagnostics[0]).toMatchObject({ code: 0, timedOut: false, outputLimited: false });
  });

  it('retains the same dependency classification when Python is absent', async () => {
    const result = await start();
    expect(result.receipt).toMatchObject({ status: 'needs_input', error: { code: 'DEPENDENCY_MISSING' } });
  });

  it.each([
    ['crash', 'process.stderr.write("Owned process crash");process.exit(17);', 'DOCUMENT_PROCESS_FAILED'],
    ['parser-error', 'console.log(JSON.stringify({error:{code:"DOCUMENT_EXTRACTION_FAILED",detail:"Owned semantic failure"}}));', 'DOCUMENT_EXTRACTION_FAILED'],
    ['invalid-json', 'console.log("not JSON");', 'DOCUMENT_EXTRACTION_FAILED'],
    ['output-limit', 'process.stdout.write("x".repeat(17*1024*1024));', 'DOCUMENT_RESOURCE_LIMIT'],
  ])('preserves a true %s failure after parser launch', async (name, code, expected) => {
    const result = await start(root => executable(root, name, code));
    expect(result.receipt).toMatchObject({ status: 'failed', error: { code: expected } });
  });

  it('rejects malformed XML before semantic execution', async () => {
    const result = await start(root => executable(root, 'must-not-run', 'throw Error("unexpected semantic launch");'), { malformed: true });
    expect(result.receipt).toMatchObject({ status: 'failed', error: { code: 'DOCUMENT_SIGNATURE_MISMATCH' } });
    expect(result.failures[0].diagnostics).toEqual([]);
  });

  it('retains a true bounded extraction timeout', async () => {
    const { root, env } = workspace(); const input = await document(root);
    const config = runtime(root, executable(root, 'timeout-python', 'setInterval(()=>{},1000);'));
    const result = run(process.execPath, [operation, engine, join(root, 'project'), input, config, 'timeout'], { env });
    expect(result.receipt).toMatchObject({ status: 'failed', error: { code: 'DOCUMENT_PROCESS_FAILED' } });
    expect(result.failures[0].diagnostics[0].timedOut).toBe(true);
    expect(result.published).toEqual([]);
  });
});
