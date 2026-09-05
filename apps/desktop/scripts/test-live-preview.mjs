import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchDesktop } from './ui-lifecycle.mjs';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(appRoot, '..', '..');
execFileSync(process.execPath, [join(appRoot, 'scripts/build.mjs')], { stdio: 'inherit' });
const ownedRoot = mkdtempSync(join(tmpdir(), 'superwagie-live-preview-'));
const project = join(ownedRoot, 'project');
mkdirSync(project);
const path = join(project, '实时预览.md');
const original = readFileSync(join(repoRoot, 'fixtures/local-mac-workspace/live-preview.md'), 'utf8');
writeFileSync(path, original);
const output = join(appRoot, 'test-results/live-preview');
mkdirSync(output, { recursive: true });
let application;
let page;
try {
  const launched = await launchDesktop({
    SUPERWAGIE_TEST_MODE: '1', SUPERWAGIE_TEST_PROJECT: project,
    SUPERWAGIE_TEST_STATE: join(ownedRoot, 'state'),
    SUPERWAGIE_TEST_PROFILE: join(ownedRoot, 'profile'),
  });
  application = launched.application;
  page = launched.page;
  page.setDefaultTimeout(8_000);
  await page.getByRole('button', { name: '选择 Project…' }).click();
  await page.waitForSelector('.cm-content');
  const checks = {};
  const saved = async () => {
    await page.waitForFunction(() => document.querySelector('#save-status').dataset.status === 'saved');
  };
  assert.equal(await page.locator('.editor-stage').getAttribute('data-mode'), 'live',
    'Opening Markdown must default to inline Live Preview');
  const line = (text) => page.locator('.cm-line').filter({ hasText: text }).first();
  await line('最后一行').click();
  await page.waitForFunction(() => !document.querySelector('.cm-content').textContent.includes('**粗体文字**'));
  assert.equal(await page.locator('.cm-content .sw-md-strong').filter({ hasText: '粗体文字' }).evaluate((e) => getComputedStyle(e).fontWeight), '700');
  checks.inactive_syntax_is_rendered = true;
  await page.locator('.sw-md-strong').filter({ hasText: '粗体文字' }).click();
  await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('**粗体文字**'));
  assert.equal((await page.locator('.cm-content').innerText()).includes('~~删除文字~~'), false,
    'Editing bold must not unfold unrelated inline syntax');
  checks.cursor_reveals_only_its_syntax = true;
  await page.keyboard.insertText('定位');
  await saved();
  assert.equal(readFileSync(path, 'utf8'), original.replace('**粗体文字**', '**粗体定位文字**'),
    'Clicking the middle of rendered bold must insert at that exact source offset');
  await page.keyboard.press('Meta+z');
  await saved();
  assert.equal(readFileSync(path, 'utf8'), original);
  checks.pointer_maps_to_exact_source_offset = true;
  await page.locator('.cm-scroller').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: join(output, 'active-syntax.png') });
  await page.keyboard.press('Meta+ArrowLeft');
  await page.keyboard.press('ArrowDown');
  const arrowLine = await page.evaluate(() => {
    const node = window.getSelection()?.anchorNode;
    return (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.cm-line')?.textContent;
  });
  assert.equal(arrowLine, '', 'ArrowDown from a decorated paragraph must enter the following blank line');
  checks.arrow_navigation_uses_visual_lines = true;
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Meta+ArrowLeft');
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  assert.match(await page.evaluate(() => window.getSelection().toString()), /\*\*粗体文字\*\*/);
  checks.shift_selection_crosses_formatted_paragraphs = true;
  await page.keyboard.press('Meta+ArrowDown');
  await page.waitForFunction(() => !document.querySelector('.cm-content').textContent.includes('**粗体文字**'));
  assert.equal(readFileSync(path, 'utf8'), original, 'Cursor movement must never save rendered text');
  checks.cursor_navigation_preserves_bytes = true;
  await page.keyboard.press('Meta+a');
  const selectedSource = await page.evaluate(() => window.getSelection().toString());
  assert.equal(selectedSource, original, 'Select all must reveal and select original Markdown including block widgets');
  checks.cross_block_selection_reveals_source = true;
  await page.keyboard.press('ArrowRight');
  await page.locator('.sw-md-task').first().click();
  await saved();
  assert.equal(readFileSync(path, 'utf8'), original.replace('- [ ] 待办事项', '- [x] 待办事项'));
  await page.locator('.sw-md-task').first().click();
  await saved();
  assert.equal(readFileSync(path, 'utf8'), original);
  checks.task_checkbox_changes_only_its_marker = true;
  await page.locator('.sw-md-table td').filter({ hasText: '已连接' }).click();
  await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('| 编辑器 | 已连接 |'));
  await page.keyboard.press('Meta+ArrowDown');
  await page.locator('.sw-md-table').waitFor();
  assert.equal(readFileSync(path, 'utf8'), original);
  checks.table_click_and_leave_preserves_source = true;
  await page.locator('.sw-md-wikilink').click();
  await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('[[链接页|内部别名]]'));
  await page.keyboard.press('Meta+ArrowDown');
  assert.equal((await page.locator('.cm-content').innerText()).includes('[[链接页|内部别名]]'), false);
  checks.wikilink_alias_reveals_full_target = true;
  await page.locator('.sw-md-strong').filter({ hasText: '粗体文字' }).dblclick();
  assert.ok((await page.evaluate(() => window.getSelection().toString())).length > 0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Meta+ArrowDown');
  checks.double_click_selects_editable_text = true;
  assert.match(await line('const value').innerText(), /\*\*不要渲染代码中的标记\*\*/);
  assert.equal(await page.locator('.cm-content img:not(.cm-widgetBuffer)').count(), 0);
  checks.code_and_active_html_stay_inert = true;
  await page.locator('.cm-scroller').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: join(output, 'live-preview.png') });
  await page.getByRole('button', { name: '源码', exact: true }).click();
  assert.match(await page.locator('.cm-content').innerText(), /\*\*粗体文字\*\*/);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  assert.equal(await page.locator('.cm-content').isVisible(), false);
  assert.equal(await page.locator('.editor-preview strong').filter({ hasText: '粗体文字' }).count(), 1);
  await page.getByRole('button', { name: '实时预览', exact: true }).click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.insertText('中文🙂实时编辑');
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.status === 'saved');
  assert.equal(readFileSync(path, 'utf8'), original + '中文🙂实时编辑');
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await page.getByRole('button', { name: '实时预览', exact: true }).click();
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.status === 'saved');
  assert.equal(readFileSync(path, 'utf8'), original);
  checks.mode_switch_edit_undo_preserves_source = true;
  await page.keyboard.press('Meta+e');
  assert.equal(await page.locator('.editor-stage').getAttribute('data-mode'), 'reading');
  await page.keyboard.press('Meta+e');
  assert.equal(await page.locator('.editor-stage').getAttribute('data-mode'), 'live');
  checks.reading_shortcut_restores_editing_mode = true;
  const cdp = await page.context().newCDPSession(page);
  await page.keyboard.press('Meta+ArrowDown');
  await cdp.send('Input.imeSetComposition', { text: '中文组合', selectionStart: 4, selectionEnd: 4 });
  await page.waitForTimeout(350);
  assert.equal(readFileSync(path, 'utf8'), original, 'Preedit must not be committed to disk');
  await cdp.send('Input.insertText', { text: '中文组合🙂' });
  await saved();
  assert.equal(readFileSync(path, 'utf8'), original + '中文组合🙂');
  checks.browser_composition_commits_once = true;
  const crlfPath = join(project, '换行保真.md');
  const crlf = original.replaceAll('\n', '\r\n');
  writeFileSync(crlfPath, crlf);
  await page.getByRole('button', { name: '刷新文件列表' }).click();
  await page.getByText('换行保真.md', { exact: true }).click();
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.insertText('追加');
  await saved();
  assert.equal(readFileSync(crlfPath, 'utf8'), crlf + '追加');
  checks.crlf_survives_real_editor_save = true;
  const longPath = join(project, '长文交互.md');
  const longSource = Array.from({ length: 800 }, (_, index) => `第 ${index} 段 **重要内容** 与 [[链接页|链接]]。\n`).join('\n');
  writeFileSync(longPath, longSource);
  await page.getByRole('button', { name: '刷新文件列表' }).click();
  await page.getByText('长文交互.md', { exact: true }).click();
  await page.getByRole('button', { name: '实时预览', exact: true }).click();
  await page.keyboard.press('Meta+ArrowDown');
  const inputStart = performance.now();
  await page.keyboard.insertText('长文输入');
  await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('长文输入'));
  const inputMs = Math.round(performance.now() - inputStart);
  await saved();
  assert.equal(readFileSync(longPath, 'utf8'), longSource + '长文输入');
  assert.ok(inputMs < 1000, `Long document input took ${inputMs}ms`);
  checks.long_document_edit_stays_responsive = true;
  const implementation = ['live-preview.mjs', 'editor-host.mjs', 'safe-preview.mjs', 'markdown-model.mjs']
    .map((name) => readFileSync(join(appRoot, 'src/renderer/editor', name)));
  const result = {
    scope: 'local-mac-live-preview',
    platform: { os_version: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(), arch: process.arch },
    implementation_sha256: createHash('sha256').update(Buffer.concat(implementation)).digest('hex'),
    checks,
    metrics: { long_document_paragraphs: 800, input_to_visible_ms: inputMs },
    limitations: ['Composition is exercised through Chromium Input.imeSetComposition, not an OS input-method candidate window.', 'This suite does not establish all Obsidian syntax, plugin, attachment, or cross-platform parity.'],
    admission_effect: 'none',
  };
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) {
    console.error(await page.locator('.cm-content').innerHTML());
    console.error(await page.evaluate(() => ({ selection: window.getSelection()?.toString(), anchor: window.getSelection()?.anchorNode?.textContent, offset: window.getSelection()?.anchorOffset })));
    await page.screenshot({ path: join(output, 'failure.png') });
  }
  throw error;
} finally {
  if (application) await application.close();
  rmSync(ownedRoot, { recursive: true, force: true });
}
