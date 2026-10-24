#!/usr/bin/env node
// SuperWagie site builder: plain Node, no dependencies.
// Reads hand-written page fragments from src/pages/<lang>/<file>.html,
// wraps them in the shared chrome, and writes dist/ for a static server.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const SITE = 'https://www.superwagie.com';

let CSS_VERSION = '';
let JS_VERSION = '';

const LANGS = {
  zh: {
    htmlLang: 'zh-CN',
    switchLabel: 'EN',
    switchHref: 'en',
    brandNote: '办公室的 AI 工作台',
    nav: [
      ['workbench', '工作台', '/workbench/'],
      ['library', '资料库', '/library/'],
      ['creation', '创作', '/creation/'],
      ['docs', '文档', '/docs/'],
    ],
    download: ['下载', '/download/'],
    footerDesc: '犇马 SuperWagie · 办公室的 AI 工作台',
    footerLinks: [
      ['产品', '/'],
      ['文档', '/docs/'],
      ['常见问题', '/faq/'],
      ['更新日志', 'https://github.com/NeoMei/SuperWagie-Open/releases'],
      ['问题反馈', 'https://github.com/NeoMei/SuperWagie-Open/issues'],
      ['隐私', '/privacy/'],
      ['图片版权', '/credits/'],
    ],
    footerMeta: '2026 · 数据留在本机',
    docsTitle: '文档',
    docsIntro: '从安装到日常使用。',
    docsLinks: [
      ['getting-started', '快速上手'],
      ['models', '模型与 Key'],
      ['workbench', '工作台'],
      ['library', '资料库'],
      ['creation', '创作'],
      ['troubleshooting', '常见故障'],
    ],
    docsHome: '文档首页',
    docsBack: '返回网站',
    prev: '上一篇',
    next: '下一篇',
    ctaTitle: '明天的工作台，<br>已经开着。',
    ctaText: '装上犇马，把明天第一件要做的事写进去。',
    ctaButton: '下载犇马',
    ctaNote: 'macOS / Windows x64 · 2.7.5 · 安装后填自己的模型 Key',
  },
  en: {
    htmlLang: 'en',
    switchLabel: '中文',
    switchHref: '',
    brandNote: 'The AI workbench for office work',
    nav: [
      ['workbench', 'Workbench', '/en/workbench/'],
      ['library', 'Library', '/en/library/'],
      ['creation', 'Create', '/en/creation/'],
      ['docs', 'Docs', '/en/docs/'],
    ],
    download: ['Download', '/en/download/'],
    footerDesc: 'SuperWagie · the AI workbench for office work',
    footerLinks: [
      ['Product', '/en/'],
      ['Docs', '/en/docs/'],
      ['FAQ', '/en/faq/'],
      ['Changelog', 'https://github.com/NeoMei/SuperWagie-Open/releases'],
      ['Feedback', 'https://github.com/NeoMei/SuperWagie-Open/issues'],
      ['Privacy', '/en/privacy/'],
      ['Photo credits', '/en/credits/'],
    ],
    footerMeta: '2026 · your data stays on your Mac',
    docsTitle: 'Documentation',
    docsIntro: 'From installing to using it every day.',
    docsLinks: [
      ['getting-started', 'Getting started'],
      ['models', 'Models & keys'],
      ['workbench', 'Workbench'],
      ['library', 'Library'],
      ['creation', 'Create'],
      ['troubleshooting', 'Troubleshooting'],
    ],
    docsHome: 'Documentation',
    docsBack: 'Back to site',
    prev: 'Previous',
    next: 'Next',
    ctaTitle: 'Tomorrow’s workbench<br>is already open.',
    ctaText: 'Install SuperWagie and write tomorrow’s first task.',
    ctaButton: 'Download',
    ctaNote: 'macOS / Windows x64 · 2.7.2 · bring your own model key',
  },
};

