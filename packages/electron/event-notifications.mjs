import { z } from 'zod';

/** macOS can remove delivered notifications by id. Other platforms cannot promise retraction. */
export const createEventNotificationRegistry = ({ platform, remove }) => {
  const removal = z.function().safeParse(remove);
  const delivered = new Map();
  const key = ({ tag, runtimeKey }) => JSON.stringify([runtimeKey || 'local', tag]);
  return {
    track(payload, id) {
      if (!payload.tag) return;
      const owner = key(payload);
      const ids = delivered.get(owner) ?? [];
      ids.push(id);
      delivered.set(owner, ids);
    },
    withdraw(payload) {
      if (platform !== 'darwin' || !removal.success) return { status: 'unsupported' };
      const owner = key(payload);
      const ids = delivered.get(owner);
      if (!ids?.length) return { status: 'unknown' };
      try { removal.data(ids); delivered.delete(owner); return { status: 'withdrawn', count: ids.length }; }
      catch { return { status: 'unknown' }; }
    },
  };
};
