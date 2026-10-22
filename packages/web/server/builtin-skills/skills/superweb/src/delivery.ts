import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type { SuperwebState } from './schema.js';
import { ACCEPTANCE_DIR, DELIVERY_DIR, PREVIEW_DIR } from './state.js';

export interface DeliveryIssue {
  file: string;
  message: string;
  ref?: string;
}

export interface DeliveryResult {
  deliveryDir: string;
  archived?: string;
  fileCount: number;
  issueCount: number;
}

export class DeliveryError extends Error {
  readonly issues: DeliveryIssue[];

  constructor(message: string, issues: DeliveryIssue[] = []) {
    super(message);
    this.name = 'DeliveryError';
    this.issues = issues;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const ASSET_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg']);

function isExternalAsset(ref: string): boolean {
  return /^(?:https?:)?\/\//i.test(ref);
}

function isAbsoluteAsset(ref: string): boolean {
  return ref.startsWith('/') || /^file:/i.test(ref) || /^[a-zA-Z]:[\\/]/.test(ref);
}

function isIgnoredRef(ref: string): boolean {
  return (
    ref === '' ||
    ref.startsWith('#') ||
    /^(?:data:|blob:|mailto:|tel:|javascript:)/i.test(ref)
  );
}

function collectHtmlRefs(html: string): string[] {
  const refs: string[] = [];
  const tagPattern = /<(img|script|source|video|audio|iframe|link)\b[^>]*>/gi;
  const attributePattern = /\b(src|href|poster|srcset|data-src)\s*=\s*["']([^"']+)["']/gi;

  for (const tagMatch of html.matchAll(tagPattern)) {
    const tag = tagMatch[0];
    const name = tagMatch[1]?.toLowerCase();
    const isStylesheetTag = name === 'link' && /\brel\s*=\s*["'][^"']*(?:stylesheet|icon|preload|modulepreload)[^"']*["']/i.test(tag);
    if (name === 'link' && !isStylesheetTag) continue;

    for (const attrMatch of tag.matchAll(attributePattern)) {
      const attr = attrMatch[1]?.toLowerCase();
      const value = attrMatch[2] ?? '';
      if (attr === 'srcset') {
        for (const candidate of value.split(',')) {
          const url = candidate.trim().split(/\s+/)[0];
          if (url) refs.push(url);
        }
      } else {
        refs.push(value);
      }
    }
  }
  return refs;
}

function collectCssUrls(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    const value = match[2]?.trim();
    if (value) refs.push(value);
  }
  for (const match of text.matchAll(/@import\s+(?:url\()?\s*(['"])([^'"]+)\1\s*\)?/gi)) {
    const value = match[2]?.trim();
    if (value) refs.push(value);
  }
  return refs;
}

async function checkRefs(file: string, refs: string[], root: string, issues: DeliveryIssue[], seen: Set<string>): Promise<void> {
  for (const raw of refs) {
    const ref = raw.trim();
    if (isIgnoredRef(ref)) continue;
    const key = `${file}|${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const relative = file.slice(root.length).replace(/^[/\\]/, '');

    if (isExternalAsset(ref)) {
      issues.push({
        file: relative,
        ref,
        message: `远程资源必须改成本地文件，交付目录才能离线打开：${ref}`,
      });
      continue;
    }
    if (isAbsoluteAsset(ref)) {
      issues.push({
        file: relative,
        ref,
        message: `绝对路径在双击打开时不可用，请改成相对路径：${ref}`,
      });
      continue;
    }

    const cleaned = decodeURIComponent(ref.split('?')[0]!.split('#')[0]!);
    const target = resolve(file, '..', cleaned);
    if (!(await pathExists(target))) {
      issues.push({
        file: relative,
        ref,
        message: `引用的本地文件不存在：${ref}`,
      });
    }
  }
}

export async function checkSelfContained(rootDir: string): Promise<DeliveryIssue[]> {
  const root = resolve(rootDir);
  const files = await walkFiles(root);
  const issues: DeliveryIssue[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const extension = extname(file).toLowerCase();
    if (!ASSET_EXTENSIONS.has(extension)) continue;
    if (extension === '.json') continue;

    const text = await readFile(file, 'utf8');
    const refs: string[] = [];
    if (extension === '.html' || extension === '.htm') {
      refs.push(...collectHtmlRefs(text));
      refs.push(...collectCssUrls(text));
    } else if (extension === '.css') {
      refs.push(...collectCssUrls(text));
    } else {
      // JS, SVG and other text assets can still reference local media.
      refs.push(...collectCssUrls(text));
      const assetPattern = /["']((?:\.{0,2}\/|\/)[^"'\n]+\.(?:png|jpe?g|gif|webp|avif|svg|css|js|woff2?|ttf|otf|mp4|webm))["']/gi;
      for (const match of text.matchAll(assetPattern)) {
        if (match[1]) refs.push(match[1]);
      }
    }
    await checkRefs(file, refs, root, issues, seen);
  }

  return issues;
}

function renderReadme(state: SuperwebState, report: { passed?: boolean; issues?: Array<{ viewport?: string; check?: string; message?: string }> } | null): string {
  const acceptance = state.acceptance;
  const issues = report?.issues ?? [];
  const browserNote = !acceptance.browserAvailable
    ? '未完成浏览器验收'
    : acceptance.passed
      ? '通过（桌面 1440、平板 768、手机 390）'
      : '未通过，用户已明确接受问题';
  const lines = [
    '# 交付说明',
    '',
    `- 任务：\`${state.taskId}\``,
    `- 路线：${state.route === 'page' ? 'page（浏览型页面）' : 'app（工作型界面）'}`,
    `- 已选方向：${state.selectedDirectionId ?? '(未选择)'}`,
    `- 交付 revision：${state.stageRevision}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## 验收',
    '',
    `- 状态：${browserNote}`,
    acceptance.reportPath ? `- 报告：${acceptance.reportPath}` : '- 报告：无',
    `- 问题数：${issues.length}`,
    '',
  ];

  if (!acceptance.browserAvailable) {
    lines.push('> 注意：未完成浏览器验收。页面未在真实 Chrome 中检查，横向溢出、坏图片和键盘可用性可能仍存在问题。', '');
  } else if (!acceptance.passed) {
    lines.push('> 注意：浏览器验收未通过，以下问题是在用户明确知情后接受的。', '');
  }

  if (issues.length > 0) {
    lines.push('## 已记录的验收问题', '');
    for (const issue of issues) {
      lines.push(`- [${issue.viewport ?? '-'} / ${issue.check ?? '-'}] ${issue.message ?? ''}`);
    }
    lines.push('');
  }

  lines.push(
    '## 文件',
    '',
    '- `index.html`：双击即可打开，无需安装依赖或启动服务器。',
    '- `assets/`：页面使用的本地图片、字体和脚本。',
    '- `验收/`：浏览器截图与 `report.json`。',
    '- `说明.md`：本文件。',
    '',
    '## 说明',
    '',
    '素材均为本地文件或明确标记的占位符。修改页面时保留 `assets/` 的相对路径，不要把文件移出交付目录。',
    '',
  );

  return lines.join('\n');
}

async function countFiles(root: string): Promise<number> {
  return (await walkFiles(root)).length;
}

async function archiveExistingDelivery(taskDir: string): Promise<string | undefined> {
  const current = join(taskDir, DELIVERY_DIR);
  if (!(await pathExists(current))) return undefined;
  let index = 1;
  while (await pathExists(join(taskDir, `${DELIVERY_DIR}-v${index}`))) index += 1;
  const archived = `${DELIVERY_DIR}-v${index}`;
  await rename(current, join(taskDir, archived));
  return archived;
}

export async function deliverTask(options: {
  taskDir: string;
  state: SuperwebState;
}): Promise<DeliveryResult> {
  const { taskDir, state } = options;
  if (state.stage !== 'delivered') {
    throw new DeliveryError(
      `当前阶段是 ${state.stage}，只有 delivered 阶段可以生成交付目录。先完成浏览器验收并接受。`,
    );
  }
  const accepted = state.decisions.some((decision) => decision.gate === 'acceptance' && decision.choice === 'accept');
  if (!accepted) {
    throw new DeliveryError('缺少验收接受决定，不能交付。先运行 decide --gate acceptance --choice accept。');
  }

  const previewDir = join(taskDir, PREVIEW_DIR);
  const previewFile = join(previewDir, 'index.html');
  if (!(await pathExists(previewFile))) {
    throw new DeliveryError('找不到 预览/index.html，无法交付。');
  }

  const issues = await checkSelfContained(previewDir);
  if (issues.length > 0) {
    throw new DeliveryError(
      `交付前自包含检查未通过（${issues.length} 项）。修复后重新运行 deliver；旧交付未被覆盖。`,
      issues,
    );
  }

  const reportPath = join(taskDir, ACCEPTANCE_DIR, 'report.json');
  let report: { passed?: boolean; issues?: Array<{ viewport?: string; check?: string; message?: string }> } | null = null;
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch {
    report = null;
  }

  await mkdir(join(taskDir, ACCEPTANCE_DIR), { recursive: true });
  const temp = join(taskDir, `.superweb-delivery-tmp-${process.pid}-${Date.now()}`);
  try {
    await cp(previewDir, temp, {
      recursive: true,
      filter: (source) => basename(source) !== 'v0.html',
    });
    const acceptanceSource = join(taskDir, ACCEPTANCE_DIR);
    if (await pathExists(acceptanceSource)) {
      await cp(acceptanceSource, join(temp, ACCEPTANCE_DIR), { recursive: true });
    }
    await writeFile(join(temp, '说明.md'), renderReadme(state, report), 'utf8');

    const fileCount = await countFiles(temp);
    const archived = await archiveExistingDelivery(taskDir);
    await rename(temp, join(taskDir, DELIVERY_DIR));
    return {
      deliveryDir: DELIVERY_DIR,
      ...(archived ? { archived } : {}),
      fileCount,
      issueCount: report?.issues?.length ?? 0,
    };
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
