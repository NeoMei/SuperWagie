import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { setSessionWorkState } from './session-actions';

/** A batch is independent single-session writes. Successful rows need no retry. */
export async function markSessionsWorkDone(ids: readonly string[]): Promise<{ doneIds: string[]; failedIds: string[] }> {
  const ownerCurrent = captureRuntimeInstance();
  const doneIds: string[] = [];
  const failedIds: string[] = [];
  for (const id of new Set(ids)) {
    const session = useGlobalSessionsStore.getState().entityById.get(id);
    if (!ownerCurrent() || !session || session.parentID || session.time.archived !== undefined) {
      failedIds.push(id);
      continue;
    }
    if (!isSessionInWork(session)) {
      doneIds.push(id);
      continue;
    }
    try {
      const saved = await setSessionWorkState(id, session.directory, 'done');
      if (saved) doneIds.push(id);
      else failedIds.push(id);
    } catch {
      failedIds.push(id);
    }
  }
  return { doneIds, failedIds };
}
