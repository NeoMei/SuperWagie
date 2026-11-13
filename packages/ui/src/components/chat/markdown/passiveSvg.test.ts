import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { passiveSvgImage } from './passiveSvg';
const dom = new Window();
Object.assign(globalThis, { DOMParser: dom.DOMParser, XMLSerializer: dom.XMLSerializer });
const svg = (content: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">${content}</svg>`;
describe('passive SVG file diagrams', () => {
  test('renders bounded static geometry and Chinese labels as image data', () => {
    expect(passiveSvgImage('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')?.startsWith('data:image/svg+xml;')).toBe(true);
    expect(passiveSvgImage(svg('<rect width="20" height="20" fill="red"/><text y="10">预算</text>'))?.startsWith('data:image/svg+xml;')).toBe(true);
  });
  test('scripts, events, HTML, animation, external links and external paint stay as source', () => {
    for (const content of ['<script>alert(1)</script>', '<rect onload="alert(1)"/>', '<foreignObject><div>HTML</div></foreignObject>', '<animate attributeName="x"/>', '<image href="https://example.invalid/a"/>', '<use href="https://example.invalid/a#x"/>', '<rect fill="url(https://example.invalid/a)"/>', '<rect style="fill:red"/>']) {
      expect(passiveSvgImage(svg(content))).toBeNull();
    }
    expect(passiveSvgImage('<!DOCTYPE svg [<!ENTITY test SYSTEM "file:///secret">]>' + svg('<text>&test;</text>'))).toBeNull();
    expect(passiveSvgImage('<svg><broken>')).toBeNull();
    expect(passiveSvgImage(svg('<?xml-stylesheet href="https://example.invalid/style.css"?>'))).toBeNull();
  });
  test('reference expansion and source, node and depth limits remain source', () => {
    let body = '<g id="a0"><rect width="10" height="10"/></g>';
    for (let n = 1; n <= 6; n++) body += '<g id="a' + n + '">' + Array.from({ length: 8 }, () => '<use href="#a' + (n - 1) + '"/>').join('') + '</g>';
    expect(passiveSvgImage(svg('<defs>' + body + '</defs><use href="#a6"/>'))).toBeNull();
    expect(passiveSvgImage(svg('<rect fill="url(#paint)"/>'))).toBeNull();
    expect(passiveSvgImage(svg('<text>' + 'a'.repeat(128 * 1024) + '</text>'))).toBeNull();
    expect(passiveSvgImage(svg('<path/>'.repeat(5_001)))).toBeNull();
    expect(passiveSvgImage(svg('<g>'.repeat(66) + '<rect/>' + '</g>'.repeat(66)))).toBeNull();
  });

});
