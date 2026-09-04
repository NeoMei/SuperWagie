#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export const FORBIDDEN_CURRENT_CLAIMS = Object.freeze([
  ['WPS_AUTHORITATIVE_VIEWER_CONFLICT', /(?:Office|WPS).{0,24}(?:视觉事实|authoritative).{0,24}(?:WPS|Office)/isu],
  ['WPS_VIEWER_FALLBACK_CONFLICT', /(?:并排|外部).{0,12}WPS.{0,24}(?:Review|预览|fallback)/isu],
  ['WPS_RENDER_PREVIEW_CONFLICT', /wps\.render_preview/u],
  ['WPSCOMPOSER_VIEWER_RENDER_CONFLICT', /WPSComposer.{0,24}(?:Viewer|预览|页面底图|convert_to_pdf)/isu],
  ['LIBREOFFICE_VIEWER_CONFLICT', /(?:LibreOffice|soffice).{0,24}(?:Viewer|fallback|预览|打开)/isu],
  ['WPS_PREFERRED_CONFLICT', /WPS.{0,16}(?:首选|精确).{0,20}(?:版式)?(?:渲染器|预览)/isu],
  ['WPS_CONTROLLED_COPY_CONFLICT', /Office 文件.{0,16}WPS.{0,24}(?:高保真)?渲染/isu],
  ['WPS_VIEWER_SURFACE_CONFLICT', /(?:中心(?:视图)?显示|央视图使用).{0,32}(?:WPS|Office).{0,20}渲染/isu],
  ['WPS_REVIEW_MATRIX_CONFLICT', /WPS.{0,12}(?:渲染 Review|authoritative renderer)/isu],
  ['WPS_VISUAL_TRUTH_CONFLICT', /WPS.{0,16}(?:视觉真值|真值)/isu],
]);

export const CURRENT_AUTHORITY_PATHS = Object.freeze([
  'docs/最早期产品方案-V0.1.md',
  'docs/superpowers/specs/2026-08-29-superwagie-v1-release-scope.md',
  'docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md',
  'docs/superpowers/specs/2026-08-28-superwagie-workspace-delivery-design.md',
  'docs/superpowers/specs/2026-08-29-superwagie-ui-implementation-contract.md',
  'docs/superpowers/specs/2026-09-01-superwagie-bundled-chromium-electron-architecture-design.md',
  'docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md',
  'rules/viewer-platform.md',
  'rules/deliverables.md',
  'rules/video.md',
  'rules/ui-shell.md',
  'rules/runtime-isolation.md',
  'rules/security-extensions.md',
  'rules/rust-packaging.md',
  'rules/quality-scope.md',
  'rules/README.md',
  'docs/技术可行性/技术要求矩阵.md',
  'docs/技术可行性/技术验证执行计划.md',
  'docs/技术可行性/01-桌面界面-Markdown-WebView-绘图.md',
  'docs/技术可行性/02-Agent运行时-沙箱-共享依赖-托管AI.md',
  'docs/技术可行性/05-内置能力逐项适配-PPT-Word-HTML-WPS.md',
  'docs/技术可行性/07-轻量视频制作内核-五场景.md',
  'docs/技术可行性/08-独立Office-Reviewer.md',
  'docs/技术可行性/技术验证外部条件清单.md',
  'docs/技术可行性/Windows11-x64-验证交接清单.md',
  'docs/技术可行性/README.md',
  'AGENTS.md',
  'docs/界面原型确认索引.md',
  'docs/contracts/v1/public-capability-facade.md'
]);

export const HISTORICAL_AUTHORITY_PATHS = Object.freeze([
  'docs/superpowers/plans/2026-08-30-independent-office-reviewer-poc.md',
  'docs/技术可行性/编码前技术验证收口报告-2026-09-01.md',
  'fixtures/gate-3/G3-REVIEW-001/README.md',
  'fixtures/gate-3/G3-REVIEW-002/README.md'
]);

export const lineSha256 = line => createHash('sha256').update(line, 'utf8').digest('hex');

