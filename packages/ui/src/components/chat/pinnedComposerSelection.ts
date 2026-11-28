import React from 'react';
import type { Session } from '@/lib/opencode/model';
import type { BtwSelection } from '@/stores/useBtwStore';
import { useSelectionStore } from '@/sync/selection-store';
import { isAutoModel } from '@/lib/routing/autoModel';
import { useSession } from '@/sync/sync-context';

/** The pinned chat owns its unsent picks. Its record supplies the applied selection. */
export const resolvePinnedComposerSelection = ({ savedAgent, savedModel, savedVariant, modelPicked, agentPicked, record }: {
    savedAgent: string | null;
    savedModel: { providerId: string; modelId: string } | null;
    savedVariant: string | null | undefined;
    modelPicked: boolean;
    agentPicked: boolean;
    record: Pick<Session, 'agent' | 'model'> | undefined;
}): BtwSelection => {
    const recordModel = record?.model?.providerID && record.model.id
        ? { providerId: record.model.providerID, modelId: record.model.id }
        : null;
    const useSavedModel = savedModel && (modelPicked || agentPicked || !recordModel || isAutoModel(savedModel.providerId, savedModel.modelId));
    const recordAgent = record?.agent?.trim();
    const recordVariant = record?.model?.variant?.trim() || undefined;
    return {
        agent: (agentPicked ? savedAgent : recordAgent) ?? recordAgent ?? savedAgent ?? undefined,
        model: useSavedModel ? savedModel : recordModel,
        variant: useSavedModel ? savedVariant : recordVariant ?? savedVariant,
    };
};

/**
 * The model, agent and effort a pinned column's composer (a chat open in the
 * side panel) sends with. The app-wide current model belongs to the main
 * chat, so a pinned composer keeps its own: what was picked in it, saved for
 * its session the way the `/btw` composer saves its picks, and otherwise what
 * the session record names. Null outside a pinned column.
 */
export const usePinnedComposerSelection = ({ enabled, sessionId, directory }: {
    enabled: boolean;
    sessionId: string | null;
    directory: string | null;
}): BtwSelection | null => {
    const key = enabled ? sessionId : null;
    const record = useSession(key ?? undefined, directory ?? undefined);
    const savedAgent = useSelectionStore((state) => (key ? state.sessionAgentSelections.get(key) ?? null : null));
    const savedModel = useSelectionStore((state) => (key ? state.sessionModelSelections.get(key) ?? null : null));
    const modelPick = useSelectionStore((state) => key ? state.getSessionModelPick(key) : null);
    const agentPick = useSelectionStore((state) => key ? state.getSessionAgentPick(key) : undefined);
    const choices = { savedAgent, savedModel: modelPick ?? savedModel, modelPicked: Boolean(modelPick), agentPicked: Boolean(agentPick), record };
    const base = resolvePinnedComposerSelection({ ...choices, savedVariant: undefined });
    const savedVariant = useSelectionStore((state) => (key && base.agent && base.model
        ? state.getAgentModelVariantForSession(key, base.agent, base.model.providerId, base.model.modelId)
        : undefined));
    const { agent, model, variant } = resolvePinnedComposerSelection({ ...choices, savedVariant });
    const providerId = model?.providerId;
    const modelId = model?.modelId;
    return React.useMemo(() => {
        if (!key) return null;
        return {
            agent,
            model: providerId && modelId ? { providerId, modelId } : null,
            variant,
        };
    }, [agent, key, modelId, providerId, variant]);
};
