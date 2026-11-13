import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
    localStorage: browser.localStorage, Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
    Event: browser.Event, requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { PastedReferencePreview } = await import('./PastedReferencePreview');
const container = document.createElement('div');
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.unmount()); await browser.happyDOM.abort(); });

test('a pasted reference preview exposes escaped captured context and explicit removal', async () => {
    let removed = 0;
    await useI18nStore.getState().setLocale('en');
    await act(async () => root.render(<I18nProvider><PastedReferencePreview
        reference={{ kind: 'repository-issue', provider: 'github', number: 1, title: '报价',
            url: 'https://github.com/team/repo/issues/1', contextText: '<script>private()</script> chosen issue body' }}
        onClose={() => {}} onRemove={() => { removed += 1; }} /></I18nProvider>));
    expect(document.body.querySelector('pre')?.textContent).toContain('<script>private()</script>');
    expect(document.body.querySelector('pre script')).toBeNull();
    const remove = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Remove link');
    expect(remove).toBeDefined();
    await act(async () => remove?.click());
    expect(removed).toBe(1);
});