// slug, file, nav, title, description, docs group?
const PAGES = {
  zh: [
    ['', 'home', 'home', '犇马 SuperWagie · 办公室里的 AI 工作台', '任务、资料库、文档、PPT、视频和网页，都在一个桌面应用里做完。文件和模型 Key 留在你自己的电脑上。'],
    ['workbench', 'workbench', 'workbench', '工作台 · 犇马 SuperWagie', '打开就是今天要做的事：任务、日历、即时贴和最近成果，任务保存为普通 Markdown。'],
    ['library', 'library', 'library', '资料库 · 犇马 SuperWagie', '指向一个文件夹，犇马在原地索引里面的合同、汇报和资料。文件名和意思一起搜，Agent 只读引用。'],
    ['creation', 'creation', 'creation', '创作 · 犇马 SuperWagie', '一句话开始写文档、做 PPT、做视频、做网页；产出落在本机工作目录，随时打开接着改。'],
    ['download', 'download', 'download', '下载 · 犇马 SuperWagie', '下载 macOS 与 Windows x64 版犇马，安装后填自己的模型 Key。安装包不含任何 Key。'],
    ['faq', 'faq', 'faq', '常见问题 · 犇马 SuperWagie', '关于系统要求、模型 Key、资料库隐私、任务文件和开源协议的常见问题。'],
    ['about', 'about', 'about', '关于 · 犇马 SuperWagie', '犇马是什么，和 OpenChamber 的关系，以及 Apache-2.0 许可与第三方归属。'],
    ['privacy', 'privacy', 'privacy', '隐私 · 犇马 SuperWagie', '犇马把任务、资料库索引和模型 Key 留在你的电脑上；这里说明每一项数据在哪里。'],
    ['credits', 'credits', 'about', '图片版权 · 犇马 SuperWagie', '产品页使用的两张书桌照片的来源、作者与许可证。'],
    ['docs', 'docs', 'docs', '文档 · 犇马 SuperWagie', '安装、模型 Key、工作台、资料库、创作与常见故障。', 'docs'],
    ['docs/getting-started', 'docs-getting-started', 'docs', '快速上手 · 犇马 SuperWagie', '下载、安装、第一次打开、填模型 Key，然后写下第一件事。', 'docs'],
    ['docs/models', 'docs-models', 'docs', '模型与 Key · 犇马 SuperWagie', '模型服务、Key 存在哪里、如何更换，以及资料库的可选 DeepSeek Key。', 'docs'],
    ['docs/workbench', 'docs-workbench', 'docs', '工作台 · 犇马 SuperWagie', '任务、即时贴、日历和成果；任务文件在哪，怎么手改。', 'docs'],
    ['docs/library', 'docs-library', 'docs', '资料库 · 犇马 SuperWagie', '添加目录、索引规则、搜索、Wiki、图谱和删除。', 'docs'],
    ['docs/creation', 'docs-creation', 'docs', '创作 · 犇马 SuperWagie', '从一句话到文档、PPT、视频和网页，工作目录和技能怎么配合。', 'docs'],
    ['docs/troubleshooting', 'docs-troubleshooting', 'docs', '常见故障 · 犇马 SuperWagie', '打不开、索引失败、模型报错、资料库后端没起来时先看这里。', 'docs'],
  ],
  en: [
    ['', 'home', 'home', 'SuperWagie · the AI workbench for office work', 'Tasks, your library, documents, decks, videos and web pages in one desktop app. Your files and model keys stay on your Mac.'],
    ['workbench', 'workbench', 'workbench', 'Workbench · SuperWagie', 'Open the app and see today: tasks, calendar, sticky notes and recent work. Tasks are plain Markdown.'],
    ['library', 'library', 'library', 'Library · SuperWagie', 'Point SuperWagie at a folder. It indexes contracts, reports and references in place, searches names and meaning together, and lets the agent read without writing.'],
    ['creation', 'creation', 'creation', 'Create · SuperWagie', 'Start a document, deck, video or web page from one sentence. Output lands in a local work folder you can open and keep editing.'],
    ['download', 'download', 'download', 'Download · SuperWagie', 'Download SuperWagie for macOS and Windows x64. Bring your own model key; no keys ship in the installer.'],
    ['faq', 'faq', 'faq', 'FAQ · SuperWagie', 'System requirements, model keys, library privacy, task files and licensing.'],
    ['about', 'about', 'about', 'About · SuperWagie', 'What SuperWagie is, its relationship to OpenChamber, Apache-2.0 licensing and third-party credits.'],
    ['privacy', 'privacy', 'privacy', 'Privacy · SuperWagie', 'Tasks, the library index and model keys stay on your Mac. Where each piece of data lives.'],
    ['credits', 'credits', 'about', 'Photo credits · SuperWagie', 'The two desk photographs on the product pages: source, author and licence.'],
    ['docs', 'docs', 'docs', 'Documentation · SuperWagie', 'Install, model keys, workbench, library, creation and troubleshooting.', 'docs'],
    ['docs/getting-started', 'docs-getting-started', 'docs', 'Getting started · SuperWagie', 'Download, install, open it once, add a model key and write the first task.', 'docs'],
    ['docs/models', 'docs-models', 'docs', 'Models & keys · SuperWagie', 'Providers, where keys are stored, how to switch, and the optional DeepSeek key for the library.', 'docs'],
    ['docs/workbench', 'docs-workbench', 'docs', 'Workbench · SuperWagie', 'Tasks, sticky notes, calendar and deliverables; where task files live and how to edit them.', 'docs'],
    ['docs/library', 'docs-library', 'docs', 'Library · SuperWagie', 'Add folders, indexing rules, search, Wiki, graph and removal.', 'docs'],
    ['docs/creation', 'docs-creation', 'docs', 'Create · SuperWagie', 'From one sentence to a document, deck, video or web page; how work folders and skills fit together.', 'docs'],
    ['docs/troubleshooting', 'docs-troubleshooting', 'docs', 'Troubleshooting · SuperWagie', 'What to check when the app will not open, indexing fails, a model errors or the library backend is down.', 'docs'],
  ],
};

