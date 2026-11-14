import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@/lib/opencode/model';
import type { TurnActivityRecord } from '../lib/turns/types';
import { latestRunningShellPreview, shouldRenderLiveCommandPreview } from './liveCommandPreviewModel';

const shell = (id: string, status: 'running' | 'completed', shellID?: string): TurnActivityRecord => {
    const part: ToolPart = {
        type: 'tool',
        id,
        callID: id,
        messageID: id,
        sessionID: 'session',
        tool: 'shell',
        state: status === 'running'
            ? { status: 'running', input: { command: `printf ${id}` }, metadata: shellID ? { shellID } : {}, time: { start: 1 } }
            : { status: 'completed', input: { command: `printf ${id}` }, output: 'done', metadata: shellID ? { shellID } : {}, time: { start: 1, end: 2 } },
    };
    return { id, turnId: 'turn', messageId: id, partIndex: 0, kind: 'tool', part };
};

const nonShell = (): TurnActivityRecord => {
    const part: ToolPart = {
        type: 'tool', id: 'read', callID: 'read', messageID: 'read', sessionID: 'session', tool: 'read',
        state: { status: 'running', input: {}, metadata: {}, time: { start: 1 } },
    };
    return { id: 'read', turnId: 'turn', messageId: 'read', partIndex: 0, kind: 'tool', part };
};

describe('latestRunningShellPreview', () => {
    test('selects the latest running shell even when a later non-shell tool exists', () => {
        expect(latestRunningShellPreview([shell('old', 'running', 'sh_old'), shell('new', 'running', 'sh_new'), nonShell()]))
            .toEqual({ key: 'new', shellID: 'sh_new' });
    });

    test('ignores completed shells and shells without an authoritative id', () => {
        expect(latestRunningShellPreview([shell('done', 'completed', 'sh_done'), shell('unknown', 'running')])).toBeUndefined();
    });

    test('keeps a running shell preview when OpenCode has only published output metadata', () => {
        const part = shell('metadata', 'running');
        if (part.part.type !== 'tool' || part.part.state.status !== 'running') throw new Error('Expected running shell');
        part.part.state.metadata = { output: 'first line\nsecond line' };
        expect(latestRunningShellPreview([part])).toEqual({ key: 'metadata', output: 'first line\nsecond line' });
    });

    test('returns no preview when the turn has no shell activity', () => {
        expect(latestRunningShellPreview([nonShell()])).toBeUndefined();
    });

    test('only renders output while a visible running shell has output', () => {
        const running = { shellID: 'sh_1' };
        expect(shouldRenderLiveCommandPreview(true, running, 'line')).toBe(true);
        expect(shouldRenderLiveCommandPreview(false, running, 'line')).toBe(false);
        expect(shouldRenderLiveCommandPreview(true, running, '')).toBe(false);
        expect(shouldRenderLiveCommandPreview(true, undefined, 'line')).toBe(false);
    });
});
