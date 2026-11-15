import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';

import type { EditorAPI } from '@/lib/api/types';

import { ApplyPatchFileButtons } from './ApplyPatchFileButtons';
import { openApplyPatchFileInEditor } from './applyPatchEditorAction';
import { getApplyPatchFilePath } from './toolDiffUtils';

const makePatch = (path: string, line: number, before: string, after: string) => [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${line} +${line} @@`,
    `-${before}`,
    `+${after}`,
].join('\n');

// OpenCode 2.x `patch` reports each touched file as a FileDiff record.
const files = [
    {
        file: '/workspace/project/src/first.ts',
        patch: makePatch('src/first.ts', 4, 'first old', 'first new'),
        additions: 1,
        deletions: 1,
        status: 'modified',
    },
    {
        file: 'src/second.ts',
        patch: makePatch('src/second.ts', 12, 'second old', 'second new'),
        additions: 1,
        deletions: 1,
        status: 'modified',
    },
    {
        file: 'src/gone.ts',
        patch: '',
        additions: 0,
        deletions: 3,
        status: 'deleted',
    },
];

describe('ApplyPatchFileButtons', () => {
    test('renders one labeled button per non-deleted file, paths relative to the project', () => {
        const markup = renderToStaticMarkup(
            <ApplyPatchFileButtons
                currentDirectory="/workspace/project"
                metadata={{ files }}
                openDiffLabel="Open file diff"
                onFileClick={() => undefined}
            />,
        );

        expect(markup.match(/<button/g)).toHaveLength(2);
        expect(markup).toContain('aria-label="Open file diff: src/first.ts"');
        expect(markup).toContain('aria-label="Open file diff: src/second.ts"');
        // A deleted file is named but cannot be opened.
        expect(markup).toContain('gone.ts');
        expect(markup).not.toContain('Open file diff: src/gone.ts');
    });

    test('does not open removed files in either metadata format', () => {
        const calls: string[] = [];
        const editor: EditorAPI = {
            openDiff: async () => { calls.push('diff'); },
            openFile: async () => { calls.push('file'); },
        };
        for (const file of [{ file: 'gone.ts', status: 'deleted' }, { filePath: 'gone.ts', type: 'delete' }]) {
            expect(openApplyPatchFileInEditor({
                currentDirectory: '/workspace/project', diffLabel: 'changes', editor, file, isVSCode: true,
            })).toBe(false);
        }
        expect(calls).toEqual([]);
    });

    test('keeps legacy patch paths and move destinations clickable', () => {
        const markup = renderToStaticMarkup(
            <ApplyPatchFileButtons
                currentDirectory="/workspace/project"
                metadata={{ files: [
                    { filePath: '/workspace/project/old.ts', movePath: '/workspace/project/new.ts' },
                    { relativePath: 'legacy.ts' },
                ] }}
                openDiffLabel="Open file diff"
                onFileClick={() => undefined}
            />,
        );
        expect(markup).toContain('aria-label="Open file diff: new.ts"');
        expect(markup).toContain('aria-label="Open file diff: legacy.ts"');
    });

    test('opens each native clicked file with its authoritative path, patch and line without bubbling', async () => {
        const dom = new Window({ url: 'http://patch-file.test' });
        const globals = { window: dom, document: dom.document, navigator: dom.navigator,
            HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Text: dom.Text,
            getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true };
        const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
        for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const openDiffCalls: Parameters<EditorAPI['openDiff']>[] = [];
        const editor: EditorAPI = {
            openDiff: async (...args) => { openDiffCalls.push(args); },
            openFile: async () => undefined,
        };
        let handledClicks = 0;
        let parentClicks = 0;
        try {
            await act(async () => root.render(
                <div onClick={() => { parentClicks += 1; }}>
                    <ApplyPatchFileButtons
                        currentDirectory="/workspace/project"
                        metadata={{ files }}
                        openDiffLabel="Open file diff"
                        onFileClick={(file, event) => {
                            event.stopPropagation();
                            handledClicks += 1;
                            const targetPath = (getApplyPatchFilePath(file) ?? '').replace('/workspace/project/', '');
                            openApplyPatchFileInEditor({
                                currentDirectory: '/workspace/project',
                                diffLabel: `${targetPath} (changes)`, editor, file, isVSCode: true,
                            });
                        }}
                    />
                </div>,
            ));
            const buttons = container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open file diff:"]');
            expect(buttons.length).toBe(2);
            await act(async () => {
                buttons[0]?.click();
                buttons[1]?.click();
            });
            expect(handledClicks).toBe(2);
            expect(parentClicks).toBe(0);
            expect(openDiffCalls).toEqual([
                ['', '/workspace/project/src/first.ts', 'src/first.ts (changes)', { line: 4, patch: files[0]?.patch }],
                ['', '/workspace/project/src/second.ts', 'src/second.ts (changes)', { line: 12, patch: files[1]?.patch }],
            ]);
        } finally {
            await act(async () => root.unmount());
            await dom.happyDOM.abort();
            for (const [key, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        }
    });
});
