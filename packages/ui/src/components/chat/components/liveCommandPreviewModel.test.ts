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

describe('latestShellPreview', () => {
    test('keeps a running command available for the sibling fold', () => {
        expect(latestShellPreview([shell('run', 'running')])).toMatchObject({ key: 'run', command: 'npm test run', running: true });
    });

    test('keeps settled output available for the collapsed command row', () => {
        expect(latestShellPreview([shell('done', 'completed')])).toMatchObject({ key: 'done', output: 'done', running: false });
    });

    test('recovers a completed command from metadata when the input snapshot is empty', () => {
        const activity = shell('metadata', 'completed');
        if (activity.part.type !== 'tool' || activity.part.state.status !== 'completed') throw new Error('Expected completed shell');
        activity.part.state = {
            ...activity.part.state,
            input: {},
            metadata: { command: 'bun test packages/ui' },
        };
        expect(latestShellPreview([activity])).toMatchObject({ command: 'bun test packages/ui', output: 'done' });
    });

    test('recognizes legacy bash parts and cmd input', () => {
        const activity = shell('legacy', 'completed');
        if (activity.part.type !== 'tool' || activity.part.state.status !== 'completed') throw new Error('Expected completed shell');
        activity.part.tool = 'bash';
        activity.part.state = {
            ...activity.part.state,
            input: { cmd: 'npm test -- legacy' },
            metadata: {},
        };
        expect(latestShellPreview([activity])).toMatchObject({ command: 'npm test -- legacy' });
    });
});
