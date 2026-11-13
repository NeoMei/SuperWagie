import { createContext } from 'react';

import type { ToolPart } from '@/lib/opencode/model';
import type { RevealedTextRecord, RevealedTextTurnIdentity } from '../lib/turns/revealedText';

/** The live turn whose outside-fold prose may be recorded for this runtime. */
export interface RevealedTextTurnScope extends RevealedTextTurnIdentity {
    readonly messageOrderById: ReadonlyMap<string, number>;
    readonly outsideFold: boolean;
}

export interface RevealedTextPartScope {
    readonly partIndex: number;
    readonly messageCreatedAt?: number;
    readonly pinnedCopy?: boolean;
}

/** A pinned message keeps one ChatMessage root and folds only its unrevealed work. */
export interface LivePinnedMessagePresentation {
    readonly messageId: string;
    readonly contentId?: string;
    readonly expanded: boolean;
    readonly animate: boolean;
    /** Interactive calls owned by this message, kept above execution. */
    readonly interactions: readonly ToolPart[];
    readonly records: readonly RevealedTextRecord[];
    /** The current foreground text is still being shown; record it once it reaches the reader. */
    readonly foreground: boolean;
    /** The current foreground text records what it shows without a second message root. */
    readonly revealTurnScope: RevealedTextTurnScope | null;
}

export const RevealedTextTurnContext = createContext<RevealedTextTurnScope | null>(null);
export const RevealedTextPartContext = createContext<RevealedTextPartScope | null>(null);
export const LivePinnedMessageContext = createContext<LivePinnedMessagePresentation | null>(null);
