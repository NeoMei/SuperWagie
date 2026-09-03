import katex from 'katex';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function splitFrontmatter(source) {
  if (!source.startsWith('---\n')) return { body: source, raw: '', properties: {} };
  const end = source.indexOf('\n---\n', 4);
  if (end < 0) return { body: source, raw: '', properties: {} };
  const raw = source.slice(4, end);
  const properties = {};
  let currentList = null;
  for (const line of raw.split('\n')) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (pair) {
      const [, key, value] = pair;
      if (value === '') {
        properties[key] = [];
        currentList = key;
      } else {
        properties[key] = value.replace(/^['"]|['"]$/g, '');
        currentList = null;
      }
      continue;
    }
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && currentList) properties[currentList].push(item[1]);
  }
  return { body: source.slice(end + 5), raw, properties };
}

export function resolveWikiTarget(rawTarget) {
  const [destination, alias] = rawTarget.split('|', 2);
  const hash = destination.indexOf('#');
  const base = hash >= 0 ? destination.slice(0, hash) : destination;
  const fragment = hash >= 0 ? destination.slice(hash + 1) : '';
  return {
    path: /\.[A-Za-z0-9]+$/.test(base) ? base : `${base}.md`,
    heading: fragment && !fragment.startsWith('^') ? fragment : null,
    block: fragment.startsWith('^') ? fragment.slice(1) : null,
    label: alias || destination,
  };
}

export function resolveWorkspaceReference(currentDocument, targetPath) {
  const normalize = (value) => {
    const output = [];
    for (const part of value.replaceAll('\\', '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') output.pop();
      else output.push(part);
    }
    return output.join('/');
  };
  if (targetPath.includes('/') && !targetPath.startsWith('./') && !targetPath.startsWith('../')) return normalize(targetPath);
  const currentParts = currentDocument.replaceAll('\\', '/').split('/');
  currentParts.pop();
  return normalize([...currentParts, targetPath].join('/'));
}

export function buildDocumentIndex(source) {
  const { body, properties } = splitFrontmatter(source);
  const headings = [];
  const tasks = [];
  const tags = new Set();
  const wikilinks = [];
  const embeds = [];
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^```/.test(line)) fenced = !fenced;
    if (!fenced) {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) headings.push({ depth: heading[1].length, text: heading[2] });
      const task = line.match(/^\s*-\s+\[([ xX])\]\s+(.+)$/);
      if (task) tasks.push({ completed: task[1].toLowerCase() === 'x', text: task[2] });
      for (const match of line.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(match[1]);
    }
  }
  for (const match of body.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
    const item = { raw: match[2], ...resolveWikiTarget(match[2]) };
    if (match[1] === '!') embeds.push(item);
    else wikilinks.push(item);
  }
  for (const tag of Array.isArray(properties.tags) ? properties.tags : []) tags.add(tag);
  return { properties, headings, tasks, tags: [...tags], wikilinks, embeds };
}

export function extractExcalidrawScene(source) {
  const marker = /## Drawing\s*\n```json\s*\n([\s\S]*?)\n```/m.exec(source);
  if (!marker) throw new Error('SW_MARKDOWN_EXCALIDRAW_SCENE_MISSING');
  const scene = JSON.parse(marker[1]);
  if (scene?.type !== 'excalidraw' || !Array.isArray(scene.elements)) {
    throw new Error('SW_MARKDOWN_EXCALIDRAW_SCENE_INVALID');
  }
  return { source, scene };
}

function renderExcalidrawSvg(scene) {
  const visible = scene.elements.filter((element) => !element.isDeleted);
  const maxX = Math.max(820, ...visible.map((element) => (element.x || 0) + (element.width || 0) + 30));
  const maxY = Math.max(230, ...visible.map((element) => (element.y || 0) + (element.height || 0) + 30));
  const shapes = [];
  for (const element of visible) {
    const stroke = escapeHtml(element.strokeColor || '#555');
    const fill = escapeHtml(element.backgroundColor === 'transparent' ? 'none' : (element.backgroundColor || 'none'));
    if (element.type === 'rectangle') {
      shapes.push(`<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" rx="18" fill="${fill}" stroke="${stroke}" stroke-width="${element.strokeWidth || 1}"/>`);
    } else if (element.type === 'arrow') {
      const [start, end] = element.points || [[0, 0], [0, 0]];
      shapes.push(`<line x1="${element.x + start[0]}" y1="${element.y + start[1]}" x2="${element.x + end[0]}" y2="${element.y + end[1]}" stroke="${stroke}" stroke-width="${element.strokeWidth || 1}" marker-end="url(#arrow)"/>`);
    } else if (element.type === 'text') {
      const anchor = element.textAlign === 'center' ? 'middle' : 'start';
      const x = anchor === 'middle' ? element.x + element.width / 2 : element.x;
      shapes.push(`<text x="${x}" y="${element.y + (element.fontSize || 18)}" text-anchor="${anchor}" fill="${stroke}" font-size="${element.fontSize || 18}" font-family="system-ui, sans-serif">${escapeHtml(element.text || '')}</text>`);
    }
  }
  return `<svg class="sw-excalidraw-embed" viewBox="0 0 ${maxX} ${maxY}" role="img" aria-label="Excalidraw diagram"><defs><marker id="arrow" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto"><polygon points="0 0, 9 3.5, 0 7" fill="#555"/></marker></defs>${shapes.join('')}</svg>`;
}

