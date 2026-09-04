import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('copies the generated Markdown review artifact into a visible Obsidian vault run folder', function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-md-vault-test-'));
  try {
    const runDir = path.join(tmp, 'run-123');
    const vaultDir = path.join(tmp, 'vault');
    const artifactsDir = path.join(runDir, 'artifacts');
    fs.mkdirSync(path.join(vaultDir, '.obsidian'), { recursive: true });

    const script = fileURLToPath(new URL('./markdown-gate.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      script,
      '--fixture', 'G1-MARKDOWN-001',
      '--results-json', path.join(runDir, 'results.json'),
      '--artifacts-dir', artifactsDir,
      '--obsidian-vault', vaultDir
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const artifact = path.join(artifactsDir, 'torture-edited.md');
    const reviewCopy = path.join(vaultDir, 'SuperWagie验收', 'G1-MARKDOWN-001', 'run-123', 'torture-edited.md');
    const pointer = path.join(vaultDir, 'SuperWagie验收', 'G1-MARKDOWN-001', '当前验收.md');
    assert.equal(fs.existsSync(reviewCopy), true, 'the review copy must be visible inside the Obsidian vault');
    const artifactText = fs.readFileSync(artifact, 'utf8');
    const reviewText = fs.readFileSync(reviewCopy, 'utf8');
    const scopedLinkedPage = 'SuperWagie验收/G1-MARKDOWN-001/run-123/核心内容';
    const expectedReviewText = artifactText
      .replaceAll('![[核心内容#小节]]', '![[' + scopedLinkedPage + '#小节]]')
      .replaceAll('[[核心内容|显示名]]', '[[' + scopedLinkedPage + '|显示名]]')
      .replaceAll('[[核心内容#小节]]', '[[' + scopedLinkedPage + '#小节|核心内容#小节]]')
      .replaceAll('[[核心内容#^block-anchor]]', '[[' + scopedLinkedPage + '#^block-anchor|核心内容#^block-anchor]]')
      .replaceAll('[[核心内容]]', '[[' + scopedLinkedPage + '|核心内容]]');
    assert.equal(
      reviewText,
      expectedReviewText,
      'the Vault review copy must qualify its targets without exposing the folder path as link text'
    );
    assert.equal(reviewText.includes('[[核心内容'), false, 'bare linked-page targets must not collide with same-named Vault notes');
    assert.match(reviewText, new RegExp('!\\[\\[' + scopedLinkedPage + '#小节\\]\\]'));
    assert.match(reviewText, /- 嵌入图片：!\[\[图片素材\.png\]\]/);
    assert.match(reviewText, /- Excalidraw 容器：!\[\[系统架构\.excalidraw\]\]/);
    assert.match(fs.readFileSync(pointer, 'utf8'), /\[\[SuperWagie验收\/G1-MARKDOWN-001\/run-123\/torture-edited\]\]/);

    const reviewDir = path.dirname(reviewCopy);
    const linkedPage = path.join(reviewDir, '核心内容.md');
    const embeddedPng = path.join(reviewDir, '图片素材.png');
    const embeddedDrawing = path.join(reviewDir, '系统架构.excalidraw.md');
    assert.equal(fs.existsSync(linkedPage), true, 'the linked Markdown page must ship with the review copy');
    assert.equal(fs.existsSync(embeddedPng), true, 'the embedded PNG must ship with the review copy');
    assert.equal(fs.existsSync(embeddedDrawing), true, 'the embedded Excalidraw file must ship with the review copy');
    assert.match(fs.readFileSync(linkedPage, 'utf8'), /## 小节/);
    assert.match(fs.readFileSync(linkedPage, 'utf8'), /\^block-anchor/);
    const png = fs.readFileSync(embeddedPng);
    assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(
      png.readUInt32BE(16) <= 800,
      'the inline image fixture must fit after its label instead of forcing a line wrap'
    );
    const drawingText = fs.readFileSync(embeddedDrawing, 'utf8');
    assert.match(drawingText, /# Excalidraw Data/);
    const textSection = drawingText.split(/## Text Elements\r?\n/)[1].split(/\r?\n%%/)[0];
    const markdownTextIds = Array.from(
      textSection.matchAll(/\s\^([A-Za-z0-9]{8})\s*$/gm),
      function (match) { return match[1]; }
    ).sort();
    const sceneLine = drawingText.slice(drawingText.indexOf('## Drawing')).split(/\r?\n/).find(function (line) {
      return line.startsWith('{');
    });
    const scene = JSON.parse(sceneLine);
    const sceneTextIds = scene.elements.filter(function (element) {
      return element.type === 'text';
    }).map(function (element) {
      return element.id;
    }).sort();
    assert.equal(markdownTextIds.length, 4, 'every Excalidraw text block must use the plugin-required 8-character ID');
    assert.deepEqual(markdownTextIds, sceneTextIds, 'Markdown text block IDs must match the Drawing JSON text element IDs');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
