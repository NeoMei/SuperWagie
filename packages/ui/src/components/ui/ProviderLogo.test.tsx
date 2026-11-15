import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useUIStore } from '@/stores/useUIStore';
import { ProviderLogo } from './ProviderLogo';

function render(element: React.ReactNode) {
  const document = new Window().document;
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(element);
  return host;
}

test('a tinted metadata logo uses its original source as a current-colour mask', () => {
  const host = render(<ProviderLogo providerId="superwagie-account-operation" alt="" tint className="text-muted-foreground" />);
  const mask = host.querySelector('span.bg-current');
  expect(mask?.getAttribute('style')).toContain('mask-image:url(');
  expect(mask?.getAttribute('style')).toContain('superwagie');
  expect(mask?.getAttribute('aria-hidden')).toBe('true');
  expect(host.querySelector('img[hidden]')?.getAttribute('crossorigin')).toBe('anonymous');
});

test('a caller fallback is used only when there is no chosen icon or logo', () => {
  expect(render(<ProviderLogo providerId="" fallback={<span>Fallback</span>} />).textContent).toBe('Fallback');
  expect(render(<ProviderLogo providerId="" fallback={null} />).textContent).toBe('');
});

test('custom provider icons retain priority over tint and caller fallback', async () => {
  const dom = new Window();
  const values = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
    Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const previous = useUIStore.getState().customProviderIcons;
  useUIStore.setState({ customProviderIcons: { ...previous, test: 'cloud' } });
  try {
    await act(() => root.render(<ProviderLogo providerId="test" tint fallback={<span>Fallback</span>} />));
    expect(host.querySelector('use')?.getAttribute('href')).toBe('#oc-cloud');
    expect(host.querySelector('.bg-current')).toBeNull();
    expect(host.textContent).not.toContain('Fallback');
  } finally {
    await act(() => root.unmount());
    useUIStore.setState({ customProviderIcons: previous });
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('decorative untinted logos keep an empty accessible alternative', () => {
  const logo = render(<ProviderLogo providerId="superwagie" alt="" />).querySelector('img');
  expect(logo?.getAttribute('alt')).toBe('');
  expect(logo?.getAttribute('aria-hidden')).toBe('true');
});
