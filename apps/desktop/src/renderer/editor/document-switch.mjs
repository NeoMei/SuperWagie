export async function persistPendingBeforeSwitch({ hasPendingChanges, persistPending, loadTarget }) {
  if (hasPendingChanges()) {
    const saveResult = await persistPending();
    if (!saveResult?.ok) return { opened: false, saveResult };
  }
  return { opened: true, loaded: await loadTarget() };
}

export function createDocumentSwitchCoordinator({
  hasPendingChanges,
  persistPending,
  getChangeGeneration,
  loadTarget,
  applyTarget,
}) {
  let latestRequest = 0;
  return async (target) => {
    const request = ++latestRequest;
    while (request === latestRequest) {
      if (hasPendingChanges()) {
        const saveResult = await persistPending();
        if (!saveResult?.ok || request !== latestRequest) return false;
      }
      const generationBeforeLoad = getChangeGeneration();
      const loaded = await loadTarget(target);
      if (request !== latestRequest) return false;
      if (getChangeGeneration() !== generationBeforeLoad || hasPendingChanges()) continue;
      await applyTarget(target, loaded);
      return request === latestRequest;
    }
    return false;
  };
}

export function createDraftSaveQueue({ captureDraft, persistDraft, onPersisted, onConflict }) {
  let changeGeneration = 0;
  let savedGeneration = 0;
  let inFlight = null;
  const isDirty = () => changeGeneration !== savedGeneration;
  const markChanged = () => { changeGeneration += 1; };
  const markClean = () => { savedGeneration = changeGeneration; };
  const save = async () => {
    let lastResult = null;
    while (isDirty()) {
      if (!inFlight) {
        const generation = changeGeneration;
        const draft = captureDraft();
        inFlight = (async () => {
          const result = await persistDraft(draft, generation);
          if (!result?.ok) {
            await onConflict?.(result);
            return result;
          }
          savedGeneration = generation;
          await onPersisted?.({ draft, result, current: !isDirty() });
          return result;
        })();
      }
      const operation = inFlight;
      try {
        lastResult = await operation;
      } finally {
        if (inFlight === operation) inFlight = null;
      }
      if (!lastResult?.ok) return lastResult;
    }
    return lastResult ?? { ok: true, unchanged: true };
  };
  return Object.freeze({
    generation: () => changeGeneration,
    isDirty,
    markChanged,
    markClean,
    save,
  });
}
