import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { LegendList, type LegendListRef } from '@legendapp/list/react';
import { Window } from 'happy-dom';
import { useSelectionRowHold } from './selectionRowHold';

test('keeps selected rows mounted until the selection collapses', async () => {
    const dom = new Window({ url: 'https://app.test' });
    const values = {
        window: dom, document: dom.document, navigator: dom.navigator,
        HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event,
        CharacterData: dom.CharacterData, getComputedStyle: dom.getComputedStyle.bind(dom),
        ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver,
        requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
        cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    Object.defineProperties(dom.HTMLElement.prototype, {
        clientHeight: { configurable: true, get: () => 800 },
        clientWidth: { configurable: true, get: () => 800 },
    });
    dom.HTMLElement.prototype.getBoundingClientRect = () => new dom.DOMRect(0, 0, 800, 40);
    // Happy DOM 18 returns anchorNode/anchorOffset from both focus getters.
    // These forward selections read their real Range end as a browser does.
    Object.defineProperties(dom.Selection.prototype, {
        focusNode: { configurable: true, get(this: Selection) { return this.rangeCount ? this.getRangeAt(0).endContainer : null; } },
        focusOffset: { configurable: true, get(this: Selection) { return this.rangeCount ? this.getRangeAt(0).endOffset : 0; } },
    });
    const rows = Array.from({ length: 4 }, (_, index) => ({ key: `row-${index}` }));
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    let held: { keys: string[] } | undefined;
    function Harness() {
        const ref = React.useRef<LegendListRef | null>(null);
        held = useSelectionRowHold(ref);
        return <LegendList ref={ref} data={rows} keyExtractor={(row) => row.key} estimatedItemSize={40}
            recycleItems={false} alwaysRender={held} renderItem={({ item }) => <div data-selection-row={item.key}>{item.key}</div>} />;
    }
    try {
        await act(async () => root.render(<Harness />));
        const first = host.querySelector('[data-selection-row="row-0"]')?.firstChild;
        const last = host.querySelector('[data-selection-row="row-3"]')?.firstChild;
        if (!first || !last) throw new Error('The real list must mount both selected endpoints');
        const selection = document.getSelection();
        await act(async () => {
            selection?.setBaseAndExtent(first, 1, last, 4);
            document.dispatchEvent(new Event('selectionchange'));
        });
        expect(held?.keys).toEqual(rows.map((row) => row.key));
        // Narrowing the drag keeps rows from the same selection mounted.
        await act(async () => {
            selection?.setBaseAndExtent(first, 1, first, 4);
            document.dispatchEvent(new Event('selectionchange'));
        });
        expect(held?.keys).toEqual(rows.map((row) => row.key));
        await act(async () => {
            selection?.collapse(first, 1);
            document.dispatchEvent(new Event('selectionchange'));
        });
        expect(held).toBeUndefined();
    } finally {
        await act(async () => root.unmount());
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        await dom.happyDOM.close();
    }
});