function renderProperties(raw, properties) {
  if (!raw) return '';
  const rows = Object.entries(properties).map(([key, value]) => `<div class="sw-property"><span>${escapeHtml(key)}</span><strong>${escapeHtml(Array.isArray(value) ? value.join(', ') : value)}</strong></div>`).join('');
  return `<section class="sw-properties" data-source-frontmatter="${escapeHtml(raw)}"><div class="sw-properties-title">Properties</div>${rows}</section>`;
}

function extractSection(source, heading, block) {
  if (block) {
    const line = source.split('\n').find((candidate) => candidate.includes(`^${block}`));
    return line ? line.replace(new RegExp(`\\s*\\^${block}\\s*$`), '') : '';
  }
  if (!heading) return source;
  const lines = source.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^#{1,6}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(line));
  if (start < 0) return '';
  const depth = lines[start].match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length && !(new RegExp(`^#{1,${depth}}\\s+`)).test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

function preprocessCallouts(source) {
  const lines = source.split('\n');
  const output = [];
  for (let index = 0; index < lines.length;) {
    const match = lines[index].match(/^> \[!([A-Za-z0-9_-]+)\][+-]?\s*(.*)$/);
    if (!match) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    const body = [];
    index += 1;
    while (index < lines.length && /^>/.test(lines[index])) {
      body.push(lines[index].replace(/^> ?/, ''));
      index += 1;
    }
    output.push(`<aside class="sw-callout sw-callout-${escapeHtml(match[1].toLowerCase())}"><div class="sw-callout-title">${escapeHtml(match[2] || match[1])}</div>\n\n${body.join('\n')}\n\n</aside>`);
  }
  return output.join('\n');
}

function preprocessMath(source) {
  let rendered = source.replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_match, expression) => katex.renderToString(expression, { displayMode: true, throwOnError: false }));
  rendered = rendered.replace(/(?<!\\)\$([^\n$]+)\$/g, (_match, expression) => katex.renderToString(expression, { displayMode: false, throwOnError: false }));
  return rendered;
}

export async function renderMarkdown(source, { readText, assetUrl }) {
  const { body, raw, properties } = splitFrontmatter(source);
  const placeholders = new Map();
  let placeholderIndex = 0;
  const reserve = (html) => {
    const key = `SWPLACEHOLDER${placeholderIndex++}TOKEN`;
    placeholders.set(key, html);
    return key;
  };

  let prepared = '';
  let cursor = 0;
  const syntax = /(!?)\[\[([^\]]+)\]\]/g;
  for (const match of body.matchAll(syntax)) {
    prepared += body.slice(cursor, match.index);
    const embed = match[1] === '!';
    const target = resolveWikiTarget(match[2]);
    if (!embed) {
      prepared += reserve(`<a class="sw-wikilink" href="#" data-wikilink="${escapeHtml(target.path)}" data-heading="${escapeHtml(target.heading || '')}" data-block="${escapeHtml(target.block || '')}">${escapeHtml(target.label)}</a>`);
    } else if (/\.(png|jpe?g|gif|webp|svg)$/i.test(target.path)) {
      prepared += reserve(`<figure class="sw-embed sw-image-embed"><img src="${escapeHtml(assetUrl(target.path))}" alt="${escapeHtml(target.label)}"/><figcaption>${escapeHtml(target.label)}</figcaption></figure>`);
    } else if (/\.excalidraw(\.md)?$/i.test(target.path)) {
      const drawingPath = target.path.endsWith('.excalidraw') ? `${target.path}.md` : target.path;
      const drawingSource = await readText(drawingPath);
      prepared += reserve(drawingSource ? renderExcalidrawSvg(extractExcalidrawScene(drawingSource).scene) : `<div class="sw-embed-error">找不到“${escapeHtml(target.path)}”</div>`);
    } else {
      const embeddedSource = await readText(target.path);
      const section = embeddedSource ? extractSection(embeddedSource, target.heading, target.block) : '';
      prepared += reserve(section ? `<aside class="sw-embed sw-document-embed">${escapeHtml(section)}</aside>` : `<div class="sw-embed-error">找不到“${escapeHtml(target.path)}”</div>`);
    }
    cursor = match.index + match[0].length;
  }
  prepared += body.slice(cursor);
  prepared = preprocessMath(preprocessCallouts(prepared));

  const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false }).use(footnote);
  const defaultFence = md.renderer.rules.fence?.bind(md.renderer.rules) || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.info.trim() === 'mermaid') return `<div class="sw-mermaid" data-source="${escapeHtml(token.content)}"><pre>${escapeHtml(token.content)}</pre></div>`;
    return defaultFence(tokens, idx, options, env, self);
  };
  let html = renderProperties(raw, properties) + md.render(prepared);
  for (const [key, value] of placeholders) html = html.replaceAll(key, value);
  return html;
}
