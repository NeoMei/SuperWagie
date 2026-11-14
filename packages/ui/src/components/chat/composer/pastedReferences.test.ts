import { expect, test } from 'bun:test';
import { PastedReferences } from './pastedReferences';
import type { ComposerReference } from './composerReferences';

const link = 'https://github.com/team/repo/issues/1';
const reference: ComposerReference = { kind: 'repository-issue', provider: 'github', number: 1,
    title: '报价', url: link, contextText: 'Selected issue body' };

function fixture() {
    let text = link;
    let current = true;
    let finish: (value: ComposerReference) => void = () => {};
    let reject: (error: Error) => void = () => {};
    let reads = 0;
    const failures: string[] = [];
    let published: ReadonlyMap<string, ComposerReference> = new Map();
    const manager = new PastedReferences({
        current: () => current,
        text: () => text,
        find: () => [{ link, target: { source: 'repository', provider: 'github', instance: 'github.com',
            owner: 'team', repo: 'repo', kind: 'issue', number: 1 } }],
        read: () => {
            reads += 1;
            return new Promise((resolve, fail) => { finish = resolve; reject = fail; });
        },
        publish: (value) => { published = value; },
        failed: (_, reason) => failures.push(reason),
        timeout: () => 'timeout',
        limited: () => { throw new Error('Unexpected limit'); },
    });
    return { manager, finish: () => finish(reference), fail: () => reject(new Error('offline')),
        text: (value: string) => { text = value; }, retire: () => { current = false; },
        reads: () => reads, failures, published: () => published };
}

test('two pastes share one read and repeated Enter admits one send', async () => {
    const f = fixture();
    f.manager.readPaste(link);
    f.manager.readPaste(link);
    const first = f.manager.beforeSend(link);
    expect(await f.manager.beforeSend(link)).toBe(false);
    expect(f.reads()).toBe(1);
    f.finish();
    expect(await first).toBe(true);
    expect(f.manager.inText(`${link} ${link}`)).toEqual([reference]);
});

test('removing a pending link cancels that send and attaches no stale content', async () => {
    const f = fixture();
    f.manager.readPaste(link);
    const send = f.manager.beforeSend(link);
    f.text('new text');
    f.finish();
    expect(await send).toBe(false);
    expect(f.published().size).toBe(0);
    expect(f.manager.inText('new text')).toEqual([]);
});

test('removing a resolved link removes its outgoing context', async () => {
    const f = fixture();
    f.manager.readPaste(link);
    f.finish();
    await f.manager.beforeSend(link);
    expect(f.manager.inText('')).toEqual([]);
});

test('runtime or project retirement cannot publish or send the old result', async () => {
    const f = fixture();
    f.manager.readPaste(link);
    const send = f.manager.beforeSend(link);
    f.retire();
    f.finish();
    expect(await send).toBe(false);
    expect(f.published().size).toBe(0);
    expect(f.manager.inText(link)).toEqual([]);
});

test('failed lookup retains raw text and sends no resolved context', async () => {
    const f = fixture();
    f.manager.readPaste(link);
    f.fail();
    expect(await f.manager.beforeSend(link)).toBe(true);
    expect(f.failures).toEqual(['offline']);
    expect(f.manager.inText(link)).toEqual([]);
});
