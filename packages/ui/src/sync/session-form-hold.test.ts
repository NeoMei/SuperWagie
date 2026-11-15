import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { FormRequest, Part, Session, ToolPart } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { createRuntimeUrlAuthFixture } from '@/lib/runtime-url-auth.fixture';
import { useConfigStore } from '@/stores/useConfigStore';
import { ChildStoreManager } from './child-store';
import { dismissOpenFormsForSession, readUnloadedFormToolLinks, setActionRefs } from './session-actions';
import { formTurnHold, resetRecoverableQuestions, useRecoverableQuestionsStore } from './recoverable-questions';

const directory = '/form-hold/project';
const session = (id: string, parentID?: string): Session => ({
    id, parentID, projectID: 'project', directory, title: id, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
});
const form = (id: string, sessionID = 'root'): FormRequest => ({
    id, sessionID, title: id, fields: [{ key: 'answer', type: 'string' }],
    metadata: { kind: 'plugin', tool: { messageID: `message-${id}`, id: `tool-${id}` } },
});
const tool = (form: FormRequest, status: 'running' | 'completed'): ToolPart => ({
    id: `tool-${form.id}`, messageID: `message-${form.id}`, sessionID: form.sessionID,
    callID: `call-${form.id}`, tool: 'question', type: 'tool',
    state: status === 'running' ? { status, input: {}, time: { start: 1 } }
        : { status, input: {}, output: '', time: { start: 1, end: 2 } },
});
const toolMessage = (form: FormRequest, status: 'running' | 'completed' = 'completed'): Awaited<ReturnType<typeof opencodeClient.getSessionMessage>> => ({
    info: { id: `message-${form.id}`, sessionID: form.sessionID, role: 'assistant', time: { created: 1, completed: 2 }, agent: 'build', providerID: 'provider', modelID: 'model' },
    parts: [tool(form, status)],
});
function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

let stores: ChildStoreManager;
let cancel: ReturnType<typeof spyOn<typeof opencodeClient, 'cancelForm'>>;
const previousConfig = useConfigStore.getState();
beforeEach(() => {
    stores = new ChildStoreManager();
    resetRecoverableQuestions();
    useConfigStore.setState({ isConnected: true, hasEverConnected: true });
    cancel = spyOn(opencodeClient, 'cancelForm').mockResolvedValue(true);
    setActionRefs(stores, () => directory);
});
afterEach(() => {
    cancel.mockRestore();
    stores.disposeAll();
    useConfigStore.setState(previousConfig);
    resetRecoverableQuestions();
});

function seed(forms: FormRequest[], parts: Part[]) {
    const owner = stores.ensureChild(directory, { bootstrap: false });
    owner.setState({
        session: [session('root'), session('child', 'root'), session('other')],
        form: Object.fromEntries(forms.map((item) => [item.sessionID, [item]])),
        part: Object.fromEntries(parts.map((item) => [item.messageID, [item]])),
    });
    return owner;
}

