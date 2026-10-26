import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { OpenChamberLogo } from './OpenChamberLogo';
import { OPEN_CHAMBER_LOGO_ART as ART } from './openChamberLogoArt';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root;
let host: HTMLDivElement;

const render = (element: React.ReactElement) => act(async () => {
  root.render(<I18nProvider>{element}</I18nProvider>);
});
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test('renders the shared raster logo with the requested dimensions', async () => {
  await render(<OpenChamberLogo />);
  const image = host.querySelector('img');
  expect(image?.getAttribute('src')).toBe('/logo.png');
  expect(image?.getAttribute('alt')).toBe('犇马');
  expect(image?.getAttribute('width')).toBe('40');
  expect(image?.getAttribute('height')).toBe('40');
});

test('keeps the compatibility animation prop without changing the raster contract', async () => {
  await render(<OpenChamberLogo width={96} height={72} isAnimated />);
  const image = host.querySelector('img');
  expect(image?.getAttribute('src')).toBe('/logo.png');
  expect(image?.getAttribute('width')).toBe('96');
  expect(image?.getAttribute('height')).toBe('72');
});

test('keeps the generated vector geometry available to native surfaces', () => {
  expect(ART.shell).toHaveLength(3);
  expect(ART.tiers).toHaveLength(3);
});
