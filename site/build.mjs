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
const SITE_VERSION = '2.7.25';
const REPO_URL = 'https://github.com/NeoMei/SuperWagie-Open';
const DOWNLOAD_URLS = {
  mac: `/downloads/SuperWagie-${SITE_VERSION}-mac-arm64.dmg`,
  windowsX64: `/downloads/SuperWagie-${SITE_VERSION}-win-x64.exe`,
};

let CSS_VERSION = '';
let JS_VERSION = '';
let DOWNLOAD_PLATFORM_VERSION = '';

const LANGS = {
  zh: {
    htmlLang: 'zh-CN',
    switchLabel: 'EN',
    switchHref: 'en',
    brandNote: '办公室的 AI 工作台',
    nav: [
      ['home', '首页', '/'],
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
      ['GitHub 源码', REPO_URL],
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
    ctaNote: `macOS / Windows x64 · ${SITE_VERSION} · 安装后填自己的模型 Key`,
  },
  en: {
    htmlLang: 'en',
    switchLabel: '中文',
    switchHref: '',
    brandNote: 'The AI workbench for office work',
    nav: [
      ['home', 'Home', '/en/'],
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
      ['GitHub source', REPO_URL],
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
    ctaNote: `macOS / Windows x64 · ${SITE_VERSION} · bring your own model key`,
  },
};

// slug, file, nav, title, description, docs group?
const PAGES = {
  zh: [
    ['', 'home', 'home', '犇马 SuperWagie · 本地 AI 办公与编程智能体', '办公任务、资料库、文档、PPT、网页，加上读代码、跑命令、改文件和跑测试，都在一个桌面应用里完成。文件和模型 Key 留在自己的电脑上，macOS 与 Windows x64 均可下载。'],
    ['workbench', 'workbench', 'workbench', 'AI 工作台：任务、日历与成果 · 犇马 SuperWagie', '打开就是今天：到期任务、日历、即时贴和最近成果。任务保存为普通 Markdown，随时用编辑器接手。'],
    ['library', 'library', 'library', '本地资料库：文件夹索引与语义检索 · 犇马 SuperWagie', '指向一个文件夹，犇马在原地索引合同、汇报和资料。文件名和意思一起搜，Agent 只读引用，不上传文件。'],
    ['creation', 'creation', 'creation', 'AI 创作：文档、PPT、视频与网页 · 犇马 SuperWagie', '一句话开始写文档、做 PPT、做视频、做网页；产出落在本机工作目录，随时打开接着改。'],
    ['download', 'download', 'download', '下载犇马 SuperWagie · macOS 与 Windows x64 安装包', '直接下载 macOS（Apple 芯片）与 Windows x64 安装包，安装后填自己的模型 Key。安装包不含任何 Key，数据留在本机。'],
    ['faq', 'faq', 'faq', '常见问题：安装、模型 Key 与隐私 · 犇马 SuperWagie', '系统要求、模型 Key 放哪、资料库是否上传、任务文件在哪、许可与收费方式，集中回答。'],
    ['about', 'about', 'about', '关于犇马 SuperWagie · 办公室里的 AI 工作台', '犇马是什么、它解决哪些办公问题，以及第三方组件与致谢。'],
    ['privacy', 'privacy', 'privacy', '隐私说明：数据留在本机 · 犇马 SuperWagie', '任务、资料库索引和模型 Key 都在自己的电脑上；这里逐项说明数据存在哪里、什么会离开本机。'],
    ['credits', 'credits', 'about', '图片版权 · 犇马 SuperWagie', '产品页使用的两张书桌照片的来源、作者与许可证。'],
    ['docs', 'docs', 'docs', '使用文档：安装、模型、资料库与创作 · 犇马 SuperWagie', '从下载安装到日常使用：模型 Key、工作台、资料库、创作流程和常见故障。', 'docs'],
    ['docs/getting-started', 'docs-getting-started', 'docs', '快速上手：下载安装与第一个任务 · 犇马 SuperWagie', '下载、安装、第一次打开、填模型 Key，然后写下第一件事；含 macOS 首次打开被拦截的处理。', 'docs'],
    ['docs/models', 'docs-models', 'docs', '模型与 Key：供应商配置与更换 · 犇马 SuperWagie', '添加模型供应商、Key 存在哪里、如何更换默认模型，以及资料库的可选 DeepSeek Key。', 'docs'],
    ['docs/workbench', 'docs-workbench', 'docs', '工作台文档：任务、即时贴与日历 · 犇马 SuperWagie', '任务、即时贴、日历和成果面板；任务文件在哪里、怎么手改、如何跨机器使用。', 'docs'],
    ['docs/library', 'docs-library', 'docs', '资料库文档：索引、检索与 Wiki · 犇马 SuperWagie', '添加目录、索引规则、文件与语义搜索、Wiki 合成、关系图谱，以及删除索引。', 'docs'],
    ['docs/creation', 'docs-creation', 'docs', '创作文档：文档、PPT、视频与网页 · 犇马 SuperWagie', '从一句话到文档、PPT、视频和网页：工作目录、素材和技能怎么配合。', 'docs'],
    ['docs/troubleshooting', 'docs-troubleshooting', 'docs', '常见故障：打不开、索引与模型报错 · 犇马 SuperWagie', '应用打不开、首次启动被拦截、索引失败、模型报错、资料库后端没起来时先看这里。', 'docs'],
  ],
  en: [
    ['', 'home', 'home', 'SuperWagie · the local AI agent for office work and code', 'Office tasks, a local library, documents, decks and web pages, plus reading code, running commands and tests, in one desktop app. Files and keys stay on your machine.'],
    ['workbench', 'workbench', 'workbench', 'AI workbench: tasks, calendar and deliverables · SuperWagie', 'Open the app and see today: due tasks, a calendar, sticky notes and recent output. Tasks are plain Markdown you can edit anywhere.'],
    ['library', 'library', 'library', 'Local library: folder indexing and semantic search · SuperWagie', 'Point SuperWagie at a folder. It indexes contracts, reports and references in place, searches names and meaning together, and lets the agent read without writing.'],
    ['creation', 'creation', 'creation', 'AI creation: documents, decks, video and web pages · SuperWagie', 'Start a document, deck, video or web page from one sentence. Output lands in a local work folder you can open and keep editing.'],
    ['download', 'download', 'download', 'Download SuperWagie for macOS and Windows x64', 'Download the macOS (Apple silicon) and Windows x64 installers directly. Bring your own model key; no keys ship in the installer and data stays on your machine.'],
    ['faq', 'faq', 'faq', 'FAQ: install, model keys and privacy · SuperWagie', 'System requirements, where model keys live, whether the library uploads files, task files, licensing and pricing.'],
    ['about', 'about', 'about', 'About SuperWagie · the AI workbench for office work', 'What SuperWagie is, the office work it covers, and the third-party components and credits.'],
    ['privacy', 'privacy', 'privacy', 'Privacy: your data stays on your machine · SuperWagie', 'Tasks, the library index and model keys stay on your computer. Where each piece of data lives and what leaves the machine.'],
    ['credits', 'credits', 'about', 'Photo credits · SuperWagie', 'The two desk photographs on the product pages: source, author and licence.'],
    ['docs', 'docs', 'docs', 'Documentation: install, models, library and creation · SuperWagie', 'From download to daily use: model keys, the workbench, the library, creation and troubleshooting.', 'docs'],
    ['docs/getting-started', 'docs-getting-started', 'docs', 'Getting started: install and your first task · SuperWagie', 'Download, install, open it once, add a model key and write the first task, including the first-launch prompt on macOS.', 'docs'],
    ['docs/models', 'docs-models', 'docs', 'Models and keys: providers and switching · SuperWagie', 'Add providers, where keys are stored, how to switch the default model, and the optional DeepSeek key for the library.', 'docs'],
    ['docs/workbench', 'docs-workbench', 'docs', 'Workbench: tasks, sticky notes and calendar · SuperWagie', 'Tasks, sticky notes, the calendar and deliverables; where task files live, how to edit them and use them across machines.', 'docs'],
    ['docs/library', 'docs-library', 'docs', 'Library: indexing, search and Wiki · SuperWagie', 'Add folders, indexing rules, file and semantic search, Wiki synthesis, the relation graph and removing an index.', 'docs'],
    ['docs/creation', 'docs-creation', 'docs', 'Creation: documents, decks, video and web pages · SuperWagie', 'From one sentence to a document, deck, video or web page, and how work folders and skills fit together.', 'docs'],
    ['docs/troubleshooting', 'docs-troubleshooting', 'docs', 'Troubleshooting: app, indexing and model errors · SuperWagie', 'What to check when the app will not open, the first launch is blocked, indexing fails, a model errors or the library backend is down.', 'docs'],
  ],
};

const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const stripTags = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const pageLabel = (lang, slug) => {
  const entry = PAGES[lang].find(([candidate]) => candidate === slug);
  if (!entry) return '';
  return entry[3].split(' · ')[0];
};

const faqPairs = (body) => {
  const pairs = [];
  const pattern = /<h3[^>]*>([\s\S]*?)<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/g;
  for (const match of body.matchAll(pattern)) {
    pairs.push({ question: stripTags(match[1]), answer: stripTags(match[2]) });
  }
  return pairs;
};

const breadcrumbData = (lang, slug, canonical) => {
  const home = lang === 'zh' ? '首页' : 'Home';
  const homeUrl = `${SITE}${hrefFor(lang, '')}`;
  const items = [{ name: home, url: homeUrl }];
  if (slug.startsWith('docs/')) items.push({ name: pageLabel(lang, 'docs'), url: `${SITE}${hrefFor(lang, 'docs')}` });
  if (slug) items.push({ name: pageLabel(lang, slug), url: canonical });
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
};

/**
 * One JSON-LD graph per page. Organization and WebSite describe the product
 * everywhere; the home page adds the downloadable application, the FAQ page
 * carries the question list, and documentation pages are articles.
 */
const structuredData = ({ lang, slug, canonical, title, description, body }) => {
  const inLanguage = lang === 'zh' ? 'zh-CN' : 'en';
  const organization = {
    '@type': 'Organization',
    '@id': `${SITE}/#organization`,
    name: 'SuperWagie',
    alternateName: '犇马',
    url: SITE,
    logo: { '@type': 'ImageObject', url: `${SITE}/assets/brand-logo.png` },
    sameAs: [REPO_URL],
  };
  const graph = [organization];

  if (!slug) {
    graph.push({
      '@type': 'WebSite',
      '@id': `${SITE}/#website`,
      url: SITE,
      name: '犇马 SuperWagie',
      alternateName: ['SuperWagie', '犇马'],
      inLanguage,
      publisher: { '@id': `${SITE}/#organization` },
    });
    graph.push({
      '@type': 'SoftwareApplication',
      name: 'SuperWagie',
      alternateName: '犇马',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'macOS (Apple silicon), Windows 10/11 x64',
      softwareVersion: SITE_VERSION,
      description,
      url: canonical,
      downloadUrl: `${SITE}${hrefFor(lang, 'download')}`,
      screenshot: `${SITE}/assets/og.png`,
      image: `${SITE}/assets/og.png`,
      inLanguage,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY', availability: 'https://schema.org/InStock' },
      publisher: { '@id': `${SITE}/#organization` },
    });
  }

  if (slug === 'faq') {
    const pairs = faqPairs(body);
    if (pairs.length > 0) {
      graph.push({
        '@type': 'FAQPage',
        mainEntity: pairs.map((pair) => ({
          '@type': 'Question',
          name: pair.question,
          acceptedAnswer: { '@type': 'Answer', text: pair.answer },
        })),
      });
    }
  }

  if (slug.startsWith('docs') && slug !== 'docs') {
    graph.push({
      '@type': 'TechArticle',
      headline: title,
      description,
      inLanguage,
      url: canonical,
      mainEntityOfPage: canonical,
      publisher: { '@id': `${SITE}/#organization` },
      isPartOf: { '@type': 'WebSite', '@id': `${SITE}/#website` },
    });
  }

  graph.push(breadcrumbData(lang, slug, canonical));
  return { '@context': 'https://schema.org', '@graph': graph };
};

const hrefFor = (lang, slug) => {
  const prefix = lang === 'en' ? '/en' : '';
  return slug ? `${prefix}/${slug}/` : `${prefix}/`;
};

const downloadLinkAttrs = (lang) => {
  const labels = lang === 'zh'
    ? { fallback: '下载犇马', mac: '下载 macOS 版', windows: '查看 Windows 下载', windowsX64: '下载 Windows x64 版' }
    : { fallback: 'Download', mac: 'Download for macOS', windows: 'View Windows download', windowsX64: 'Download for Windows x64' };
  return [
    'data-download-link',
    `data-fallback-url="${hrefFor(lang, 'download')}"`,
    `data-mac-url="${DOWNLOAD_URLS.mac}"`,
    `data-windows-url="${hrefFor(lang, 'download')}#windows"`,
    `data-windows-x64-url="${DOWNLOAD_URLS.windowsX64}"`,
    `data-fallback-label="${labels.fallback}"`,
    `data-mac-label="${labels.mac}"`,
    `data-windows-label="${labels.windows}"`,
    `data-windows-x64-label="${labels.windowsX64}"`,
  ].join(' ');
};

const navHtml = (lang, entry) => {
  const L = LANGS[lang];
  const current = entry[2];
  const links = L.nav.map(([key, label]) => {
    // The home entry points at the language root, not at /home/.
    const target = key === 'home' ? hrefFor(lang, '') : hrefFor(lang, key);
    return `<a href="${target}"${key === current ? ' aria-current="page"' : ''}>${label}</a>`;
  }).join('');
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
      <a class="nav-action" href="${hrefFor(lang, 'download')}" ${downloadLinkAttrs(lang)}>${dlLabel}</a>
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
      <a class="btn inverse" href="${hrefFor(lang, 'download')}" ${downloadLinkAttrs(lang)}>${L.ctaButton}</a>
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
  // x-default points at the Chinese page, the site's default language.
  const zhEntry = PAGES.zh.find(([, zhFile]) => zhFile === file);
  const defaultAlternate = zhEntry ? `${SITE}${hrefFor('zh', zhEntry[0])}` : '';
  const ogAlt = lang === 'zh'
    ? '犇马 SuperWagie：办公室里的 AI 工作台'
    : 'SuperWagie: the AI workbench for office work';
  const jsonLd = JSON.stringify(structuredData({ lang, slug, canonical, title, description, body }))
    .replace(/</g, '\\u003c');

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
<link rel="alternate" hreflang="x-default" href="${defaultAlternate || canonical}">
<meta property="og:type" content="${isDoc ? 'article' : 'website'}">
<meta property="og:site_name" content="犇马 SuperWagie">
<meta property="og:title" content="${escapeAttr(title)}">
<meta property="og:description" content="${escapeAttr(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE}/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeAttr(ogAlt)}">
<meta property="og:locale" content="${lang === 'zh' ? 'zh_CN' : 'en_US'}">
${alternate ? `<meta property="og:locale:alternate" content="${lang === 'zh' ? 'en_US' : 'zh_CN'}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeAttr(title)}">
<meta name="twitter:description" content="${escapeAttr(description)}">
<meta name="twitter:image" content="${SITE}/assets/og.png">
<script type="application/ld+json">${jsonLd}</script>
<script>document.documentElement.classList.add('js');</script>
<link rel="stylesheet" href="/styles.css?v=${CSS_VERSION}">
</head>
<body>
<a class="skip" href="#main">${lang === 'zh' ? '跳到正文' : 'Skip to content'}</a>
${navHtml(lang, entry)}
${main}
${footerHtml(lang)}
<script type="module" src="/app.js?v=${JS_VERSION}"></script>
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
  DOWNLOAD_PLATFORM_VERSION = await versionOf(path.join(SRC, 'download-platform.mjs'));
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });
  await fs.cp(path.join(SRC, 'assets'), path.join(DIST, 'assets'), { recursive: true });
  await fs.copyFile(path.join(SRC, 'site.css'), path.join(DIST, 'styles.css'));
  const siteJs = await fs.readFile(path.join(SRC, 'site.js'), 'utf8');
  await fs.writeFile(path.join(DIST, 'app.js'), siteJs.replace(
    "from './download-platform.mjs'",
    `from './download-platform.js?v=${DOWNLOAD_PLATFORM_VERSION}'`,
  ));
  // Keep the source module as .mjs for Node tests, but publish it as .js so
  // static servers return the JavaScript MIME type required by module scripts.
  await fs.copyFile(path.join(SRC, 'download-platform.mjs'), path.join(DIST, 'download-platform.js'));

  for (const lang of ['zh', 'en']) {
    for (const entry of PAGES[lang]) await page(lang, entry);
  }

  const urls = [];
  for (const lang of ['zh', 'en']) {
    for (const entry of PAGES[lang]) {
      urls.push(`${SITE}${hrefFor(lang, entry[0])}`);
    }
  }
  // Omit optional lastmod until the builder tracks actual content changes.
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
  await fs.writeFile(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /downloads/\n\nSitemap: ${SITE}/sitemap.xml\n`);
  console.log(`Built ${urls.length} pages into ${DIST}`);
};

await run();