// Exact-line exceptions exist only for explicit negative/prohibition statements.
// Each entry is consumed once; unmatched entries fail the audit as stale.
export const AUTHORITY_ALLOWLIST = Object.freeze([
  { path: 'docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md', line_sha256: '95369e299db16e29f6e4b762469eb4a6749d1fa35b8294c2c534b42b2f699ded', rule_id: 'LIBREOFFICE_VIEWER_CONFLICT', expires_on: '2027-09-04' },
  { path: 'docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md', line_sha256: '65212ce3bab9d8c5d931dd569b42617990c41fc814965f71966e51bd664873cb', rule_id: 'WPS_AUTHORITATIVE_VIEWER_CONFLICT', expires_on: '2027-09-04' },
  { path: 'docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md', line_sha256: '3cb41ffd23614c63adf3ede15007e54cacb933e4fdf9a06372c57fab4486c2d7', rule_id: 'LIBREOFFICE_VIEWER_CONFLICT', expires_on: '2027-09-04' },
  { path: 'docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md', line_sha256: 'ec175ceb44e02fd4e5ff933cf83549865be5738d37da5b13ec72686e75855942', rule_id: 'LIBREOFFICE_VIEWER_CONFLICT', expires_on: '2027-09-04' },
  { path: 'docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md', line_sha256: '5655f6b18074a22dafe6b2538fcdfd4531d5eb801b24888c6c406607f3491f1d', rule_id: 'WPSCOMPOSER_VIEWER_RENDER_CONFLICT', expires_on: '2027-09-04' },
  { path: 'docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md', line_sha256: '57a8b3c5fae1565666987087e33277d3f1ce79b130fff975eb6dcdfd3e06c4e8', rule_id: 'WPSCOMPOSER_VIEWER_RENDER_CONFLICT', expires_on: '2027-09-04' },
  { path: 'docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md', line_sha256: '40d0ab7dc405aa82d115c665959eda8f7c74318a72e891d6748b3dd2f41e6eba', rule_id: 'WPS_VIEWER_FALLBACK_CONFLICT', expires_on: '2027-09-04' },
  { path: 'docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md', line_sha256: '9dc09aaf1efa59345843c4595da48cfb4b2067aebff9b7ed1a2032971577bdce', rule_id: 'WPS_RENDER_PREVIEW_CONFLICT', expires_on: '2027-09-04' },
  { path: 'docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md', line_sha256: 'da190843e24da7f49c39363d3cfa9ebbc56c5136343a197a18a2d88bb513904b', rule_id: 'WPSCOMPOSER_VIEWER_RENDER_CONFLICT', expires_on: '2027-09-04' },
  { path: 'docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md', line_sha256: '3c12d81c88bfd0857d5552e9ff4374dfb9379f473439e8eea2548158c2bf204a', rule_id: 'LIBREOFFICE_VIEWER_CONFLICT', expires_on: '2027-09-04' },
  { path: 'docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md', line_sha256: '395956cf38770044daf4a524418fa92d89e90a902cb69b4e4bd2048b719fc2f5', rule_id: 'LIBREOFFICE_VIEWER_CONFLICT', expires_on: '2027-09-04' },
  { path: 'docs/contracts/v1/public-capability-facade.md', line_sha256: '1691e900356199445d9a67c4366bb90dd703d52f8d7351808139446481bd2a61', rule_id: 'WPS_RENDER_PREVIEW_CONFLICT', expires_on: '2027-09-04' },
]);

export function auditViewerAuthorityText({ path: filePath, historical, text, allowlist = [] }) {
  const errors = [];
  if (historical) {
    if (!text.includes('superseded-for-current-architecture')) {
      errors.push(`HISTORICAL_MARKER_MISSING ${filePath}`);
    }
    return { errors, matched_allowlist: [] };
  }
  const matched = new Set();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    for (const [ruleId, pattern] of FORBIDDEN_CURRENT_CLAIMS) {
      pattern.lastIndex = 0;
      if (!pattern.test(line)) continue;
      const digest = lineSha256(line);
      const allowed = allowlist.find(entry => entry.path === filePath
        && entry.line_sha256 === digest && entry.rule_id === ruleId
        && Date.parse(`${entry.expires_on}T23:59:59Z`) >= Date.now());
      if (allowed) matched.add(allowed);
      else errors.push(`${ruleId} ${filePath}:${index + 1}`);
    }
  }
  return { errors, matched_allowlist: [...matched] };
}

export function auditViewerAuthorityManifest({ root = repoRoot, allowlist = AUTHORITY_ALLOWLIST } = {}) {
  const errors = [];
  const matched = new Set();
  for (const filePath of CURRENT_AUTHORITY_PATHS) {
    const absolute = path.join(root, filePath);
    if (!fs.existsSync(absolute)) { errors.push(`CURRENT_AUTHORITY_FILE_MISSING ${filePath}`); continue; }
    const result = auditViewerAuthorityText({ path: filePath, historical: false, text: fs.readFileSync(absolute, 'utf8'), allowlist });
    errors.push(...result.errors);
    result.matched_allowlist.forEach(entry => matched.add(entry));
  }
  for (const filePath of HISTORICAL_AUTHORITY_PATHS) {
    const absolute = path.join(root, filePath);
    if (!fs.existsSync(absolute)) { errors.push(`HISTORICAL_AUTHORITY_FILE_MISSING ${filePath}`); continue; }
    errors.push(...auditViewerAuthorityText({ path: filePath, historical: true, text: fs.readFileSync(absolute, 'utf8') }).errors);
  }
  for (const entry of allowlist) {
    if (!matched.has(entry)) errors.push(`STALE_OR_MISMATCHED_ALLOWLIST ${entry.rule_id} ${entry.path} ${entry.line_sha256}`);
  }
  return { errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditViewerAuthorityManifest();
  if (result.errors.length) {
    result.errors.forEach(error => console.error(`FAIL ${error}`));
    process.exit(1);
  }
  console.log(`PASS viewer authority current=${CURRENT_AUTHORITY_PATHS.length} historical=${HISTORICAL_AUTHORITY_PATHS.length}`);
}
