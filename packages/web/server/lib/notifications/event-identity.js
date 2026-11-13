import crypto from 'node:crypto';
import { z } from 'zod';

const requestIdSchema = z.string().min(1);

/** Identifies one pending event without putting project paths in push metadata. */
export const notificationEventTag = (kind, { sessionId, requestId, directory, spaceId }) => {
  const id = requestIdSchema.safeParse(requestId);
  if (!id.success) return null;
  return `${kind}-${crypto.createHash('sha256').update(JSON.stringify([spaceId ?? null, directory ?? null, sessionId, id.data])).digest('hex').slice(0, 48)}`;
};
