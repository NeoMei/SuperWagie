import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * An infinite CSS animation draws every frame for as long as it is on screen,
 * which is what kept an idle app busy (see the `theme-system` skill, "Animation
 * Contract"). A wait that can last shows `Spinner` (`components/ui/spinner.tsx`),
 * `BusyDots` or `useWaitingBlink`, all on one shared clock. The infinite CSS
 * animations left are bounded by the user: the short `animate-spin` of a button
 * or a quick load, the diff's expand spinner, the model name that scrolls while
 * hovered. The folded Activity header's repeating 2.8 s shimmer starts only
 * after the text is stable for one second, and stops when the header changes,
 * settles, leaves the viewport or loses visibility. The stop coin rotates one
 * composited transform only while a turn runs. The status mark breathes one
 * composited opacity only while a turn works or waits. A new infinite animation fails
 * here until it is replaced or listed with a reason.
 */
const ALLOWED = [
  { file: 'index.css', declaration: 'animation: webkit-spin 1s linear infinite !important;' },
  { file: 'index.css', declaration: 'animation: oc-trailing-expand-spin 0.8s linear infinite;' },
  { file: 'index.css', declaration: 'animation: marquee-scroll 5s linear infinite alternate;' },
  { file: 'index.css', declaration: 'animation: oc-live-header-shimmer 2.8s linear infinite;' },
  { file: 'index.css', declaration: 'animation: oc-stop-coin-orbit 1.8s linear infinite;' },
  { file: 'index.css', declaration: 'animation: oc-activity-mark-breath 2.2s ease-in-out infinite;' },
  { file: 'components/views/PierreDiffViewer.tsx', declaration: 'animation: oc-expand-spin 0.8s linear infinite;' },
];

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../../../scripts/perf/animation-fixture.html', import.meta.url));
const INFINITE_DECLARATION = /animation(?:-iteration-count)?\s*:[^;\n]*\binfinite\b[^;\n]*;?/g;
const PULSE_CLASS = /\banimate-(?:pulse|ping|bounce)\b|\banimate-\[[^\]]*\]/g;

