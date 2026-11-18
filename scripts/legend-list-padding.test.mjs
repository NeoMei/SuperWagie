import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

const requireUI = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const packageDirectory = dirname(requireUI.resolve('@legendapp/list/react'));
const bundles = ['react.js', 'react.mjs', 'react-native.web.js', 'react-native.web.mjs'];

// Exercise the installed ScrollAdjust controller with browser-like geometry
// and a frame scheduler. The controller owns its temporary spacer node.
function controller(bundle, { horizontal = false, baseline = '' } = {}) {
    const source = readFileSync(join(packageDirectory, bundle), 'utf8');
    const start = source.indexOf('function getScrollAdjustAxis(');
    const end = source.indexOf('var SnapWrapper', start);
    assert.ok(start >= 0 && end > start, "Find the pinned package version's ScrollAdjust implementation");

    const hooks = {
        useRef: (value) => ({ current: value }),
        useCallback: (callback) => callback,
        useLayoutEffect: (effect) => effect(),
    };
    const signals = new Map([['scrollAdjust', 0], ['scrollAdjustUserOffset', 0]]);
    const listeners = new Map();
    const frames = new Map();
    let frameId = 0;
    const paddingKey = horizontal ? 'paddingRight' : 'paddingBottom';
    const pixels = (value) => Number.parseFloat(value) || 0;
    const contentNode = {
        style: { [paddingKey]: baseline },
        children: [],
        ownerDocument: {
            createElement() {
                return {
                    style: new Proxy({}, {
                        set(style, key, value) {
                            // Chromium normalizes 2123.1875px to 2123.19px.
                            style[key] = value.endsWith('px') ? `${Number(pixels(value).toPrecision(6))}px` : value;
                            return true;
                        },
                    }),
                    setAttribute() {},
                    get offsetHeight() { return pixels(this.style.height); },
                    remove() {
                        const parent = this.parentElement;
                        parent.children.splice(parent.children.indexOf(this), 1);
                        this.parentElement = null;
                    },
                };
            },
        },
        appendChild(child) {
            child.parentElement = this;
            this.children.push(child);
        },
        get scrollHeight() { return 300 + pixels(this.style.paddingBottom) + this.children.reduce((size, child) => size + pixels(child.style.height), 0); },
        get scrollWidth() { return 300 + pixels(this.style.paddingRight) + this.children.reduce((size, child) => size + pixels(child.style.width), 0); },
    };
    const scrollElement = {
        scrollTop: 0, scrollLeft: 0, clientHeight: 300, clientWidth: 300,
        scrollBy({ left, top }) {
            this.scrollLeft = Math.min(this.scrollLeft + left, contentNode.scrollWidth - this.clientWidth);
            this.scrollTop = Math.min(this.scrollTop + top, contentNode.scrollHeight - this.clientHeight);
        },
    };
    const scroller = { getScrollableNode: () => scrollElement, getContentNode: () => contentNode };
    const ctx = { state: { props: { horizontal }, scroll: 0, adjustingFromInitialMount: false, refScroller: { current: scroller } } };
    const ScrollAdjust = runInNewContext(`(() => { ${source.slice(start, end)}; return ScrollAdjust; })()`, {
        React3: hooks,
        React3__namespace: hooks,
        useStateContext: () => ctx,
        peek$: (_ctx, key) => signals.get(key),
        useValueListener$: (key, callback) => listeners.set(key, callback),
        requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: (id) => frames.delete(id),
    });
    ScrollAdjust();
    return {
        get padding() { return contentNode.style[paddingKey]; },
        set padding(value) { contentNode.style[paddingKey] = value; },
        get spacer() { return contentNode.children[0]; },
        get scrollOffset() { return horizontal ? scrollElement.scrollLeft : scrollElement.scrollTop; },
        adjust(offset) {
            signals.set('scrollAdjustUserOffset', offset);
            listeners.get('scrollAdjustUserOffset')();
        },
        finishFrame() {
            const callbacks = [...frames.values()];
            frames.clear();
            for (const callback of callbacks) callback();
        },
    };
}

for (const bundle of bundles) {
    describe(`LegendList temporary padding: ${bundle}`, () => {
        it('removes the browser-rounded fractional spacer on the next frame', () => {
            const view = controller(bundle);
            view.adjust(1061.59375);
            assert.equal(view.spacer?.style.height, '2123.19px');
            assert.equal(view.scrollOffset, 1061.59375);
            assert.equal(view.padding, '');
            view.finishFrame();
            assert.equal(view.spacer, undefined);
            assert.equal(view.padding, '');
        });

        it('preserves the original baseline across overlapping adjustments', () => {
            const view = controller(bundle, { baseline: '12px' });
            view.adjust(1061.59375);
            const spacer = view.spacer;
            assert.ok(spacer);
            view.adjust(5000.25);
            assert.equal(view.spacer, spacer);
            assert.equal(view.scrollOffset, 5000.25);
            view.finishFrame();
            assert.equal(view.spacer, undefined);
            assert.equal(view.padding, '12px');
        });

        it('cleans up the horizontal web entry point too', () => {
            const view = controller(bundle, { horizontal: true });
            view.adjust(1061.59375);
            assert.equal(view.spacer?.style.width, '2123.19px');
            assert.equal(view.scrollOffset, 1061.59375);
            view.finishFrame();
            assert.equal(view.spacer, undefined);
            assert.equal(view.padding, '');
        });

        it('does not clear padding changed by another owner', () => {
            const view = controller(bundle);
            view.adjust(1061.59375);
            view.padding = '28px';
            view.finishFrame();
            assert.equal(view.spacer, undefined);
            assert.equal(view.padding, '28px');
        });
    });
}
