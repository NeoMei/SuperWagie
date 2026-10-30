import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const modulePath = 'github.com/yanyiwu/gojieba';
const version = 'v1.4.7';
const moduleSum = 'h1:2YkXELcYLTE0SJetq6xv4MjpEikWga6VpFn4jIFFQ/k=';
const moduleFileSum = 'h1:JUq4DddFVGdHXJHxxepxRmhrKlDpaBxR8O28v6fKYLY=';
const dictionaryDirectory = 'jieba-dict';
const files = [
  { path: 'jieba.dict.utf8', source: 'deps/cppjieba/dict/jieba.dict.utf8', size: 5071204, sha256: '3043b77068e09c9904f27cad82f12b6ebe9dbdb5aeff3b25e45ab7f9c1122b55' },
  { path: 'hmm_model.utf8', source: 'deps/cppjieba/dict/hmm_model.utf8', size: 519739, sha256: 'f17790586ac86dd048c8adffed052c4bd2b28ed0682972c1275e59040c0589a7' },
  { path: 'user.dict.utf8', source: 'deps/cppjieba/dict/user.dict.utf8', size: 49, sha256: '495bbf49270408a1234690e1e6a97328f30a482a7a72aa769e8a12e8714b0c62' },
  { path: 'idf.utf8', source: 'deps/cppjieba/dict/idf.utf8', size: 5998717, sha256: 'dbd1e03d72b2263cc8d84a4304ed77677eed9e7deaf43a1a5133bbba9733b535' },
  { path: 'stop_words.utf8', source: 'deps/cppjieba/dict/stop_words.utf8', size: 8974, sha256: 'b788b8a939d2e2fe079abd579ea98f12f9fb84370bfd0dddd81bb9381f7ab42c' },
  { path: 'LICENSE.gojieba', source: 'LICENSE', size: 1088, sha256: 'd64715c9f769d9a040bfa8c11ceb5f6d7174fbc9a5bd2b4b7368fbf33891028e' },
  { path: 'LICENSE.cppjieba', source: 'deps/cppjieba/LICENSE', size: 1066, sha256: 'ba898a14f729ba5e9965da34e3eecd5edd3795f2cc5d7c923b815ba79bb851b0' },
];
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const identity = () => {
  const entries = files.map(({ path: relative, size, sha256: digest }) => ({ path: relative, size, sha256: digest }));
  return { version: version.slice(1), directory: dictionaryDirectory,
    sha256: crypto.createHash('sha256').update(JSON.stringify({ modulePath, version, moduleSum, files: entries })).digest('hex'), files: entries };
};

function verifyFiles(directory, selectPath) {
  for (const file of files) {
    const candidate = path.join(directory, selectPath(file));
    const stat = fs.lstatSync(candidate);
    assert(stat.isFile(), `Jieba resource is not a regular file: ${file.path}`);
    assert.equal(stat.size, file.size, `Jieba resource size mismatch: ${file.path}`);
    assert.equal(sha256(candidate), file.sha256, `Jieba resource checksum mismatch: ${file.path}`);
  }
}

export function matchesJiebaDictionary(manifest, directory) {
  try {
    assert.deepEqual(manifest?.jiebaDictionary, identity());
    const target = path.join(directory, dictionaryDirectory);
    assert(fs.lstatSync(target).isDirectory(), 'Jieba resource directory must be a real directory');
    assert.deepEqual(fs.readdirSync(target).sort(), files.map(file => file.path).sort());
    verifyFiles(target, file => file.path);
    return true;
  } catch {
    return false;
  }
}

/** The pinned backend already reads JIEBA_DICT_DIR; never use Go's build-host fallback. */
export function stageJiebaDictionary(sourceDirectory, outputDirectory) {
  const goModule = fs.readFileSync(path.join(sourceDirectory, 'go.mod'), 'utf8').replace(/\r\n/g, '\n');
  assert(goModule.split('\n').some(line => line.trim() === `${modulePath} ${version}`), 'Knowledge backend gojieba version changed');
  const sums = fs.readFileSync(path.join(sourceDirectory, 'go.sum'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  assert(sums.includes(`${modulePath} ${version} ${moduleSum}`), 'Knowledge backend gojieba checksum changed');
  assert(sums.includes(`${modulePath} ${version}/go.mod ${moduleFileSum}`), 'Knowledge backend gojieba module checksum changed');
  const initializer = fs.readFileSync(path.join(sourceDirectory, 'internal/types/evaluation.go'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(crypto.createHash('sha256').update(initializer).digest('hex'), '9f2cfcbc5f4dc75385e960954dcbbd9c11d79f47c2c767f61ce1803136909862', 'Knowledge backend Jieba initializer changed');
  const downloaded = spawnSync('go', ['mod', 'download', '-json', `${modulePath}@${version}`], {
    cwd: sourceDirectory, env: { ...process.env, GOWORK: 'off' }, encoding: 'utf8', windowsHide: true, timeout: 120_000,
  });
  if (downloaded.error) throw downloaded.error;
  assert.equal(downloaded.status, 0, 'Unable to resolve pinned Jieba resources');
  const module = JSON.parse(downloaded.stdout);
  assert.equal(module.Path, modulePath); assert.equal(module.Version, version);
  assert.equal(module.Sum, moduleSum); assert.equal(module.GoModSum, moduleFileSum);
  assert(path.isAbsolute(module.Dir), 'Jieba module directory must be absolute');
  verifyFiles(module.Dir, file => file.source);

  fs.mkdirSync(outputDirectory, { recursive: true });
  const staging = fs.mkdtempSync(path.join(outputDirectory, '.jieba-dict-'));
  const target = path.join(outputDirectory, dictionaryDirectory);
  const previous = `${staging}.previous`;
  try {
    for (const file of files) fs.copyFileSync(path.join(module.Dir, file.source), path.join(staging, file.path));
    verifyFiles(staging, file => file.path);
    if (fs.existsSync(target)) fs.renameSync(target, previous);
    try { fs.renameSync(staging, target); }
    catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, target); throw error; }
    fs.rmSync(previous, { recursive: true, force: true });
    return identity();
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
