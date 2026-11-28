import { opencodeClient } from "@/lib/opencode/client"
import { isSameModelRef, toModelRef, type ModelRef, type Session } from "@/lib/opencode/model"
import { isRetiredPlatformProvider } from "@/lib/platformAccount"
import { markDefiniteTransportFailure } from "@/lib/relay/transport-error"
import { isAutoModel } from "@/lib/routing/autoModel"
import { captureRuntimeInstance } from "@/lib/runtime-switch"
import { useSelectionStore } from "./selection-store"
import { getAllSyncSessionMap, getDirectoryState } from "./sync-refs"

export type SessionSelectionPolicy = { keepSessionModel?: boolean; keepSessionAgent?: boolean }

export function captureComposerSelection(sessionId: string, providerID: string, modelID: string, agent?: string | null) {
  const store = useSelectionStore.getState()
  const model = store.getSessionModelPick(sessionId)
  const agentChosen = Boolean(agent && store.getSessionAgentPick(sessionId) === agent)
  const modelChosen = model?.providerId === providerID && model.modelId === modelID
  const settleModel = store.captureSessionModelPickSettlement(sessionId, providerID, modelID)
  const settleAgent = store.captureSessionAgentPickSettlement(sessionId, agent)
  return {
    keepSessionModel: !modelChosen && !agentChosen && !isAutoModel(providerID, modelID),
    keepSessionAgent: !agentChosen,
    settleModel,
    settle: () => { settleModel(); settleAgent() },
  }
}

type SendSelection = { providerID: string; modelID: string; variant?: string | null; agent?: string } & SessionSelectionPolicy

/** Returns both the model that handles the input and the fields the request must change. */
export async function resolveSessionDelivery(sessionId: string, directory: string | undefined, desired: SendSelection) {
  const model = toModelRef({ providerID: desired.providerID, id: desired.modelID, variant: desired.variant })
  const isCurrentRuntime = captureRuntimeInstance()
  let serverSession: Session
  try {
    serverSession = await opencodeClient.getSession(sessionId, directory)
  } catch (error) {
    if (desired.agent) {
      if (error instanceof Error) markDefiniteTransportFailure(error)
      throw error
    }
    if (!isCurrentRuntime()) throw new Error("Message was not sent because the runtime changed.")
    return { effectiveModel: model, switches: { model: desired.keepSessionModel ? undefined : model, agent: undefined } }
  }
  if (!isCurrentRuntime()) throw new Error("Message was not sent because the runtime changed.")
  const inherited = desired.keepSessionModel && serverSession.model && !isRetiredPlatformProvider(serverSession.model.providerID)
    ? serverSession.model : undefined
  const matches = (record?: ModelRef) => record && isSameModelRef(record, model)
  const local = () => getDirectoryState(directory)?.session.find((candidate) => candidate.id === sessionId)
    ?? getAllSyncSessionMap().get(sessionId)
  const switchModel = !inherited && (!matches(serverSession.model) || !matches(local()?.model))
  const switchAgent = desired.agent && serverSession.agent !== desired.agent && !(desired.keepSessionAgent && serverSession.agent)
  return {
    effectiveModel: inherited ?? model,
    switches: { model: switchModel ? model : undefined, agent: switchAgent ? desired.agent : undefined },
  }
}

export async function resolveSendSelection(sessionId: string, directory: string | undefined, desired: SendSelection) {
  return (await resolveSessionDelivery(sessionId, directory, desired)).switches
}

export async function compactSession(
  sessionId: string,
  directory: string | undefined,
  desired: { providerID: string; modelID: string; variant?: string | null },
  intent?: ReturnType<typeof captureComposerSelection>,
): Promise<void> {
  const isCurrent = captureRuntimeInstance()
  if (intent && !intent.keepSessionModel && !isAutoModel(desired.providerID, desired.modelID)) {
    const { model } = await resolveSendSelection(sessionId, directory, desired)
    if (!isCurrent()) throw new Error("Compaction was cancelled because the runtime changed.")
    if (model) await opencodeClient.switchSessionModel(sessionId, model, directory)
  }
  if (!isCurrent()) throw new Error("Compaction was cancelled because the runtime changed.")
  await opencodeClient.compactSession(sessionId, directory)
  if (!isAutoModel(desired.providerID, desired.modelID)) intent?.settleModel()
}
