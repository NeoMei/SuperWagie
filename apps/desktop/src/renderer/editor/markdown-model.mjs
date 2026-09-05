import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function splitFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return { raw: '', body: source, properties: [] };
  const properties = match[1].split(/\r?\n/).flatMap((line) => {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    return pair ? [[pair[1], pair[2]]] : [];
  });
  return { raw: match[1], body: source.slice(match[0].length), properties };
}

export function createLosslessMarkdownDocument(initialSource) {
  let source = String(initialSource);
  let revision = 0;
  return Object.freeze({
    source: () => source,
    revision: () => revision,
    replace(nextSource) {
      source = String(nextSource);
      revision += 1;
      return revision;
    },
  });
}

export function renderMarkdown(source, sanitize) {
  const { raw, body, properties } = splitFrontmatter(String(source));
  const placeholders = new Map();
  let nextPlaceholder = 0;
  const reserve = (html) => {
    const token = `SWPLACEHOLDER${nextPlaceholder++}TOKEN`;
    placeholders.set(token, html);
    return token;
  };
  let prepared = body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target, alias) => reserve(
    `<button type="button" class="sw-wikilink" data-wikilink="${escapeHtml(target)}">${escapeHtml(alias || target)}</button>`,
  ));
  const lines = prepared.split(/\r?\n/);
  const calloutLines = [];
  for (let index = 0; index < lines.length;) {
    const callout = /^> \[!([A-Za-z0-9_-]+)\][+-]?\s*(.*)$/.exec(lines[index]);
    if (!callout) {
      calloutLines.push(lines[index++]);
      continue;
    }
    const content = [];
    index += 1;
    while (index < lines.length && lines[index].startsWith('>')) {
      content.push(lines[index].replace(/^> ?/, ''));
      index += 1;
    }
    calloutLines.push(reserve(
      `<aside class="sw-callout" data-callout="${escapeHtml(callout[1].toLowerCase())}"><strong>${escapeHtml(callout[2] || callout[1])}</strong><p>${escapeHtml(content.join('\n'))}</p></aside>`,
    ));
  }
  prepared = calloutLines.join('\n');
  const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false }).use(footnote);
  markdown.renderer.rules.image = (tokens, index) => escapeHtml(tokens[index].content || tokens[index].attrGet('alt') || 'image');
  let html = markdown.render(prepared);
  for (const [token, replacement] of placeholders) html = html.replaceAll(token, replacement);
  if (raw) {
    const rows = properties.map(([key, value]) => (
      `<div class="sw-property"><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`
    )).join('');
    html = `<section class="sw-properties" aria-label="文档属性">${rows}</section>${html}`;
  }
  return sanitize(html);
}
