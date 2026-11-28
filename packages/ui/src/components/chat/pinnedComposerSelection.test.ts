import { describe, expect, test } from 'bun:test';
import { resolvePinnedComposerSelection } from './pinnedComposerSelection';

const record = {
    agent: 'build',
    model: { providerID: 'anthropic', id: 'claude', variant: 'high' },
};

describe('pinned composer selection', () => {
    test('follows the session record when nothing was picked in the composer', () => {
        expect(resolvePinnedComposerSelection({ modelPicked: false, agentPicked: false, savedAgent: null, savedModel: null, savedVariant: undefined, record })).toEqual({
            agent: 'build',
            model: { providerId: 'anthropic', modelId: 'claude' },
            variant: 'high',
        });
    });

    test('a pick saved for the session wins over the record', () => {
        expect(resolvePinnedComposerSelection({
            modelPicked: true, agentPicked: true,
            savedAgent: 'plan',
            savedModel: { providerId: 'openai', modelId: 'gpt' },
            savedVariant: 'low',
            record,
        })).toEqual({
            agent: 'plan',
            model: { providerId: 'openai', modelId: 'gpt' },
            variant: 'low',
        });
    });

    test('restored values in a pinned tab yield to a newer session model and agent', () => {
        expect(resolvePinnedComposerSelection({
            modelPicked: false, agentPicked: false, savedAgent: 'plan',
            savedModel: { providerId: 'old-provider', modelId: 'old-model' }, savedVariant: 'low', record,
        })).toEqual({ agent: 'build', model: { providerId: 'anthropic', modelId: 'claude' }, variant: 'high' });
    });

    test('an effort saved as Default stays Default instead of the record\'s', () => {
        expect(resolvePinnedComposerSelection({ modelPicked: true, agentPicked: false, savedAgent: null, savedModel: { providerId: 'anthropic', modelId: 'claude' }, savedVariant: null, record }).variant).toBeNull();
    });

    test('a session without a record or picks has no model of its own', () => {
        expect(resolvePinnedComposerSelection({ modelPicked: false, agentPicked: false, savedAgent: null, savedModel: null, savedVariant: undefined, record: undefined })).toEqual({
            agent: undefined,
            model: null,
            variant: undefined,
        });
    });
});
