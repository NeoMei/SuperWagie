import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@/lib/opencode/model';
import type { TurnActivityRecord } from '../lib/turns/types';
import { latestShellPreview } from './liveCommandPreviewModel';

const shell = (id: string, status: 'running' | 'completed'): TurnActivityRecord => {
    const part: ToolPart = {
        type: 'tool', id, callID: id, messageID: id, sessionID: 'session', tool: 'shell',
        state: status === 'running'
            ? { status: 'running', input: { command: `npm test ${id}` }, metadata: { output: 'running' }, time: { start: 1 } }
            : { status: 'completed', input: { command: `npm test ${id}` }, output: 'done', metadata: {}, time: { start: 1, end: 2 } },
    };
    return { id, turnId: 'turn', messageId: id, partIndex: 0, kind: 'tool', part };
};

const legacyShell = (tool: string, input: Record<string, string>, metadata: Record<string, string> = {}): TurnActivityRecord => ({
    id: `${tool}-legacy`, turnId: 'turn', messageId: `${tool}-legacy`, partIndex: 0, kind: 'tool',
    part: {
        type: 'tool', id: `${tool}-legacy`, callID: `${tool}-legacy`, messageID: `${tool}-legacy`, sessionID: 'session', tool,
        state: { status: 'completed', input, output: 'done', metadata, time: { start: 1, end: 2 } },
    },
});

describe('latestShellPreview', () => {
    test('keeps a running command available for the sibling fold', () => {
        expect(latestShellPreview([shell('run', 'running')])).toMatchObject({ key: 'run', command: 'npm test run', running: true });
    });

    test('keeps settled output available for the collapsed command row', () => {
        expect(latestShellPreview([shell('done', 'completed')])).toMatchObject({ key: 'done', output: 'done', running: false });
    });

    test('accepts legacy shell names and command field variants', () => {
        expect(latestShellPreview([legacyShell('bash', { cmd: 'npm test' })])).toMatchObject({ command: 'npm test' });
        expect(latestShellPreview([legacyShell('terminal', {}, { command: 'cargo test' })])).toMatchObject({ command: 'cargo test' });
    });
});
