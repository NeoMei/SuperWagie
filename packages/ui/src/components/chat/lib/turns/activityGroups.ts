import type { Part, ReasoningPart, ToolPart } from '@/lib/opencode/model';
import { readBackgroundShellID } from '@/lib/opencode/background-shell';
import { isSessionNoticePart } from '@/lib/opencode/session-notices';
import { isInvisibleText } from '@/lib/invisibleText';
import { isExplorationTool, isFileChangeTool, isQuestionTool, isShellTool, isShownInPlace, isSubagentTool, isWebTool, openChamberToolCall } from '@/lib/opencode/tools';
import type { ChatMessageEntry } from './types';
import { isToolRowShown } from './toolRowVisibility';

type ActivityPhase = 'explore' | 'edit' | 'run' | 'other';
export type ReasoningMode = 'group' | 'plain' | 'hidden';
type Member = { message: ChatMessageEntry; part: ToolPart | ReasoningPart };
type Run = { phase: ActivityPhase; members: Member[]; calls: number };
type ActivityGroup = { kind: 'command'; phase?: ActivityPhase; id: string; members: readonly Member[] };
export type ActivityGroups = ReadonlyMap<string, ActivityGroup>;

const plans = new WeakMap<readonly ChatMessageEntry[], Map<string, ActivityGroups>>();
const MAX_ABSORBED_LOOKUPS = 5;

// A completed empty text part draws no row; a live empty part can still become prose.
const isSealedInvisibleText = (part: Part, message: ChatMessageEntry): boolean => (
    part.type === 'text' && isInvisibleText(part.text)
    && (part.time?.end !== undefined || (message.info.role === 'assistant' && message.info.time.completed !== undefined))
);

const phaseOf = (part: ToolPart): ActivityPhase | null => {
    if (!isToolRowShown(part) || part.state.status === 'error' || isSessionNoticePart(part)
        || isSubagentTool(part.tool) || isQuestionTool(part.tool) || isShownInPlace(part.tool, part.state)
        || (isShellTool(part.tool) && readBackgroundShellID(part) !== undefined)) return null;
    if (isFileChangeTool(part.tool)) return 'edit';
    if (isShellTool(part.tool)) return 'run';
    if (isExplorationTool(part.tool) || isWebTool(part.tool)) return 'explore';
    // A live integration may be waiting for permission or an answer before
    // its result has enough metadata to render a page.
    if (part.state.status !== 'completed' || openChamberToolCall(part.tool, part.state.input)?.awaitsAnswer) return null;
    return 'other';
};

/** Fold short lookups into the following edit, otherwise into preceding work.
 * The last lookup of a live turn can still grow into its own phase. */
const absorbLookups = (runs: Run[], live: boolean): Run[] => {
    const merged: Run[] = [];
    for (const [index, run] of runs.entries()) {
        const previous = merged.at(-1);
        const next = runs[index + 1];
        if (run.phase === 'explore' && run.calls <= MAX_ABSORBED_LOOKUPS) {
            if (next?.phase === 'edit') {
                next.members = run.members.concat(next.members);
                continue;
            }
            if ((next || !live) && (previous?.phase === 'run' || previous?.phase === 'edit')) {
                for (const member of run.members) previous.members.push(member);
                continue;
            }
        }
        if (previous?.phase === run.phase) {
            for (const member of run.members) previous.members.push(member);
        } else {
            merged.push(run);
        }
    }
    return merged;
};

export const getActivityGroups = (messages: readonly ChatMessageEntry[], reasoning: ReasoningMode = 'group', live = false): ActivityGroups => {
    const key = reasoning + (live ? '-live' : '');
    const variants = plans.get(messages) ?? new Map<string, ActivityGroups>();
    const cached = variants.get(key);
    if (cached) return cached;
    const groups = new Map<string, ActivityGroup>();
    let runs: Run[] = [];
    let thoughts: Member[] = [];
    const flush = (liveTail = false) => {
        const phases = absorbLookups(runs, liveTail);
        for (const run of phases) {
            const first = run.members[0];
            const growing = liveTail && run === phases.at(-1);
            if (!first || (run.members.length < 2 && !growing)) continue;
            const group: ActivityGroup = { kind: 'command', id: first.part.id, phase: run.phase, members: run.members };
            for (const member of run.members) groups.set(member.part.id, group);
        }
        runs = [];
        thoughts = [];
    };
    for (const message of messages) {
        const messageDone = message.info.role === 'assistant' && message.info.time.completed !== undefined;
        for (const part of message.parts) {
            if (isSealedInvisibleText(part, message)) continue;
            const previous = runs.at(-1);
            if (part.type === 'reasoning') {
                const ended = !live || messageDone || part.time?.end !== undefined;
                if (reasoning === 'hidden' || (ended && isInvisibleText(part.text))) continue;
                if (reasoning === 'plain') flush();
                else (previous?.members ?? thoughts).push({ message, part });
                continue;
            }
            const phase = part.type === 'tool' ? phaseOf(part) : null;
            if (part.type !== 'tool' || !phase) {
                flush();
                continue;
            }
            if (previous && (previous.phase === phase || phase === 'other' || previous.phase === 'other')) {
                if (previous.phase === 'other') previous.phase = phase;
                previous.members.push({ message, part });
                previous.calls++;
            } else {
                thoughts.push({ message, part });
                runs.push({ phase, members: thoughts, calls: 1 });
                thoughts = [];
            }
        }
        if (message.info.role === 'assistant' && message.info.error) flush();
    }
    flush(live);
    variants.set(key, groups);
    plans.set(messages, variants);
    return groups;
};

/** Whether a part's details are drawn by an earlier member's disclosure. */
export const isActivityGroupContinuation = (part: Part, groups: ActivityGroups | null | undefined): boolean => {
    const group = groups?.get(part.id);
    return group !== undefined && group.id !== part.id;
};

/** The original message still owns its footer, errors and any ungrouped content. */
export const isActivityContinuationOnlyMessage = (message: ChatMessageEntry, groups: ActivityGroups): boolean => (
    message.parts.some((part) => isActivityGroupContinuation(part, groups))
    && message.parts.every((part) => isActivityGroupContinuation(part, groups) || isSealedInvisibleText(part, message))
    && !(message.info.role === 'assistant' && (message.info.error || message.info.finish === 'stop'))
);