const sourceFiles = readdirSync(SOURCE_ROOT, { recursive: true, encoding: 'utf8' })
  .map((file) => file.split('\\').join('/'))
  .filter((file) => /\.(css|tsx?)$/.test(file) && !/\.test\.|__tests__\//.test(file));

test('no infinite CSS animation outside the short, user-bounded ones', () => {
  const found: string[] = [];
  for (const file of sourceFiles) {
    const text = readFileSync(join(SOURCE_ROOT, file), 'utf8');
    for (const match of text.matchAll(INFINITE_DECLARATION)) {
      const declaration = match[0].trim();
      if (!ALLOWED.some((entry) => entry.file === file && entry.declaration === declaration)) {
        found.push(`${file}: ${declaration}`);
      }
    }
    if (!file.endsWith('.css')) {
      for (const match of text.matchAll(PULSE_CLASS)) found.push(`${file}: ${match[0]}`);
    }
  }
  expect(found).toEqual([]);
});

test('every allowed infinite animation still exists', () => {
  for (const entry of ALLOWED) {
    expect(readFileSync(join(SOURCE_ROOT, entry.file), 'utf8')).toContain(entry.declaration);
  }
});

test('the folded Activity header sweeps repeating bands from left to right', () => {
  const css = readFileSync(join(SOURCE_ROOT, 'index.css'), 'utf8');
  expect(css).toContain('-webkit-mask-position: -240px 0;');
  expect(css).toContain('mask-position: -240px 0;');
  expect(css).toContain('-webkit-mask-position: 0 0;');
  expect(css).toContain('mask-position: 0 0;');
});

test('each folded header highlight covers three full-width Chinese glyphs', () => {
  const css = readFileSync(join(SOURCE_ROOT, 'index.css'), 'utf8');
  const gradient = css.match(/rgb\(255 255 255 \/ 0\.25\) (\d+)%,[\s\S]*?rgb\(255 255 255 \/ 0\.25\) (\d+)%,/);
  const tile = css.match(/mask-size: (\d+)px 100%;/);
  expect(gradient).not.toBeNull();
  expect(tile).not.toBeNull();
  const broadWidthPx = Number(tile?.[1]) * (Number(gradient?.[2]) - Number(gradient?.[1])) / 100;
  // The mobile typography scale raises the title to 14 px.
  expect(broadWidthPx).toBeGreaterThanOrEqual(3 * 14);
  expect(css).not.toContain('39.9998%');
});

test('the isolated mask-position fixture sweeps from left to right', () => {
  const fixture = readFileSync(FIXTURE_ROOT, 'utf8');
  expect(fixture).toContain('@keyframes oc-background-position { from { background-position: 100% 0; } to { background-position: 0 0; } }');
  expect(fixture).toContain('background-repeat: no-repeat;');
  expect(fixture).toContain('background-position: 100% 0;');
  expect(fixture).toContain('background-size: 200% 100%;');
  expect(fixture).toContain('from { -webkit-mask-position: -240px 0; mask-position: -240px 0; }');
  expect(fixture).toContain('to { -webkit-mask-position: 0 0; mask-position: 0 0; }');
});

test('every supported CSS branch keeps the soft highlight and brand coin', () => {
  const css = readFileSync(join(SOURCE_ROOT, 'index.css'), 'utf8');
  expect(css).toContain('rgb(255 255 255 / 1) 50%,');
  expect(css).toContain('--oc-brand-signal: #fd4d06;');
  expect(css).toContain('var(--oc-brand-signal) 350deg,');
  expect(css).toContain('@supports (color: color-mix(in lab, red, red)) {');
  expect(css).not.toContain('currentColor 35% 40%');
});

test('the stop coin uses the chat surface and the brand signal', () => {
  const coin = readFileSync(join(SOURCE_ROOT, 'components/chat/composer/ui/ComposerStopCoin.tsx'), 'utf8');
  expect(coin).toContain("backgroundColor: 'var(--surface-background)'");
  expect(coin).toContain("boxShadow: 'inset 0 0 0 1px var(--oc-brand-signal)'");
  expect(coin).toContain('bg-[var(--oc-brand-signal)]');
});

test('the shimmer keeps the glyph color at both ends and peaks at the centre', () => {
  const css = readFileSync(join(SOURCE_ROOT, 'index.css'), 'utf8');
  // The base label stays in place; only a white copy is masked, so a flat
  // rectangle can never paint over the row's empty space.
  expect(css).not.toContain('-webkit-background-clip: text;\n  background-clip: text;\n  animation: oc-live-header-shimmer');
  expect(css).toContain('-webkit-mask-image: linear-gradient(90deg,');
  expect(css).toContain('mask-image: linear-gradient(90deg,');
  expect(css).toContain('rgb(255 255 255 / 0) 0%,');
  expect(css).toContain('rgb(255 255 255 / 1) 50%,');
  expect(css).toContain('rgb(255 255 255 / 0.82) 47%,');
  expect(css).toContain('rgb(255 255 255 / 0.82) 53%,');
  expect(css).toContain('rgb(255 255 255 / 0.55) 42%,');
  expect(css).toContain('rgb(255 255 255 / 0.55) 58%,');
  expect(css).toContain('rgb(255 255 255 / 0) 100%);');
  expect(css).toContain('mask-size: 240px 100%;');
});

test('the provider mark breathes smoothly and stops for reduced motion', () => {
  const css = readFileSync(join(SOURCE_ROOT, 'index.css'), 'utf8');
  expect(css).toContain('animation: oc-activity-mark-breath 2.2s ease-in-out infinite;');
  expect(css).toContain('0%, 100% { opacity: 0.58; }');
  expect(css).toContain('50% { opacity: 1; }');
  expect(css).toContain('.oc-activity-mark--breathing {\n    animation: none;');
  const fixture = readFileSync(FIXTURE_ROOT, 'utf8');
  expect(fixture).toContain('@keyframes oc-activity-mark-breath { 0%, 100% { opacity: 0.58; } 50% { opacity: 1; } }');
  expect(fixture).toContain('.v-activity-mark-breath .cell::before { animation: oc-activity-mark-breath 2.2s ease-in-out infinite; }');
});

test('the SuperWagie provider uses a colorable product-mark asset', () => {
  const logos = readFileSync(join(SOURCE_ROOT, 'hooks/useProviderLogo.ts'), 'utf8');
  expect(logos).toContain("import productMarkUrl from '@/assets/provider-logos/superwagie.png?url'");
});
