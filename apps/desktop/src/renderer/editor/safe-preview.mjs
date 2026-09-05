import DOMPurify from 'dompurify';
import { renderMarkdown } from './markdown-model.mjs';

const trustedPolicy = globalThis.trustedTypes?.createPolicy('superwagie-markdown', {
  createHTML: (value) => value,
});

export function safePreview(source) {
  const sanitized = DOMPurify.sanitize(renderMarkdown(source, (value) => value), {
    ALLOWED_TAGS: ['a', 'aside', 'blockquote', 'br', 'button', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'section', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'],
    ALLOWED_ATTR: ['aria-label', 'class', 'data-callout', 'data-wikilink', 'href', 'role', 'type'],
    ALLOW_DATA_ATTR: true,
  });
  return trustedPolicy ? trustedPolicy.createHTML(sanitized) : sanitized;
}