const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const hrefFor = (lang, slug) => {
  const prefix = lang === 'en' ? '/en' : '';
  return slug ? `${prefix}/${slug}/` : `${prefix}/`;
};

const navHtml = (lang, entry) => {
  const L = LANGS[lang];
  const current = entry[2];
  const links = L.nav.map(([key, label]) => (
    `<a href="${hrefFor(lang, key)}"${key === current ? ' aria-current="page"' : ''}>${label}</a>`
  )).join('');
  const [dlLabel] = L.download;
  const otherLang = lang === 'zh' ? 'en' : 'zh';
  const switchSlug = PAGES[otherLang].find(([, file]) => file === entry[1])?.[0] ?? '';
  return `<header class="nav">
  <div class="nav-inner">
    <a class="brand" href="${hrefFor(lang, '')}" aria-label="${lang === 'zh' ? '犇马 SuperWagie 首页' : 'SuperWagie home'}">
      <img src="/assets/brand-logo.png" alt="" width="26" height="26">
      <span>${lang === 'zh' ? '犇马' : 'SuperWagie'} <em>${lang === 'zh' ? 'SuperWagie' : ''}</em></span>
    </a>
    <nav class="nav-links" aria-label="${lang === 'zh' ? '页面导航' : 'Site navigation'}">${links}</nav>
    <div class="nav-right">
      <a class="nav-lang" href="${hrefFor(otherLang, switchSlug)}" hreflang="${otherLang === 'zh' ? 'zh-CN' : 'en'}">${L.switchLabel}</a>
      <a class="nav-action" href="${hrefFor(lang, 'download')}">${dlLabel}</a>
    </div>
  </div>
</header>`;
};

