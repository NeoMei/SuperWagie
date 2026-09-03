import test from 'node:test';
import assert from 'node:assert/strict';
import { auditViewerAuthorityManifest, auditViewerAuthorityText } from './viewer-authority-audit.mjs';

test('accepts the new current Viewer authority', () => {
  const result = auditViewerAuthorityText({
    path: 'docs/current.md',
    historical: false,
    text: 'Universal Viewer is built in. WPS is optional final-delivery smoke only.'
  });
  assert.deepEqual(result.errors, []);
});

test('rejects a current WPS-authoritative Viewer claim', () => {
  const result = auditViewerAuthorityText({
    path: 'docs/current.md',
    historical: false,
    text: 'Office Review 视觉事实仍由真实 WPS/Office 渲染提供。'
  });
  assert.match(result.errors.join('\n'), /WPS_AUTHORITATIVE_VIEWER_CONFLICT/);
});

test('accepts the same sentence only in a marked historical file', () => {
  const result = auditViewerAuthorityText({
    path: 'docs/history.md',
    historical: true,
    text: '> superseded-for-current-architecture: Universal Viewer design §14.4\nOffice Review 视觉事实仍由真实 WPS/Office 渲染提供。'
  });
  assert.deepEqual(result.errors, []);
});

test('rejects every retired Viewer dependency claim in current authority', () => {
  const claims = [
    ['WPS_VIEWER_FALLBACK_CONFLICT', '并排 WPS Review fallback'],
    ['WPS_RENDER_PREVIEW_CONFLICT', 'wps.render_preview'],
    ['WPSCOMPOSER_VIEWER_RENDER_CONFLICT', 'WPSComposer 生成 Viewer 页面底图'],
    ['LIBREOFFICE_VIEWER_CONFLICT', 'LibreOffice 作为 Viewer fallback 打开文件']
  ];
  for (const [code, text] of claims) {
    const result = auditViewerAuthorityText({ path: 'docs/current.md', historical: false, text });
    assert.match(result.errors.join('\n'), new RegExp(code));
  }
});

test('rejects retired WPS Viewer semantics in every reviewed word order', () => {
  const claims = [
    'WPS 是首选的版式渲染器，SuperWagie 负责 Review 交互层。',
    'Office 文件由 WPS 对受控副本进行高保真渲染。',
    '中心显示真实 WPS / Office 渲染结果。',
    '| DOC-04 | WPS 渲染 Review 工作区 | 受控副本与分页渲染 |',
    '| DOC-06 | ReviewShell | PDF.js、docx-preview、WPS authoritative renderer |'
  ];
  for (const text of claims) {
    const result = auditViewerAuthorityText({ path: 'docs/current.md', historical: false, text });
    assert.match(result.errors.join('\n'), /WPS_(?:PREFERRED|CONTROLLED_COPY|VIEWER_SURFACE|REVIEW_MATRIX)_CONFLICT/u, text);
  }
});

test('current authority manifest contains no retired WPS Viewer semantics', () => {
  assert.deepEqual(auditViewerAuthorityManifest().errors, []);
});