describe('form turn holding on a new prompt', () => {
    test('leaves deferred forms open while cancelling the active child prompt only', async () => {
        const deferred = form('deferred');
        const child = form('child', 'child');
        const unrelated = form('unrelated', 'other');
        const owner = seed([deferred, child, unrelated], [tool(deferred, 'completed'), tool(child, 'running'), tool(unrelated, 'running')]);
        expect(await dismissOpenFormsForSession('root')).toBe(true);
        expect(cancel.mock.calls.map((call) => call.slice(0, 2))).toEqual([['child', child.id]]);
        expect(owner.getState().form.root).toEqual([deferred]);
        expect(owner.getState().form.child).toBeUndefined();
        expect(owner.getState().form.other).toEqual([unrelated]);
    });

    test('terminal evidence from another existing copy keeps the form answerable', async () => {
        const deferred = form('duplicate');
        const owner = seed([deferred], []);
        const copy = stores.ensureChild('/form-hold/copy', { bootstrap: false });
        copy.setState({ session: [session('root')], form: { root: [deferred] }, part: { [tool(deferred, 'completed').messageID]: [tool(deferred, 'completed')] } });
        expect(await dismissOpenFormsForSession('root')).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
        expect(owner.getState().form.root).toEqual([deferred]);
        expect(copy.getState().form.root).toEqual([deferred]);
    });

    test('reads an unloaded linked call once in its owning directory and preserves ended forms', async () => {
        const deferred = form('history');
        const owner = seed([deferred], []);
        const unrelated = stores.ensureChild('/form-hold/unrelated', { bootstrap: false });
        const other = form('other-history', 'other');
        unrelated.setState({ session: [session('other')], form: { other: [other] } });
        const read = spyOn(opencodeClient, 'getSessionMessage').mockResolvedValue(toolMessage(deferred));
        try {
            readUnloadedFormToolLinks('root');
            expect(await dismissOpenFormsForSession('root')).toBe(false);
            expect(read.mock.calls).toEqual([['root', 'message-history', directory]]);
            expect(cancel).not.toHaveBeenCalled();
            expect(formTurnHold(deferred, owner.getState().part, useRecoverableQuestionsStore.getState().releasedForms)).toBe('released');
            expect(owner.getState().form.root).toEqual([deferred]);
            expect(owner.getState().part).toEqual({});
        } finally { read.mockRestore(); }
    });

    test('a failed history read leaves the form and its unknown authority intact', async () => {
        const deferred = form('unavailable');
        const owner = seed([deferred], []);
        const read = spyOn(opencodeClient, 'getSessionMessage').mockRejectedValue(new Error('offline'));
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        try {
            readUnloadedFormToolLinks('root');
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(read).toHaveBeenCalledTimes(1);
            expect(formTurnHold(deferred, owner.getState().part, useRecoverableQuestionsStore.getState().releasedForms)).toBe('unknown');
            expect(owner.getState().form.root).toEqual([deferred]);
            expect(cancel).not.toHaveBeenCalled();
        } finally { read.mockRestore(); errors.mockRestore(); }
    });

    test('replacing the store manager during a history read retires the cancellation', async () => {
        const deferredForm = form('retired');
        const owner = seed([deferredForm], []);
        const response = deferred<Awaited<ReturnType<typeof opencodeClient.getSessionMessage>>>();
        const started = deferred<void>();
        const read = spyOn(opencodeClient, 'getSessionMessage').mockImplementation(() => { started.resolve(); return response.promise; });
        const next = new ChildStoreManager();
        try {
            const dismissal = dismissOpenFormsForSession('root');
            await started.promise;
            setActionRefs(next, () => directory);
            response.resolve(toolMessage(deferredForm));
            expect(await dismissal).toBe(false);
            expect(owner.getState().form.root).toEqual([deferredForm]);
            expect(useRecoverableQuestionsStore.getState().releasedForms.size).toBe(0);
            expect(cancel).not.toHaveBeenCalled();
        } finally { read.mockRestore(); next.disposeAll(); }
    });

    test('a reused form ID with a new tool link is not cancelled by the old read', async () => {
        const original = form('reused');
        const owner = seed([original], []);
        const response = deferred<Awaited<ReturnType<typeof opencodeClient.getSessionMessage>>>();
        const started = deferred<void>();
        const read = spyOn(opencodeClient, 'getSessionMessage').mockImplementation(() => { started.resolve(); return response.promise; });
        try {
            const dismissal = dismissOpenFormsForSession('root');
            await started.promise;
            const replacement = { ...original, metadata: { kind: 'plugin', tool: { messageID: 'new-message', id: 'new-tool' } } };
            owner.setState({ form: { root: [replacement] } });
            response.resolve(toolMessage(original));
            expect(await dismissal).toBe(false);
            expect(owner.getState().form.root).toEqual([replacement]);
            expect(useRecoverableQuestionsStore.getState().releasedForms.size).toBe(0);
            expect(cancel).not.toHaveBeenCalled();
        } finally { read.mockRestore(); }
    });

    test('an A-to-B-to-A runtime round trip retires a pending history read', async () => {
        const originalBase = getRuntimeApiBaseUrl();
        const originalKey = getRuntimeKey();
        const runtime = createRuntimeUrlAuthFixture(['https://form-hold-other.test', originalBase]);
        const deferredForm = form('runtime');
        const owner = seed([deferredForm], []);
        const response = deferred<Awaited<ReturnType<typeof opencodeClient.getSessionMessage>>>();
        const started = deferred<void>();
        const read = spyOn(opencodeClient, 'getSessionMessage').mockImplementation(() => { started.resolve(); return response.promise; });
        try {
            const dismissal = dismissOpenFormsForSession('root');
            await started.promise;
            runtime.switchEndpoint({ apiBaseUrl: 'https://form-hold-other.test', runtimeKey: 'form-hold-other' });
            runtime.switchEndpoint({ apiBaseUrl: originalBase, runtimeKey: originalKey });
            response.resolve(toolMessage(deferredForm));
            expect(await dismissal).toBe(false);
            expect(owner.getState().form.root).toEqual([deferredForm]);
            expect(useRecoverableQuestionsStore.getState().releasedForms.size).toBe(0);
            expect(cancel).not.toHaveBeenCalled();
        } finally { read.mockRestore(); await runtime.restore(); }
    });
});