const footerHtml = (lang) => {
  const L = LANGS[lang];
  const links = L.footerLinks.map(([label, href]) => `<a href="${href}">${label}</a>`).join('');
  return `<footer class="footer">
  <div class="wrap footer-inner">
    <p class="footer-desc">${L.footerDesc}</p>
    <nav class="footer-links" aria-label="${lang === 'zh' ? '页脚' : 'Footer'}">${links}</nav>
    <p class="footer-meta">${L.footerMeta}</p>
  </div>
</footer>`;
};

const docsSide = (lang, slug) => {
  const L = LANGS[lang];
  const links = L.docsLinks.map(([key, label]) => (
    `<a href="${hrefFor(lang, `docs/${key}`)}"${slug === `docs/${key}` ? ' aria-current="page"' : ''}>${label}</a>`
  )).join('');
  return `<aside class="doc-side">
    <a class="doc-side-home" href="${hrefFor(lang, 'docs')}">${L.docsTitle}</a>
    <nav aria-label="${L.docsTitle}">${links}</nav>
    <a class="doc-side-back" href="${hrefFor(lang, '')}">← ${L.docsBack}</a>
  </aside>`;
};

const docsPager = (lang, slug) => {
  const L = LANGS[lang];
  const list = L.docsLinks;
  const index = list.findIndex(([key]) => slug === `docs/${key}`);
  if (index < 0) return '';
  const prev = list[index - 1];
  const next = list[index + 1];
  return `<nav class="doc-pager">
    ${prev ? `<a href="${hrefFor(lang, `docs/${prev[0]}`)}"><span>${L.prev}</span>${prev[1]}</a>` : '<span></span>'}
    ${next ? `<a href="${hrefFor(lang, `docs/${next[0]}`)}"><span>${L.next}</span>${next[1]}</a>` : '<span></span>'}
  </nav>`;
};

const ctaHtml = (lang) => {
  const L = LANGS[lang];
  const assets = lang === 'zh'
    ? { hi: '明天，从一件事开始。', input: '写下明天第一件要做的事…', chips: ['写文档', '做 PPT', '做网页'], foot: '任务保存为普通 Markdown · 仅本机' }
    : { hi: 'Tomorrow starts with one thing.', input: 'Write tomorrow’s first task…', chips: ['Document', 'Deck', 'Web page'], foot: 'Saved as plain Markdown · on this Mac' };
  return `<section class="cta">
  <div class="wrap cta-grid">
    <div class="cta-copy">
      <h2>${L.ctaTitle}</h2>
      <p>${L.ctaText}</p>
      <a class="btn inverse" href="${hrefFor(lang, 'download')}">${L.ctaButton}</a>
      <p class="cta-note">${L.ctaNote}</p>
    </div>
    <div class="cta-fragment" aria-hidden="true">
      <div class="ui-workbench is-small" data-ui>
        <div class="ui-greet">
          <p class="ui-hi">${assets.hi}</p>
          <p class="ui-clock"><time>09:00:00</time></p>
        </div>
        <div class="ui-composer">
          <span class="ui-input is-placeholder">${assets.input}</span>
          <div class="ui-chips">
            <span class="ui-btn ui-btn-start">${lang === 'zh' ? '开始' : 'Start'}</span>
            ${assets.chips.map((chip) => `<span class="ui-chip">${chip}</span>`).join('')}
          </div>
        </div>
        <p class="ui-foot">${assets.foot}</p>
      </div>
    </div>
  </div>
</section>`;
};

