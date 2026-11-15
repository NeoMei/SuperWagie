import type { Part } from '@/lib/opencode/model';
import type { TurnActivityRecord } from '../lib/turns/types';

export type ReasoningPreview = {
    key: string;
    messageId: string;
    part: Extract<Part, { type: 'reasoning' }>;
};

/** Keeps every reasoning part available as a sibling of Activity. */
export const reasoningPreviews = (activities: readonly TurnActivityRecord[]): ReasoningPreview[] => {
    const previews = activities.flatMap((activity) => (
        activity.kind === 'reasoning' && activity.part.type === 'reasoning'
            ? [{ key: activity.id, messageId: activity.messageId, part: activity.part }]
            : []
    ));
    const latest = previews.at(-1);
    return latest ? [latest] : [];
};
