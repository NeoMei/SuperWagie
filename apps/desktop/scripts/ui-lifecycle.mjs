import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(appRoot, '..', '..');
const electronBinary = join(appRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const coreBinary = join(repoRoot, 'crates', 'product-core', 'target', 'debug', 'superwagie-product-core');

function platformFacts() {
  return {
    os_version: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
    build: execFileSync('sw_vers', ['-buildVersion'], { encoding: 'utf8' }).trim(),
    arch: process.arch,
  };
}

export async function launchDesktop(environment) {
  const application = await electron.launch({
    executablePath: electronBinary,
    args: [appRoot],
    env: { ...process.env, ...environment },
    timeout: 30_000,
  });
  const page = await application.firstWindow({ timeout: 30_000 });
  page.on('console', (message) => {
    if (message.type() === 'error') process.stderr.write(`[renderer] ${message.text()}\n`);
  });
  page.on('pageerror', (error) => process.stderr.write(`[renderer] ${error.message}\n`));
  await page.waitForSelector('#app[data-ready="true"]', { timeout: 20_000 });
  return { application, page };
}

async function appendInEditor(page, text) {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.insertText(text);
}

async function waitForSaved(page) {
  await page.waitForFunction(() => document.querySelector('#save-status')?.dataset.status === 'saved', null, { timeout: 15_000 });
}

async function waitForEditorText(page, text) {
  try {
    await page.waitForFunction(
      (expected) => document.querySelector('.cm-content')?.textContent.includes(expected),
      text,
      { timeout: 15_000 },
    );
  } catch (error) {
    throw new Error(`${error.message}\nVisible UI:\n${await page.locator('body').innerText()}`);
  }
}

export async function runUiLifecycle() {
  const ownedRoot = mkdtempSync(join(tmpdir(), 'superwagie-ui-lifecycle-'));
  const projectRoot = join(ownedRoot, 'project');
  const stateRoot = join(ownedRoot, 'state');
  const profileRoot = join(ownedRoot, 'profile');
  mkdirSync(projectRoot);
  mkdirSync(stateRoot);
  mkdirSync(profileRoot);
  cpSync(join(repoRoot, 'fixtures', 'local-mac-workspace', 'documents'), projectRoot, { recursive: true });
  let documentPath = join(projectRoot, '正文.md');
  const original = readFileSync(documentPath, 'utf8');
  const outputRoot = join(process.env.SUPERWAGIE_REGRESSION_OUTPUT_ROOT || join(appRoot, 'test-results'), 'local-mac-workspace-markdown');
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const environment = {
    SUPERWAGIE_TEST_MODE: '1',
    SUPERWAGIE_TEST_PROJECT: projectRoot,
    SUPERWAGIE_TEST_STATE: stateRoot,
    SUPERWAGIE_TEST_PROFILE: profileRoot,
    SUPERWAGIE_TEST_SAVE_DELAY_MS: '900',
  };
  const checks = {};
  const metrics = {};
  const screenshots = [];
  let application;
  let page;
  const startedAt = performance.now();
  try {
    ({ application, page } = await launchDesktop(environment));
    metrics.cold_start_to_ready_ms = Math.round(performance.now() - startedAt);
    const authorizationStarted = performance.now();
    await page.getByRole('button', { name: '选择 Project…' }).click();
    await page.waitForSelector('.cm-content', { timeout: 15_000 });
    await waitForEditorText(page, '当前 MacBook 验证');
    metrics.authorization_to_document_ms = Math.round(performance.now() - authorizationStarted);
    checks.authorized_project_opened = await page.getByText('正文.md', { exact: true }).first().isVisible();
    assert.equal(checks.authorized_project_opened, true);
    assert.match(await page.locator('.cm-content').innerText(), /当前 MacBook 验证/);

    const unicodeMarker = '\n\n本机输入：中文🙂';
    const inputStarted = performance.now();
    await appendInEditor(page, unicodeMarker);
    await waitForEditorText(page, unicodeMarker.trim());
    metrics.input_to_visible_ms = Math.round(performance.now() - inputStarted);
    const saveStarted = performance.now();
    await waitForSaved(page);
    metrics.autosave_commit_ms = Math.round(performance.now() - saveStarted);
    checks.unicode_autosave_bytes = readFileSync(documentPath, 'utf8').endsWith(unicodeMarker);
    assert.equal(checks.unicode_autosave_bytes, true);

    for (const mode of ['源码', '阅读', '实时预览']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      const expected = { 源码: 'source', 阅读: 'reading', 实时预览: 'live' }[mode];
      assert.equal(await page.locator('.editor-stage').getAttribute('data-mode'), expected);
    }
    await page.getByRole('button', { name: '阅读', exact: true }).click();
    checks.three_markdown_modes = true;
    checks.active_html_inert = await page.locator('.editor-preview img').count() === 0
      && (await page.locator('.editor-preview').innerText()).includes('<img');
    assert.equal(checks.active_html_inert, true);
    await page.getByRole('button', { name: '实时预览', exact: true }).click();

    for (const viewport of [
      { width: 960, height: 680, zoom: 1 },
      { width: 1280, height: 720, zoom: 1 },
      { width: 1440, height: 900, zoom: 1.25 },
      { width: 1920, height: 1080, zoom: 1.5 },
    ]) {
      await application.evaluate(({ BrowserWindow }, value) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(value.width, value.height);
        window.webContents.setZoomFactor(value.zoom);
      }, viewport);
      const filename = `workspace-${viewport.width}x${viewport.height}-${Math.round(viewport.zoom * 100)}.png`;
      const path = join(outputRoot, filename);
      await page.screenshot({ path });
      screenshots.push(path);
    }
    metrics.main_rss_mb = Math.round(
      Number(execFileSync('ps', ['-o', 'rss=', '-p', String(application.process().pid)], { encoding: 'utf8' }).trim()) / 1024,
    );

    await application.close();
    application = undefined;
    ({ application, page } = await launchDesktop(environment));
    await page.waitForSelector('.cm-content', { timeout: 15_000 });
    await waitForEditorText(page, '当前 MacBook 验证');
    checks.close_reopen_restores_project_and_document = (await page.locator('.cm-content').innerText()).includes('本机输入：中文🙂');
    assert.equal(checks.close_reopen_restores_project_and_document, true);

    const localConflict = '\n本地冲突版本';
    await appendInEditor(page, localConflict);
    writeFileSync(documentPath, `${original}\n磁盘外部版本`);
    await page.waitForFunction(() => document.querySelector('#save-status')?.dataset.status === 'conflict', null, { timeout: 15_000 });
    checks.external_edit_preserved_before_resolution = readFileSync(documentPath, 'utf8').endsWith('磁盘外部版本');
    assert.equal(checks.external_edit_preserved_before_resolution, true);
    await page.getByRole('button', { name: '使用磁盘版本' }).click();
    await waitForSaved(page);
    checks.use_disk_resolution = (await page.locator('.cm-content').innerText()).includes('磁盘外部版本');
    assert.equal(checks.use_disk_resolution, true);

    const keepMarker = '\n保留当前版本标记';
    await appendInEditor(page, keepMarker);
    writeFileSync(documentPath, `${original}\n第二次磁盘变化`);
    await page.waitForFunction(() => document.querySelector('#save-status')?.dataset.status === 'conflict', null, { timeout: 15_000 });
    await page.getByRole('button', { name: '保留当前版本' }).click();
    await waitForSaved(page);
    checks.keep_current_resolution = readFileSync(documentPath, 'utf8').includes('保留当前版本标记');
    assert.equal(checks.keep_current_resolution, true);

    const mergeMarker = '\n本地待合并标记';
    await appendInEditor(page, mergeMarker);
    writeFileSync(documentPath, `${original}\n第三次磁盘变化`);
    await page.waitForFunction(() => document.querySelector('#save-status')?.dataset.status === 'conflict', null, { timeout: 15_000 });
    await page.getByRole('button', { name: '合并两份内容' }).click();
    await waitForSaved(page);
    const merged = readFileSync(documentPath, 'utf8');
    checks.merge_resolution_preserves_both = merged.includes('第三次磁盘变化')
      && merged.includes('本地待合并标记')
      && merged.includes('SuperWagie 合并分隔');
    assert.equal(checks.merge_resolution_preserves_both, true);

    const documentIdBeforeRename = (await page.locator('#document-meta').innerText())
      .match(/document:[a-f0-9]+/)?.[0];
    const renamedPath = join(projectRoot, '外部改名.md');
    renameSync(documentPath, renamedPath);
    documentPath = renamedPath;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.getByRole('button', { name: '刷新文件列表' }).click();
      await page.waitForTimeout(300);
      if (await page.getByText('外部改名.md', { exact: true }).count()) break;
    }
    if (!(await page.getByText('外部改名.md', { exact: true }).count())) {
      throw new Error(`renamed file missing from UI\n${await page.locator('body').innerText()}`);
    }
    await page.getByText('外部改名.md', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#document-meta')?.textContent.includes('外部改名.md'), null, { timeout: 10_000 });
    const documentIdAfterRename = (await page.locator('#document-meta').innerText())
      .match(/document:[a-f0-9]+/)?.[0];
    checks.external_rename_keeps_document_identity = documentIdBeforeRename === documentIdAfterRename
      && !existsSync(join(projectRoot, '正文.md'));
    assert.equal(checks.external_rename_keeps_document_identity, true);

    const crashMarker = '\nCore 崩溃恢复标记🙂';
    await appendInEditor(page, crashMarker);
    await page.waitForFunction(() => document.querySelector('#save-status')?.dataset.status === 'saving', null, { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await application.evaluate(() => {
      globalThis.__superwagieTestDesktop.core.client.child.kill('SIGKILL');
    });
    await page.waitForFunction((marker) => document.querySelector('.cm-content')?.textContent.includes(marker), crashMarker.trim(), { timeout: 20_000 });
    await waitForSaved(page);
    checks.core_crash_recovers_durable_draft = readFileSync(documentPath, 'utf8').includes('Core 崩溃恢复标记🙂');
    assert.equal(checks.core_crash_recovers_durable_draft, true);

    await page.getByRole('button', { name: '撤销此 Project 授权' }).click();
    await page.getByRole('button', { name: '选择 Project…' }).waitFor({ timeout: 10_000 });
    checks.revoke_returns_to_project_entry = true;

    const result = {
      regression_run_id: process.env.SUPERWAGIE_REGRESSION_RUN_ID || null,
      schema_version: 1,
      scope: 'local-mac-workspace-markdown',
      platform: platformFacts(),
      candidate_sha256: createHash('sha256').update(readFileSync(coreBinary)).digest('hex'),
      metrics,
      checks,
      screenshots,
      limitations: [
        'Keyboard automation covers Chinese and emoji bytes but is not native IME composition evidence.',
        'Obsidian round-trip and macOS 15 remain outside this current-machine slice.',
        'Tasks, drawing, Agent, Viewer, accounts, real services, release, and payment are not included.',
        'Zoom 125% and 150% uses Electron webContents zoom on this current Mac.',
      ],
      admission_effect: 'none',
    };
    writeFileSync(join(outputRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    if (application) await application.close().catch(() => {});
    rmSync(ownedRoot, { recursive: true, force: true });
  }
}