const page = async (lang, entry) => {
  const [slug, file, nav, title, description, group] = entry;
  let body = await fs.readFile(path.join(SRC, 'pages', lang, `${file}.html`), 'utf8');
  const isDoc = group === 'docs';
  const canonical = `${SITE}${hrefFor(lang, slug)}`;
  const otherLang = lang === 'zh' ? 'en' : 'zh';
  const otherEntry = PAGES[otherLang].find(([, otherFile]) => otherFile === file);
  const alternate = otherEntry ? `${SITE}${hrefFor(otherLang, otherEntry[0])}` : '';

  if (!isDoc) {
    body = body.replace('<!--CTA-->', ctaHtml(lang));
  }

  const main = isDoc
    ? `<main id="main" class="doc-main">
  <div class="wrap doc-layout">
    ${docsSide(lang, slug)}
    <article class="doc-body">
      <p class="doc-kicker">${LANGS[lang].docsTitle}</p>
      ${body}
      ${docsPager(lang, slug)}
    </article>
  </div>
</main>`
    : `<main id="main">${body}</main>`;

  const html = `<!doctype html>
<html lang="${LANGS[lang].htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${escapeAttr(description)}">
<meta name="theme-color" content="#f7f9fa">
<link rel="icon" href="/assets/brand-logo.png">
<link rel="canonical" href="${canonical}">
${alternate ? `<link rel="alternate" hreflang="${otherLang === 'zh' ? 'zh-CN' : 'en'}" href="${alternate}">` : ''}
<link rel="alternate" hreflang="${lang === 'zh' ? 'zh-CN' : 'en'}" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="SuperWagie">
<meta property="og:title" content="${escapeAttr(title)}">
<meta property="og:description" content="${escapeAttr(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE}/assets/og.png">
<meta property="og:locale" content="${lang === 'zh' ? 'zh_CN' : 'en_US'}">
<script>document.documentElement.classList.add('js');</script>
<link rel="stylesheet" href="/styles.css?v=${CSS_VERSION}">
</head>
<body>
<a class="skip" href="#main">${lang === 'zh' ? '跳到正文' : 'Skip to content'}</a>
${navHtml(lang, entry)}
${main}
${footerHtml(lang)}
<script src="/app.js?v=${JS_VERSION}"></script>
</body>
</html>`;

  const out = path.join(DIST, hrefFor(lang, slug).replace(/^\//, ''), 'index.html');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, html);
};

const run = async () => {
  const versionOf = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex').slice(0, 10);
  CSS_VERSION = await versionOf(path.join(SRC, 'site.css'));
  JS_VERSION = await versionOf(path.join(SRC, 'site.js'));
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });
  await fs.cp(path.join(SRC, 'assets'), path.join(DIST, 'assets'), { recursive: true });
  await fs.copyFile(path.join(SRC, 'site.css'), path.join(DIST, 'styles.css'));
  await fs.copyFile(path.join(SRC, 'site.js'), path.join(DIST, 'app.js'));

  for (const lang of ['zh', 'en']) {
    for (const entry of PAGES[lang]) await page(lang, entry);
  }

  const urls = [];
  for (const lang of ['zh', 'en']) {
    for (const entry of PAGES[lang]) {
      urls.push(`${SITE}${hrefFor(lang, entry[0])}`);
    }
  }
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${url}</loc></url>`).join('\n')}
</urlset>
`;
  const notFound = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>这一页不在了 · SuperWagie</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/assets/brand-logo.png">
<link rel="stylesheet" href="/styles.css?v=${CSS_VERSION}">
</head>
<body>
${navHtml('zh', ['', 'home', 'home', '', ''])}
<main id="main" class="section-tight"><div class="wrap prose">
<h1>这一页不在了</h1>
<p>地址可能写错了，或者页面已经搬走。回<a href="/">工作台首页</a>，或者看<a href="/docs/">文档</a>。</p>
<p><a href="/en/">English site</a></p>
</div></main>
${footerHtml('zh')}
</body></html>`;
  await fs.writeFile(path.join(DIST, '404.html'), notFound);

  await fs.writeFile(path.join(DIST, 'sitemap.xml'), sitemap);
  await fs.writeFile(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  console.log(`Built ${urls.length} pages into ${DIST}`);
};

await run();
