import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchDesktop } from './ui-lifecycle.mjs';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [join(appRoot, 'scripts/build.mjs')], { stdio: 'inherit' });
const ownedRoot = mkdtempSync(join(tmpdir(), 'superwagie-format-toolbar-'));
const project = join(ownedRoot, 'project');
mkdirSync(project);
const path = join(project, '工具栏体验.md');
writeFileSync(path, '你好世界\n\n第二段\n');
const output = join(process.env.SUPERWAGIE_REGRESSION_OUTPUT_ROOT || join(appRoot, 'test-results'), 'format-toolbar');
mkdirSync(output, { recursive: true });
let application;
let page;
const checks = {};
try {
  ({ application, page } = await launchDesktop({
    SUPERWAGIE_TEST_MODE: '1', SUPERWAGIE_TEST_PROJECT: project,
    SUPERWAGIE_TEST_STATE: join(ownedRoot, 'state'), SUPERWAGIE_TEST_PROFILE: join(ownedRoot, 'profile'),
  }));
  page.setDefaultTimeout(8_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  assert.match(page.url(), /^superwagie-app:\/\//);
  assert.match(await page.title(), /SuperWagie/);
  await page.getByRole('button', { name: '选择 Project…' }).click();
  await page.waitForSelector('.cm-content');
  const toolbar = page.getByRole('toolbar', { name: '文档格式' });
  assert.equal(await toolbar.count(), 1, 'Opening a document must expose a beginner-friendly formatting toolbar');
  const button = (name) => toolbar.getByRole('button', { name, exact: true });
  const saved = async (expected, file = path) => {
    await page.waitForFunction(() => document.querySelector('#save-status').dataset.status === 'saved');
    assert.equal(readFileSync(file, 'utf8'), expected);
  };
  const select = async (from, to = from) => {
    await page.getByRole('button', { name: '源码', exact: true }).click();
    await page.keyboard.press('Meta+ArrowUp');
    for (let i = 0; i < from; i++) await page.keyboard.press('ArrowRight');
    for (let i = from; i < to; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.getByRole('button', { name: '实时预览', exact: true }).click();
  };
  const replace = async (source) => {
    await page.getByRole('button', { name: '源码', exact: true }).click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.insertText(source);
    await saved(source);
  };
  await select(0, 2);
  await button('加粗').click();
  await saved('**你好**世界\n\n第二段\n');
  assert.equal(await button('加粗').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => window.getSelection().toString()), '你好');
  await button('加粗').click();
  await saved('你好世界\n\n第二段\n');
  checks.toolbar_formats_selection_and_toggles = true;

  await button('撤销').click();
  await saved('**你好**世界\n\n第二段\n');
  await button('重做').click();
  await saved('你好世界\n\n第二段\n');
  checks.toolbar_history_is_single_step = true;
  await page.waitForTimeout(2_300); // Cross the real external-refresh polling interval.
  assert.equal(await button('撤销').isEnabled(), true, 'Autosave and polling must not erase undo history');
  await button('撤销').click();
  await saved('**你好**世界\n\n第二段\n');
  await button('重做').click();
  await saved('你好世界\n\n第二段\n');
  checks.toolbar_history_survives_autosave = true;

  await select(4);
  await button('斜体').click();
  await page.keyboard.insertText('直接输入');
  await saved('你好世界*直接输入*\n\n第二段\n');
  checks.toolbar_empty_selection_supports_typing = true;

  const cdp = await page.context().newCDPSession(page);
  await page.keyboard.press('Meta+ArrowDown');
  const beforeComposition = readFileSync(path, 'utf8');
  await cdp.send('Input.imeSetComposition', { text: '中文组合', selectionStart: 4, selectionEnd: 4 });
  await page.waitForTimeout(250);
  assert.equal(await button('加粗').isDisabled(), true);
  assert.equal(readFileSync(path, 'utf8'), beforeComposition);
  await cdp.send('Input.insertText', { text: '中文完成' });
  await saved(beforeComposition + '中文完成');
  assert.equal(await button('加粗').isEnabled(), true);
  checks.toolbar_defers_during_composition = true;

  await replace('第一项\n第二项\n尾部');
  await select(0, 8);
  await button('有序列表').click();
  await saved('1. 第一项\n2. 第二项\n尾部');
  await button('待办清单').click();
  await saved('- [ ] 第一项\n- [ ] 第二项\n尾部');
  await button('待办清单').click();
  await saved('第一项\n第二项\n尾部');
  await select(0);
  await toolbar.getByRole('combobox', { name: '段落格式' }).selectOption('h2');
  await saved('## 第一项\n第二项\n尾部');
  await toolbar.getByRole('combobox', { name: '段落格式' }).selectOption('body');
  await button('引用').click();
  await saved('> 第一项\n第二项\n尾部');
  checks.toolbar_blocks_and_lists_transform_selection = true;

  await replace('打开文档');
  await select(0, 2);
  await button('链接').click();
  const dialog = page.getByRole('dialog', { name: '编辑链接' });
  assert.equal(await dialog.getByRole('textbox', { name: '显示文字' }).inputValue(), '打开');
  await dialog.getByRole('textbox', { name: '链接地址' }).fill('javascript:alert(1)');
  await dialog.getByRole('button', { name: '应用链接' }).click();
  assert.equal(await dialog.isVisible(), true);
  assert.match(await dialog.getByRole('alert').innerText(), /链接/);
  assert.equal(readFileSync(path, 'utf8'), '打开文档');
  await dialog.getByRole('textbox', { name: '链接地址' }).fill('https://example.com/a b');
  await page.screenshot({ path: join(output, 'link-dialog.png') });
  await dialog.getByRole('button', { name: '应用链接' }).click();
  await saved('[打开](<https://example.com/a%20b>)文档');
  await button('链接').click();
  await dialog.getByRole('button', { name: '移除链接' }).click();
  await saved('打开文档');
  await button('链接').click();
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), false);
  await page.keyboard.insertText('继续');
  await saved('继续文档');
  checks.toolbar_link_dialog_preserves_selection_and_is_safe = true;

  await button('链接').click();
  writeFileSync(path, '外部更新后的正文');
  await dialog.waitFor({ state: 'hidden' });
  await saved('外部更新后的正文');
  assert.equal(await page.locator('.cm-content').innerText(), '外部更新后的正文');
  checks.toolbar_link_dialog_invalidates_on_document_change = true;

  await replace('代码示例');
  await select(0, 2);
  await button('更多格式').click();
  await button('行内代码').click();
  await saved('`代码`示例');
  await select(6);
  await button('更多格式').click();
  await button('分割线').click();
  await saved('`代码`示例\n\n---\n\n');
  checks.toolbar_more_actions_work = true;

  await replace('键盘访问');
  await select(0, 2);
  await button('加粗').focus();
  await page.keyboard.press('Enter');
  await saved('**键盘**访问');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  assert.equal(await toolbar.isVisible(), false);
  assert.equal(await page.locator('.editor-preview strong').innerText(), '键盘');
  await page.keyboard.press('Meta+e');
  assert.equal(await toolbar.isVisible(), true);
  await button('撤销').click();
  await saved('键盘访问');
  checks.toolbar_modes_and_keyboard_focus = true;

  await replace('---\ntitle: 不能改\n---\n\n```js\nconst x = 1\n```\n正文');
  await select(6);
  assert.equal(await button('加粗').isDisabled(), true);
  await select(30);
  assert.equal(await button('加粗').isDisabled(), true);
  checks.toolbar_protects_metadata_and_code = true;

  const crlfPath = join(project, '换行格式.md');
  writeFileSync(crlfPath, '保留换行\r\n第二行\r\n');
  await page.getByRole('button', { name: '刷新文件列表' }).click();
  await page.getByText('换行格式.md', { exact: true }).click();
  await select(0, 4);
  await button('加粗').click();
  await saved('**保留换行**\r\n第二行\r\n', crlfPath);
  await page.getByRole('button', { name: '关闭 换行格式.md', exact: true }).click();
  assert.equal(await button('加粗').isDisabled(), true);
  assert.equal(await button('撤销').isDisabled(), true);
  await page.getByText('换行格式.md', { exact: true }).click();
  await select(0);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  assert.equal(await page.locator('.editor-preview strong').innerText(), '保留换行');
  checks.toolbar_crlf_autosave_and_reopen = true;

  await page.getByText('工具栏体验.md', { exact: true }).click();
  await replace('# 开始写作\n\n选中文字，点击工具栏即可排版。\n\n- [ ] 整理今天的想法\n- [x] 不用记住 Markdown 语法\n\n> 内容自动保存，操作随时撤销。\n');
  await select(9, 14);
  await button('加粗').click();
  await page.keyboard.press('Meta+ArrowDown');
  for (const width of [960, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await toolbar.evaluate((element) => ({ scroll: element.scrollWidth, width: element.clientWidth, right: element.getBoundingClientRect().right }));
    assert.ok(bounds.scroll <= bounds.width + 1 && bounds.right <= width, 'Formatting controls must not overflow the editing pane');
    await page.screenshot({ path: join(output, `toolbar-${width}.png`) });
  }
  checks.toolbar_responsive_layout = true;
  assert.deepEqual(errors, [], 'Formatting interactions must not emit renderer errors');
  checks.toolbar_renderer_health = true;

  const result = { regression_run_id: process.env.SUPERWAGIE_REGRESSION_RUN_ID || null,
    scope: 'local-mac-format-toolbar', checks, admission_effect: 'none',
    platform: { os: process.platform, arch: process.arch },
    limitations: ['Real macOS Electron flow; does not sign off Windows or native input-method candidate UI.'] };
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: join(output, 'failure.png') });
  throw error;
} finally {
  if (application) await application.close();
  rmSync(ownedRoot, { recursive: true, force: true });
}
