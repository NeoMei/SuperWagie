const elements = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc']);
const attributes = new Set(['xmlns', 'xmlns:xlink', 'id', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'dx', 'dy', 'd', 'points', 'cx', 'cy', 'r', 'rx', 'ry', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'transform', 'preserveAspectRatio', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'clip-path', 'clip-rule', 'mask', 'maskUnits', 'maskContentUnits', 'href', 'xlink:href', 'role', 'aria-label']);

/** Accept a passive SVG subset. Rejected diagrams remain ordinary source code. */
export function passiveSvgImage(source: string): string | null {
  if (source.length > 128 * 1024 || new TextEncoder().encode(source).byteLength > 128 * 1024 || /<!DOCTYPE|<!ENTITY|<\?/i.test(source)) return null;
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') return null;
  if (!document.documentElement.namespaceURI) document.documentElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const nodes = Array.from(document.querySelectorAll('*'));
  if (nodes.length > 5_000) return null;
  for (const element of nodes) {
    let depth = 0;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (++depth > 64) return null;
    }
    if (!elements.has(element.localName) || element.namespaceURI !== 'http://www.w3.org/2000/svg' && element.namespaceURI !== null) return null;
    for (const attribute of Array.from(element.attributes)) {
      if (!attributes.has(attribute.name)) return null;
      if (attribute.name === 'xmlns' || attribute.name === 'xmlns:xlink') continue;
      const value = attribute.value.trim();
      if (attribute.localName === 'href'
        || /(?:javascript|data|https?|file):|\/\/|@import|expression\s*\(/i.test(value)
        || /url\s*\(/i.test(value)) return null;
    }
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(document.documentElement))}`;
}
