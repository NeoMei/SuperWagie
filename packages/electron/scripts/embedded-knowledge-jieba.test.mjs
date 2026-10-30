import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { matchesJiebaDictionary, stageJiebaDictionary } from './embedded-knowledge-jieba.mjs';

const sum = 'github.com/yanyiwu/gojieba v1.4.7 h1:2YkXELcYLTE0SJetq6xv4MjpEikWga6VpFn4jIFFQ/k=\ngithub.com/yanyiwu/gojieba v1.4.7/go.mod h1:JUq4DddFVGdHXJHxxepxRmhrKlDpaBxR8O28v6fKYLY=\n';

test('portable knowledge dictionaries reject stale manifests and incomplete resources', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-jieba-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(matchesJiebaDictionary({}, root), false);
  assert.equal(matchesJiebaDictionary({ jiebaDictionary: { version: '1.4.7', files: [] } }, root), false);
  fs.mkdirSync(path.join(root, 'jieba-dict'));
  fs.writeFileSync(path.join(root, 'jieba-dict/jieba.dict.utf8'), 'unexpected dictionary');
  assert.equal(matchesJiebaDictionary({ jiebaDictionary: { version: '1.4.7', files: [] } }, root), false);
});

test('staging refuses dependency or initializer drift before touching existing resources', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-jieba-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'existing'), 'preserve');
  fs.writeFileSync(path.join(root, 'go.mod'), 'module fixture\nrequire github.com/yanyiwu/gojieba v1.4.6\n');
  assert.throws(() => stageJiebaDictionary(root, output), /gojieba version changed/);
  fs.writeFileSync(path.join(root, 'go.mod'), 'module fixture\nrequire (\n github.com/yanyiwu/gojieba v1.4.7\n)\n');
  fs.writeFileSync(path.join(root, 'go.sum'), 'changed');
  assert.throws(() => stageJiebaDictionary(root, output), /gojieba checksum changed/);
  fs.writeFileSync(path.join(root, 'go.sum'), sum);
  fs.mkdirSync(path.join(root, 'internal/types'), { recursive: true });
  fs.writeFileSync(path.join(root, 'internal/types/evaluation.go'), 'var Jieba = gojieba.NewJieba()\n');
  assert.throws(() => stageJiebaDictionary(root, output), /Jieba initializer changed/);
  assert.deepEqual(fs.readdirSync(output), ['existing']);
  assert.equal(fs.readFileSync(path.join(output, 'existing'), 'utf8'), 'preserve');
});
