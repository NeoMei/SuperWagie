import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

const requireUI = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const packageDirectory = dirname(requireUI.resolve('@legendapp/list/react'));
const bundles = ['react.js', 'react.mjs', 'react-native.web.js', 'react-native.web.mjs'];

// Run the installed coordinator's layout effect against DOM-like rows.
function domOrderLayout(bundle, itemIndices, focusedIndex) {
    const source = readFileSync(join(packageDirectory, bundle), 'utf8');
    const start = source.indexOf('function sortContainerElements(');
    const end = source.indexOf('\nvar getComponent =', start);
    assert.ok(start >= 0 && end > start, "Find the pinned package version's layout coordinator");

    const focused = focusedIndex === undefined ? null : { isConnected: true };
    const root = { activeElement: focused };
    const moved = [];
    const container = {
        isConnected: true,
        children: [],
        ownerDocument: { body: {} },
        getRootNode: () => root,
        moveBefore(row, next) {
            moved.push(row.itemIndex);
            this.children.splice(this.children.indexOf(row), 1);
            this.children.splice(next === null ? this.children.length : this.children.indexOf(next), 0, row);
        },
    };
    container.children = itemIndices.map((itemIndex) => ({
        itemIndex,
        parentElement: container,
        contains: (element) => element === focused && focused !== null && itemIndex === focusedIndex,
    }));
    const ctx = { viewRefs: new Map(container.children.map((row, id) => [id, { current: row }])) };
    const signals = new Map(itemIndices.map((itemIndex, id) => [`containerItemIndex${id}`, itemIndex]));
    const effects = [];
    const hooks = { useLayoutEffect: (effect) => effects.push(effect) };
    const Coordinator = runInNewContext(`(() => { ${source.slice(start, end)}; return ContainerLayoutCoordinator; })()`, {
        React3: hooks,
        React3__namespace: hooks,
        typedMemo: (component) => component,
        useStateContext: () => ctx,
        useArr$: () => [1],
        peek$: (_ctx, key) => signals.get(key),
        getContainerLayoutEffectScope: () => undefined,
    });
    Coordinator({ children: null });
    return {
        moved,
        get itemIndices() { return container.children.map((row) => row.itemIndex); },
        commitLayout() {
            for (const effect of effects) effect();
        },
    };
}

// Runs the installed dependency's own container allocation for the first
// rows of a freshly opened list, with the direction argument its
// calculateItemsInView passes while the initial scroll is active and aligned
// to the end (how the chat opens). Containers render in index order, so the
// returned container per row is the row's DOM position.
function initialAllocation(bundle) {
    const source = readFileSync(join(packageDirectory, bundle), 'utf8');
    const start = source.indexOf('function findAvailableContainers(');
    const end = source.indexOf('// src/utils/setDidLayout.ts', start);
    assert.ok(start >= 0 && end > start, "Find the pinned package version's container allocation");

    const callStart = source.indexOf('const availableContainerAllocations = findAvailableContainers(');
    const argumentsEnd = source.indexOf(');', callStart);
    assert.ok(callStart >= 0 && argumentsEnd > callStart, 'Find the allocation call in calculateItemsInView');
    const directionArgument = source
        .slice(callStart, argumentsEnd)
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
        .split('protectedContainerKeys,')[1]
        .trim();
    const reverseItemOrder = runInNewContext(directionArgument, {
        hasActiveInitialScroll: () => true,
        initialScroll: { index: 9, viewPosition: 1 },
        speed: 0,
        state: { hasScrolled: false, scroll: 0, scrollPrev: 0 },
    });

    const numContainers = 6;
    const values = new Map([['numContainers', numContainers]]);
    const ctx = {
        viewRefs: new Map(),
        state: {
            containerItemMetadata: new Map(),
            stickyContainerPool: new Set(),
            props: { data: Array.from({ length: 10 }, (_, index) => index), recycleItems: false, stickyHeaderIndicesSet: new Set() },
            indexByKey: new Map(),
        },
    };
    const findAvailableContainers = runInNewContext(`(() => { ${source.slice(start, end)}; return findAvailableContainers; })()`, {
        peek$: (_ctx, key) => values.get(key),
        IS_DEV: false,
    });
    // The rows on screen at the end of a ten-row list: 6..9, all new.
    const allocations = findAvailableContainers(ctx, [6, 7, 8, 9], 6, 9, [], undefined, reverseItemOrder);
    return allocations.map(({ itemIndex, containerIndex }) => ({ itemIndex, containerIndex }));
}

for (const bundle of bundles) {
    describe(`LegendList DOM order: ${bundle}`, () => {
        it('opens an end-aligned list with its rows already in DOM order', () => {
            const allocations = initialAllocation(bundle);
            const byContainer = [...allocations].sort((left, right) => left.containerIndex - right.containerIndex);
            assert.deepEqual(byContainer.map(({ itemIndex }) => itemIndex), [6, 7, 8, 9]);
        });

        it('leaves rows already in reading order in place during layout', () => {
            const list = domOrderLayout(bundle, [6, 7, 8, 9]);
            list.commitLayout();
            assert.deepEqual(list.itemIndices, [6, 7, 8, 9]);
            assert.deepEqual(list.moved, []);
        });

        it('restores reading order in layout with one move and preserves the focused row', () => {
            const list = domOrderLayout(bundle, [6, 8, 7, 9], 8);
            assert.deepEqual(list.itemIndices, [6, 8, 7, 9]);
            list.commitLayout();
            assert.deepEqual(list.itemIndices, [6, 7, 8, 9]);
            assert.deepEqual(list.moved, [7]);
        });
    });
}
